import { InstanceHost, type ImplementationHandle, type ImplementationRef } from "../kernel/instanceHost.js";
import {
  builtinAgentEndpointImplementation,
  requireBuiltinAgentEndpointImplementation
} from "./agentEndpointIdentity.js";
import {
  createAgentEndpointFactory,
  type AgentEndpoint,
  type AgentEndpointFactory,
  type OpenedAgentEndpoint
} from "./agentEndpoint.js";
import type { AgentHostLaunchPayload } from "./launchBroker.js";

/**
 * Which references still hold the implementation, as observed facts. A stop
 * request is not physical quiescence: `quiescent: false` reports what is still
 * running so the owner can wait, cancel or accept it explicitly. Nothing here
 * escalates to killing a Provider the Endpoint does not own.
 */
export type AgentEndpointDrain = Readonly<{
  quiescent: boolean;
  references: number;
  /**
   * Handshakes still in flight. An opening client has no Session identity to
   * report yet, so it cannot appear under `sessions`; counting it here keeps a
   * stop that lands mid-open from looking like an empty, quiescent Host.
   */
  opening: number;
  /** How long this stop actually waited, and whether the bound ran out first. */
  waitedMs: number;
  timedOut: boolean;
  sessions: readonly Readonly<{
    nativeSessionId: string;
    processInstanceId: string;
    attachment: "attached" | "detach-requested" | "exited";
    cancellation: "not-requested" | "requested";
    /** An owned client exiting does not prove shared/native descendants stopped. */
    resources: "unknown";
    /** Set once the Session asked to end but its client has not proven exit. */
    releaseAwaitingExit: boolean;
    pending: readonly Readonly<{ attemptId: string; inputRef: string; status: string }>[];
  }>[];
}>;

/**
 * A Session's hold on one Endpoint code generation. Held across the Session's
 * Turns, not per call: a later Turn in the same Session keeps this exact
 * implementation even after a newer one is installed. Released when the Session
 * really ends, which is what lets the old generation finally dispose.
 */
export type AgentEndpointLease = Readonly<{
  implementation: ImplementationRef;
  open(payload: AgentHostLaunchPayload): Promise<OpenedAgentEndpoint>;
  resume(payload: AgentHostLaunchPayload): Promise<OpenedAgentEndpoint>;
  release(): Promise<void>;
}>;

/**
 * One Session's hold. The reference is owned by the client that is actually
 * running, not by the intent to stop it: `releaseRequested` records that the
 * Session asked to end, and the reference is only handed back once the client
 * proves it exited. That is what keeps a stop from reporting quiescence while a
 * Provider is still attached.
 *
 * A handshake counts the same way. While `opening` is above zero this Session is
 * really holding the implementation even though no client exists yet, because a
 * stop that arrives mid-open cannot know whether the client is about to attach.
 * The hold is decided when the handshake settles: a success enters the same
 * exit-driven tracking, a failure owes nothing and releases.
 */
type SessionHold = {
  handle: ImplementationHandle<AgentEndpointFactory>;
  current?: AgentEndpoint;
  opening: number;
  releaseRequested: boolean;
  settled: boolean;
};

/**
 * Process-local ownership of the Endpoint implementation this Agent Host is
 * executing. Reuses the one Instance Host primitive; it is not a second
 * registry, a capability directory or a durable reference table. The Controller
 * owns its own Host in its own process and never holds an Endpoint client, so
 * the reference facts for a Session live where the Session actually runs.
 *
 * Only the running code can be attached here. This owner proves the loaded
 * generation is held and released; historical launch generations do not select
 * old code or block a compatible native resume.
 */
