import { createRuntimeBinding, type RuntimeBinding } from "../runtime/runtimeBinding.js";
import { normalizeRuntimeOwner, type RuntimeOwner } from "../runtime/runtimeOwner.js";
import { RuntimeHostContentionError, type SessionHostPort, type SessionInspection,
  type RuntimeLaunchPreStart } from "../runtime/ports.js";
import type { NewSessionLaunchRequest, ResumeSessionLaunchRequest } from "../runtime/sessionLaunchRequest.js";
import type { NonBlockingChecks } from "../runtime/lifecycleChecks.js";

// Controller custody of a Host, NOT the Host's native Session/Turn state.
export type ControllerHostState = "unavailable" | "stopped" | "starting" | "running" | "stopping";
type Event = "launch" | "launched" | "stop" | "exit-sent" | "stopped" | "failed" | "observed";
export type ControllerHostTransition = Readonly<{
  owner: RuntimeOwner; from: ControllerHostState; to: ControllerHostState;
  event: Event; revision: number; operationId?: number; nativeSessionId?: string; bindingId?: string;
}>;
type Rule = Readonly<{
  from: readonly ControllerHostState[];
  to: ControllerHostState | ((current: ControllerHostState, observed?: SessionInspection) => ControllerHostState);
}>;
const states: readonly ControllerHostState[] = ["unavailable", "stopped", "starting", "running", "stopping"];
export const CONTROLLER_HOST_TRANSITIONS: Readonly<Record<Event, Rule>> = {
  launch: { from: ["unavailable", "stopped", "running"], to: "starting" },
  launched: { from: ["starting"], to: "running" },
  stop: { from: states, to: "stopping" },
  "exit-sent": { from: ["stopping"], to: "stopping" },
  stopped: { from: ["stopping"], to: "stopped" },
  failed: { from: ["starting", "stopping"], to: "unavailable" },
  observed: { from: states, to: (current, observed) =>
    current === "stopping" && (observed!.state === "running" || observed!.state === "starting")
      ? "stopping" : observed!.state }
};
type Entry = {
  owner: RuntimeOwner; state: ControllerHostState; revision: number;
  operationId?: number; nativeSessionId?: string; bindingId?: string;
};

/** All physical effects still require their existing durable caller authority.
 * This process-local FSM gates competing effects at the shared Host port.
 * Recovery observes current custody; it never invents a launch or replays one.
 * Observation revisions reject late reads, not external process identities:
 * exact OS/native identities remain owned by SessionOwner/Host fences. */
