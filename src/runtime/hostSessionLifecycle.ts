import type { NonBlockingChecks } from "./lifecycleChecks.js";

export type HostSessionLifecycleState =
  | "idle" | "starting" | "ready" | "busy" | "settling" | "delivery-unknown"
  | "rejected" | "failed" | "exited";
type Identity = Readonly<{
  processInstanceId?: string;
  nativeSessionId?: string;
  attemptId?: string;
  nativeTurnId?: string;
}>;
type Occupancy = "idle" | "busy" | "owned" | "unknown";
export type HostSessionLifecycleEvent = Identity & (
  | Readonly<{ type: "launch" | "submit" | "accepted" | "native-started" | "terminal"
      | "interactive-connected" | "disconnected" | "authority-changed" | "exit" }>
  | Readonly<{ type: "connected"; occupancy: Occupancy }>
  | Readonly<{ type: "settled"; occupancy: "idle" | "busy" }>
  | Readonly<{ type: "failure"; outcome: "busy" | "delivery-unknown" | "rejected" | "failed" }>
);
export type HostSessionLifecycleTransition = Readonly<{
  from: HostSessionLifecycleState;
  to: HostSessionLifecycleState;
  revision: number;
  event: HostSessionLifecycleEvent;
}>;
type Rule = Readonly<{
  from: readonly HostSessionLifecycleState[];
  guard?: (event: HostSessionLifecycleEvent) => boolean;
  to: HostSessionLifecycleState;
}>;
const live: readonly HostSessionLifecycleState[] = [
  "idle", "starting", "ready", "busy", "settling", "delivery-unknown", "rejected", "failed"
];
const available: readonly HostSessionLifecycleState[] = ["idle", "busy", "rejected", "failed"];
const occupancy = (value: Occupancy) => (event: HostSessionLifecycleEvent) =>
  "occupancy" in event && event.occupancy === value;

/** Lifecycle only: no version checks, upgrade phases, I/O or business policy.
 * Each event selects one guarded edge; callers cannot assign a target state.
 * Existing authority/admission checks must succeed before sending commands. */
export const HOST_SESSION_LIFECYCLE_TRANSITIONS: Readonly<Record<HostSessionLifecycleEvent["type"], readonly Rule[]>> = {
  launch: [{ from: [...available, "exited"], to: "starting" }],
  submit: [{ from: available, to: "starting" }],
  connected: [
    { from: live, guard: occupancy("owned"), to: "ready" },
    { from: live, guard: occupancy("unknown"), to: "delivery-unknown" },
    { from: live, guard: occupancy("busy"), to: "busy" },
    { from: live, guard: occupancy("idle"), to: "idle" }
  ],
  accepted: [{ from: ["starting", "ready", "delivery-unknown"], to: "ready" }],
  "interactive-connected": [{ from: ["starting", "ready"], to: "ready" }],
  "native-started": [{ from: live, to: "busy" }],
  terminal: [{ from: ["starting", "ready", "busy", "delivery-unknown", "settling", "failed"], to: "settling" }],
  settled: [
    { from: live, guard: occupancy("idle"), to: "idle" },
    { from: live, guard: occupancy("busy"), to: "busy" }
  ],
  disconnected: [{ from: live, to: "starting" }],
  "authority-changed": [{ from: available, to: "idle" }],
  failure: (["busy", "delivery-unknown", "rejected", "failed"] as const).map(outcome => ({
    from: live, guard: event => event.type === "failure" && event.outcome === outcome, to: outcome
  })),
  exit: [{ from: live, to: "exited" }]
};

export function createHostSessionLifecycle(hooks: {
  before?: NonBlockingChecks<HostSessionLifecycleTransition>;
  after?: NonBlockingChecks<HostSessionLifecycleTransition>;
} = {}) {
  let state: HostSessionLifecycleState = "idle";
  let revision = 0;
  let identity: Identity = {};
  const edgeFor = (event: HostSessionLifecycleEvent) => HOST_SESSION_LIFECYCLE_TRANSITIONS[event.type].find(rule =>
    rule.from.includes(state) && (!rule.guard || rule.guard(event)));
  return {
    get state() { return state; },
    get revision() { return revision; },
    /** State eligibility only; caller still owns exact writer/resource guards. */
    can(event: HostSessionLifecycleEvent) { return edgeFor(event) !== undefined; },
    send(input: HostSessionLifecycleEvent): Readonly<{
      status: "applied" | "ignored" | "invalid"; state: HostSessionLifecycleState; reason?: string;
    }> {
      const event = Object.freeze({ ...input });
      if (state === "exited" && event.type !== "launch") return { status: "ignored", state, reason: "exited" };
      if (!["launch", "connected"].includes(event.type)) {
        for (const key of ["processInstanceId", "nativeSessionId"] as const) {
          if (identity[key] && event[key] && identity[key] !== event[key]) {
            return { status: "ignored", state, reason: `stale-${key}` };
          }
        }
        if (["accepted", "terminal"].includes(event.type)
          && identity.attemptId && event.attemptId && identity.attemptId !== event.attemptId) {
          return { status: "ignored", state, reason: "stale-attempt" };
        }
        if (event.type === "terminal" && identity.nativeTurnId && event.nativeTurnId
          && identity.nativeTurnId !== event.nativeTurnId) {
          return { status: "ignored", state, reason: "stale-turn" };
        }
      }
      const edge = edgeFor(event);
      if (!edge) return { status: "invalid", state, reason: `No ${event.type} edge from ${state}` };
      const transition = Object.freeze({ from: state, to: edge.to, revision: revision + 1, event });
      hooks.before?.notify(transition);
      state = edge.to;
      revision += 1;
      // A new authorized attachment must not inherit the departed proxy's
      // identity fence. A launch reusing a live connection supplies its IDs.
      if (event.type === "launch") identity = {};
      identity = {
        processInstanceId: event.processInstanceId ?? identity.processInstanceId,
        nativeSessionId: event.nativeSessionId ?? identity.nativeSessionId,
        attemptId: event.attemptId,
        nativeTurnId: event.nativeTurnId
      };
      hooks.after?.notify(transition);
      return { status: "applied", state };
    }
  };
}