export function createAgentEndpointOwner(
  factory: AgentEndpointFactory = createAgentEndpointFactory()
) {
  const host = new InstanceHost();
  const attached = new Map<string, ImplementationRef>();
  const live = new Map<string, Set<SessionHold>>();

  const implementationFor = (adapterId: string): ImplementationRef => {
    const current = builtinAgentEndpointImplementation(adapterId);
    const existing = attached.get(current.id);
    if (existing !== undefined) return existing;
    // The disposer owns the opener, not the clients: a Session's client is
    // terminated by that Session's detach. Dropping the opener stops a leaked
    // reference from starting new work on a generation that is already gone.
    const ref = host.attach<AgentEndpointFactory>(current, factory, [
      () => { live.delete(current.id); }
    ]);
    attached.set(current.id, ref);
    live.set(current.id, new Set());
    return ref;
  };

  /**
   * Hand the reference back only when the Session asked to end *and* it has no
   * client running *and* no handshake in flight. A client that never proves exit
   * keeps this hold, so the drain below reports a real dependency instead of an
   * empty list; so does an opener that has not answered yet, whose client may
   * still be about to attach.
   */
  const settle = async (holders: Set<SessionHold>, holder: SessionHold): Promise<void> => {
    if (holder.settled || !holder.releaseRequested) return;
    if (holder.current !== undefined || holder.opening > 0) return;
    holder.settled = true;
    holders.delete(holder);
    await holder.handle.release();
  };

  /**
   * Hold the current implementation for one Session. A historical reference
   * must name the same built-in adapter, not the same package build.
   */
  const pin = (adapterId: string, pinned?: ImplementationRef): AgentEndpointLease => {
    if (pinned !== undefined) requireBuiltinAgentEndpointImplementation(adapterId, pinned);
    const ref = implementationFor(adapterId);
    const handle = host.acquire<AgentEndpointFactory>(ref);
    const holders = live.get(ref.id)!;
    // One entry per Session hold, reporting the client it currently has. A
    // Session may reattach a replacement client for the same conversation; that
    // succession is one hold, not two, so a drain never double-counts it.
    const holder: SessionHold = { handle, opening: 0, releaseRequested: false, settled: false };
    holders.add(holder);
    const track = async (opened: Promise<OpenedAgentEndpoint>): Promise<OpenedAgentEndpoint> => {
      // Counted before the handshake is awaited, so a stop that lands while the
      // client is still coming up sees this Session as a real holder.
      holder.opening += 1;
      let result: OpenedAgentEndpoint;
      try {
        result = await opened;
      } catch (error) {
        // A handshake that failed owes nothing: no client attached, so the hold
        // ends on the real dependency rather than waiting for an exit that can
        // never come.
        holder.opening -= 1;
        void settle(holders, holder).catch(() => undefined);
        throw error;
      }
      holder.current = result.session;
      holder.opening -= 1;
      // Only a resolved exit proves the client stopped. An exit that never
      // settles, or that fails, leaves this hold in place on purpose: the drain
      // must be able to say what is still running.
      void result.session.waitForExit().then(
        () => {
          if (holder.current !== result.session) return;
          holder.current = undefined;
          void settle(holders, holder).catch(() => undefined);
        },
        () => {}
      );
      // A stop may already have been requested while this handshake was in
      // flight. The client is real and attached, so it enters the same controlled
      // exit tracking instead of being handed back as an untracked leak: ask it to
      // exit and let its proven exit release the hold.
      if (holder.releaseRequested) result.session.detach();
      return result;
    };
    const start = (
      call: (value: AgentEndpointFactory) => Promise<OpenedAgentEndpoint>
    ): Promise<OpenedAgentEndpoint> => {
      // An acquired handle keeps its captured opener even after the generation is
      // disposed, so a released lease must refuse to start new work rather than
      // run on code the Session has already given up.
      if (holder.releaseRequested) {
        return Promise.reject(new Error("Session Endpoint lease is released; it cannot start new work."));
      }
      return track(call(handle.value));
    };
    return Object.freeze({
      implementation: handle.implementation,
      open: (payload) => start((value) => value.open(payload)),
      resume: (payload) => start((value) => value.resume(payload)),
      release: async () => {
        // Idempotent, and never blocking: a client that has not exited keeps the
        // reference, and `stop` is what bounds and reports that wait. A hold that
        // never opened a client (a failed start) owes nothing and settles here.
        holder.releaseRequested = true;
        await settle(holders, holder);
      }
    });
  };

  /** Actual reference and request records, never a status label. */
  const inspectImplementation = (
    implementationId: string,
    waited: Readonly<{ waitedMs: number; timedOut: boolean }>
  ): AgentEndpointDrain => {
    const instances = host.inspect(implementationId);
    const references = instances.reduce((total, instance) => total + instance.references, 0);
    const holders = [...live.get(implementationId) ?? []];
    const opening = holders.reduce((total, holder) => total + holder.opening, 0);
    const sessions = holders.flatMap((holder) => {
      const endpoint = holder.current;
      // A hold between clients has nothing attached to report. Its hold is
      // still counted in `references`, so it cannot be mistaken for quiescence.
      if (endpoint === undefined) return [];
      const state = endpoint.inspect();
      return [Object.freeze({
        nativeSessionId: endpoint.nativeSessionId,
        processInstanceId: endpoint.processInstanceId,
        attachment: state.attachment,
        cancellation: state.cancellation,
        resources: state.resources,
        releaseAwaitingExit: holder.releaseRequested,
        pending: Object.freeze(state.submissions
          .filter((submission) => submission.disposition.status === "pending"
            || submission.disposition.status === "unknown")
          .map((submission) => Object.freeze({
            attemptId: submission.attemptId,
            inputRef: submission.inputRef,
            status: submission.disposition.status
          })))
      })];
    });
    return Object.freeze({
      // Quiescent means nothing holds the implementation, no handshake is still
      // in flight, and no owned client is still attached. Holds are dropped by
      // proven exit, so an unreleased Session, an opening client or a client that
      // never exited keeps this false.
      quiescent: references === 0
        && opening === 0
        && sessions.every((session) => session.attachment === "exited" && session.pending.length === 0),
      references,
      opening,
      waitedMs: waited.waitedMs,
      timedOut: waited.timedOut,
      sessions: Object.freeze(sessions)
    });
  };

  const inspectWith = (
    adapterId: string,
    waited: Readonly<{ waitedMs: number; timedOut: boolean }>
  ): AgentEndpointDrain =>
    inspectImplementation(builtinAgentEndpointImplementation(adapterId).id, waited);

  const inspect = (adapterId: string): AgentEndpointDrain =>
    inspectWith(adapterId, { waitedMs: 0, timedOut: false });

  /**
   * Wait a bounded time for one already-detached drain, and report whether the
   * bound ran out. The timer keeps the process alive for the window, or a caller
   * with nothing else pending would exit before reporting what is still in use,
   * and is cleared as soon as the drain settles so a released implementation
   * never delays shutdown until the deadline.
   */
  const awaitDrained = async (
    drained: Promise<boolean>,
    timeoutMs: number
  ): Promise<Readonly<{ waitedMs: number; timedOut: boolean }>> => {
    const startedAt = Date.now();
    let timedOut = false;
    if (timeoutMs > 0) {
      let expire: NodeJS.Timeout | undefined;
      try {
        timedOut = !await Promise.race([
          drained,
          new Promise<boolean>((resolve) => { expire = setTimeout(() => resolve(false), timeoutMs); })
        ]);
      } finally {
        if (expire !== undefined) clearTimeout(expire);
      }
    } else {
      await Promise.resolve();
    }
    return Object.freeze({ waitedMs: Date.now() - startedAt, timedOut });
  };

  /**
   * Ordinary stop: no new independent acquisition, while an already-acquired
   * Session ends bounded. Resolves with the drain facts once every reference is
   * released, or with what is still in use when the wait runs out.
   */
  const stop = async (adapterId: string, timeoutMs = 0): Promise<AgentEndpointDrain> => {
    const ref = attached.get(builtinAgentEndpointImplementation(adapterId).id);
    if (ref === undefined) {
      return Object.freeze({
        quiescent: true, references: 0, opening: 0, waitedMs: 0, timedOut: false, sessions: []
      });
    }
    // A disposer failure still ends acquisition; the drain facts below, not the
    // settle reason, decide whether this is actually quiescent.
    const drained = host.detach(ref).then(() => true, () => true);
    return inspectWith(adapterId, await awaitDrained(drained, timeoutMs));
  };

  /**
   * Final cleanup, bounded by construction. Every attached implementation is
   * detached so nothing can acquire again, and the wait for their drains shares
   * one deadline. `InstanceHost.close()` resolves only after every reference is
   * handed back, which a client that never proves exit will never do; awaiting it
   * here would block the Host's own shutdown after a bounded `stop` already
   * reported that dependency, leaving the control socket unclosed.
   *
   * So this returns on the deadline and says what is still held, rather than
   * releasing a reference it cannot prove or killing a client it does not own.
   * The still-live implementations stay detached and undisposed on purpose: their
   * facts remain readable, and the caller decides what to do about them.
   */
  const close = async (timeoutMs = 0): Promise<readonly AgentEndpointDrain[]> => {
    const drains = [...attached.values()].map((ref) => Object.freeze({
      implementationId: ref.id,
      // Detaching cannot throw here: these refs are exactly what was attached,
      // and detach is idempotent for an already-detached instance.
      drained: host.detach(ref).then(() => true, () => true)
    }));
    const waited = await awaitDrained(
      Promise.all(drains.map((entry) => entry.drained)).then(() => true, () => true),
      timeoutMs
    );
    return Object.freeze(drains.map((entry) => inspectImplementation(entry.implementationId, waited)));
  };

  return Object.freeze({ pin, stop, inspect, close });
}