export function createControllerHostLifecycle(raw: SessionHostPort, hooks: {
  before?: NonBlockingChecks<ControllerHostTransition>;
  after?: NonBlockingChecks<ControllerHostTransition>;
  stopOwner?: SessionHostPort["stopOwner"];
} = {}) {
  const entries = new Map<string, Entry>();
  let nextOperation = 0;
  const entryFor = (input: RuntimeOwner) => {
    const owner = normalizeRuntimeOwner(input);
    const key = JSON.stringify(owner);
    let entry = entries.get(key);
    if (!entry) {
      entry = { owner: Object.freeze(owner), state: "unavailable", revision: 0 };
      entries.set(key, entry);
    }
    return entry;
  };
  const send = (entry: Entry, event: Event, observed?: SessionInspection, binding?: RuntimeBinding) => {
    const rule = CONTROLLER_HOST_TRANSITIONS[event];
    if (!rule.from.includes(entry.state)) throw new RuntimeHostContentionError(
      "previous-process", `Host lifecycle cannot ${event} from ${entry.state}.`);
    const to = typeof rule.to === "function" ? rule.to(entry.state, observed) : rule.to;
    const nativeSessionId = to === "stopped" ? undefined
      : binding?.nativeSessionId ?? observed?.nativeSessionId ?? entry.nativeSessionId;
    const bindingId = to === "stopped" ? undefined
      : observed?.nativeSessionId && observed.nativeSessionId !== entry.nativeSessionId
        ? undefined : binding?.id ?? entry.bindingId;
    if (event === "observed" && to === entry.state && nativeSessionId === entry.nativeSessionId) return;
    const transition = Object.freeze({ owner: entry.owner, from: entry.state, to, event,
      revision: entry.revision + 1, operationId: entry.operationId, nativeSessionId, bindingId });
    hooks.before?.notify(transition);
    entry.state = to;
    entry.revision = transition.revision;
    entry.nativeSessionId = nativeSessionId;
    entry.bindingId = bindingId;
    hooks.after?.notify(transition);
  };
  const observe = (entry: Entry, revision: number, inspection: SessionInspection) => {
    if (entry.revision === revision && entry.operationId === undefined) send(entry, "observed", inspection);
    return inspection;
  };
  const effect = async <T>(owner: RuntimeOwner, event: "launch" | "stop", run: (entry: Entry) => Promise<T>) => {
    const entry = entryFor(owner);
    if (entry.operationId !== undefined) throw new RuntimeHostContentionError(
      "previous-process", `Host lifecycle already has an in-flight operation for ${owner.roleName}.`);
    // Check state before reserving the operation; a rejected edge owns nothing.
    if (!CONTROLLER_HOST_TRANSITIONS[event].from.includes(entry.state)) throw new RuntimeHostContentionError(
      "previous-process", `Host lifecycle cannot ${event} from ${entry.state}.`);
    entry.operationId = ++nextOperation;
    send(entry, event);
    try { return await run(entry); }
    catch (error) { send(entry, "failed"); throw error; }
    finally { entry.operationId = undefined; }
  };
  const inspectOwner: SessionHostPort["inspectOwner"] = async owner => {
    const entry = entryFor(owner), revision = entry.revision;
    return observe(entry, revision, await raw.inspectOwner(owner));
  };
  const launch = async (request: NewSessionLaunchRequest | ResumeSessionLaunchRequest, before?: RuntimeLaunchPreStart) => {
    await inspectOwner(request.owner);
    return effect(request.owner, "launch", async entry => {
      const binding = createRuntimeBinding(request.mode === "new"
        ? await raw.start(request, before) : await raw.restore(request, before));
      if (JSON.stringify(normalizeRuntimeOwner(binding.owner)) !== JSON.stringify(entry.owner)
        || binding.agentId !== request.agentId || binding.adapterId !== request.adapterId
        || request.mode === "resume" && binding.nativeSessionId !== request.nativeSessionId) {
        throw new Error("Host lifecycle launch handshake has mismatched owner/native identity.");
      }
      send(entry, "launched", undefined, binding);
      return binding;
    });
  };
  const port: SessionHostPort = {
    start: launch, restore: launch, inspectOwner,
    inspect: async binding => {
      const entry = entryFor(binding.owner), revision = entry.revision;
      const inspection = await raw.inspect(binding);
      if (entry.bindingId && entry.bindingId !== binding.id
        || entry.nativeSessionId && binding.nativeSessionId !== entry.nativeSessionId) return inspection;
      return observe(entry, revision, inspection);
    },
    ...(raw.inspectOwners === undefined ? {} : {
      inspectOwners: async (owners: readonly RuntimeOwner[]) => {
        const revisions = new Map(owners.map(owner => {
          const entry = entryFor(owner);
          return [entry, entry.revision] as const;
        }));
        const results = await raw.inspectOwners!(owners);
        for (const { owner, inspection } of results) {
          const entry = entryFor(owner), revision = revisions.get(entry);
          if (revision !== undefined) observe(entry, revision, inspection);
        }
        return results;
      }
    }),
    stop: async binding => {
      const current = entryFor(binding.owner);
      if (current.nativeSessionId && binding.nativeSessionId !== current.nativeSessionId
        || current.bindingId && binding.id !== current.bindingId) {
        throw new Error("Host lifecycle stop carries a stale binding identity.");
      }
      return effect(binding.owner, "stop", async entry => {
        await raw.stop(binding);
        const observed = await raw.inspect(binding);
        if (observed.state !== "stopped") throw new Error("Host lifecycle stop has no physical exit proof.");
        send(entry, "stopped");
      });
    },
    stopOwner: owner => effect(owner, "stop", async entry => {
      const stopped = await (hooks.stopOwner ? hooks.stopOwner(owner) : raw.stopOwner(owner));
      send(entry, stopped ? "stopped" : "failed");
      return stopped;
    })
  };
  return {
    port,
    snapshot: (owner: RuntimeOwner) => Object.freeze({ ...entryFor(owner) }),
    // Graceful exit acknowledgement is not exit proof. A later physical
    // observation moves stopping -> stopped; no timer or automatic replay.
    requestExit: <T>(owner: RuntimeOwner, run: () => Promise<T>) => effect(owner, "stop", async entry => {
      const result = await run();
      send(entry, "exit-sent");
      return result;
    })
  };
}
