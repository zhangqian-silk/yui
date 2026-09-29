/**
 * Atomic Controller handover orchestration (Issue 02).
 *
 * The activator (`yui release activate`) drives one versioned handover:
 *
 *   preflight (read-only) -> handover lock -> fence the old Controller
 *   -> start the candidate -> read back its identity -> switch the active
 *   release pointer -> commit the old Controller -> wait for promotion
 *   -> handover receipt.
 *
 * Every phase is recoverable from the durable fence + pointer state. A failed
 * candidate rolls back to the old Controller; a stuck old Controller leaves
 * the candidate read-only and reports dual-owner; a crashed activator resumes
 * from the recorded phase.
 */

import type { JsonValue } from "../core/protocol.js";
import { processGenerationIsLive } from "../core/fileLockOwner.js";
import { RELEASE_HANDOVER_PROMOTION_TIMEOUT_MS } from "../runtime/runtimeDeadlines.js";
import {
  acquireHandoverLock,
  isOwnerLive,
  newHandoverId,
  readActiveReleasePointer,
  readCandidateDiscovery,
  readHandoverFence,
  readHandoverReceipt,
  readRuntimeIdentity,
  removeActiveReleasePointer,
  removeCandidateDiscovery,
  removeHandoverFence,
  writeActiveReleasePointer,
  writeHandoverFence,
  writeHandoverReceipt,
  type ActiveReleasePointer,
  type HandoverFence,
  type HandoverOwner,
  type RuntimeReleaseManifest
} from "./runtimeRelease.js";

export const DEFAULT_CANDIDATE_READY_TIMEOUT_MS = 30_000;
export const DEFAULT_PROMOTION_TIMEOUT_MS = RELEASE_HANDOVER_PROMOTION_TIMEOUT_MS;
export const DEFAULT_POLL_INTERVAL_MS = 100;
export class ControllerStartUnconfirmedError extends Error {
  constructor(readonly pid: number, message: string) {
    super(message);
    this.name = "ControllerStartUnconfirmedError";
  }
}
/**
 * Optional confirmation debounce after the candidate latches `dualOwner:
 * true`. Defaults to 0: the candidate's own exit grace
 * (`DEFAULT_DUAL_OWNER_GRACE_MS` in `handoverCandidate.ts`) is the single
 * authoritative old-owner exit window. It outlives the complete Controller
 * shutdown/drain boundary, and the activator trusts the candidate's latched
 * signal. A non-zero value only adds a short extra confirmation before reporting
 * dual-owner; it must never be used to re-litigate the exit grace.
 */
export const DEFAULT_DUAL_OWNER_GRACE_MS = 0;

export type ReleaseActivatePorts = Readonly<{
  /** Authenticated Controller RPC. */
  call: (home: string, method: string, params: JsonValue) => Promise<JsonValue>;
  /** Spawn the release's Controller as a detached handover candidate. */
  spawnCandidate: (home: string, releaseDir: string, handoverId: string) => void;
  /** Spawn the release's Controller as the primary (no old owner running). */
  startControllerFromRelease: (home: string, releaseDir: string) => Promise<void>;
  /** Read-only storage compatibility preflight against the target Home. */
  runPreflight: (releaseDir: string, home: string) => void;
  /** Fenced process termination for a rolled-back candidate. */
  killOwnedProcess: (owner: HandoverOwner) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}>;

export type ReleaseActivateOptions = Readonly<{
  home: string;
  releaseDir: string;
  manifest: RuntimeReleaseManifest;
  candidateReadyTimeoutMs?: number;
  promotionTimeoutMs?: number;
  pollIntervalMs?: number;
  /**
   * Optional confirmation debounce after the candidate latches dual-owner.
   * Defaults to 0 (trust the candidate's latched signal immediately). The
   * candidate's centralized exit grace is the authoritative old-owner window.
   */
  dualOwnerGraceMs?: number;
}>;

export type ReleaseActivateResult = Readonly<
  | {
      outcome: "activated";
      releaseId: string;
      handoverId: string;
      oldPid?: number;
    }
  | { outcome: "already-active"; releaseId: string }
  | {
      outcome: "aborted";
      phase: string;
      message: string;
      action: string;
      recoverable: boolean;
    }
  | {
      outcome: "dual-owner";
      releaseId: string;
      handoverId: string;
      message: string;
      action: string;
    }
>;

export async function activateRelease(
  ports: ReleaseActivatePorts,
  options: ReleaseActivateOptions
): Promise<ReleaseActivateResult> {
  const { home, manifest } = options;
  const releaseId = `${manifest.version}-${manifest.packageDigest}`;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const candidateReadyTimeoutMs = options.candidateReadyTimeoutMs
    ?? DEFAULT_CANDIDATE_READY_TIMEOUT_MS;
  const promotionTimeoutMs = options.promotionTimeoutMs ?? DEFAULT_PROMOTION_TIMEOUT_MS;
  const dualOwnerGraceMs = options.dualOwnerGraceMs ?? DEFAULT_DUAL_OWNER_GRACE_MS;

  const active = readActiveReleasePointer(home);
  // An in-flight handover (durable fence) always takes precedence over the
  // already-active shortcut: the pointer may name this release while a
  // crashed activation left the old Controller live or the candidate
  // unpromoted. Recovery must run first.
  if (active !== null && active.releaseId === releaseId && readHandoverFence(home) === null) {
    return { outcome: "already-active", releaseId };
  }

  // 1) Read-only storage compatibility preflight. A failure leaves the old
  // Controller and pointer untouched.
  try {
    ports.runPreflight(options.releaseDir, home);
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "preflight",
      message: `Storage compatibility preflight failed: ${messageOf(error)}`,
      action: "The current Controller and active release pointer are unchanged.",
      recoverable: true
    };
  }

  const lock = acquireHandoverLock(home);
  try {
    return await activateLocked(ports, {
      home,
      releaseDir: options.releaseDir,
      manifest,
      releaseId,
      active,
      pollIntervalMs,
      candidateReadyTimeoutMs,
      promotionTimeoutMs,
      dualOwnerGraceMs
    });
  } finally {
    lock.release();
  }
}

type LockedOptions = Readonly<{
  home: string;
  releaseDir: string;
  manifest: RuntimeReleaseManifest;
  releaseId: string;
  active: ActiveReleasePointer | null;
  pollIntervalMs: number;
  candidateReadyTimeoutMs: number;
  promotionTimeoutMs: number;
  dualOwnerGraceMs: number;
}>;

async function activateLocked(
  ports: ReleaseActivatePorts,
  locked: LockedOptions
): Promise<ReleaseActivateResult> {
  const { home, manifest, releaseDir } = locked;
  const { releaseId, active } = locked;

  // 2) Crash recovery: a durable fence records the exact phase a previous
  // activator reached. Resume or roll back deterministically.
  const recovery = await recoverInterruptedHandover(ports, home, locked);
  if (recovery !== null) return recovery;

  // 3) Capture the old Controller identity. When no Controller is running,
  // activation only needs the pointer switch plus a fresh start.
  const old = await readOldController(ports, home);
  if (old === null) {
    return await activateWithoutOldController(ports, home, manifest, releaseDir, releaseId, active);
  }

  // 4) Begin the handover: the old Controller fences mutations and records
  // the durable fence.
  const handoverId = newHandoverId();
  let beginResult: JsonValue;
  try {
    beginResult = await ports.call(home, "controller.begin-handover", {
      handoverId,
      fromReleaseId: active?.releaseId ?? null,
      toReleaseId: releaseId
    });
  } catch (error) {
    return {
      outcome: "aborted",
      phase: "begin-handover",
      message: `Old Controller rejected the handover: ${messageOf(error)}`,
      action: "The old Controller is still serving; inspect it and retry.",
      recoverable: true
    };
  }
  const fence = readHandoverFence(home);
  if (fence === null || fence.handoverId !== handoverId) {
    return {
      outcome: "aborted",
      phase: "begin-handover",
      message: "Old Controller did not record the handover fence.",
      action: "The old Controller is still serving; inspect it and retry.",
      recoverable: true
    };
  }
  void beginResult;

  try { ports.runPreflight(releaseDir, home); }
  catch (error) {
    try { await ports.call(home, "controller.rollback-handover", { handoverId }); }
    catch (rollbackError) {
      return {
        outcome: "aborted", phase: "preflight",
        message: `Storage preflight failed: ${messageOf(error)}; rollback failed: ${messageOf(rollbackError)}`,
        action: "No candidate was started and the release pointer is unchanged. Preserve the fence and inspect the old Controller.",
        recoverable: true
      };
    }
    return {
      outcome: "aborted", phase: "preflight",
      message: `Fenced storage preflight failed: ${messageOf(error)}`,
      action: "The old Controller is serving again; the active release and Home are unchanged.",
      recoverable: true
    };
  }

  // 5) Start the candidate and wait for its identity read-back.
  ports.spawnCandidate(home, releaseDir, handoverId);
  const candidateReady = await waitForCandidateReady(
    ports,
    home,
    manifest,
    locked.candidateReadyTimeoutMs,
    locked.pollIntervalMs
  );
  if (candidateReady === null) {
    const rollbackError = await rollbackHandover(ports, home, fence);
    return {
      outcome: "aborted",
      phase: "candidate-ready",
      message: rollbackError === null
        ? "The new Controller candidate did not become ready in time."
        : `The new Controller candidate did not become ready; rollback is unconfirmed: ${rollbackError}`,
      action: rollbackError === null
        ? "The old Controller has resumed accepting mutations; retry the activation."
        : "Preserve the handover fence and candidate discovery; inspect process owners before retrying.",
      recoverable: rollbackError === null
    };
  }

  // 6) Switch the active release pointer. This is the atomic commit point:
  // after it succeeds, Controller lifecycle operations resolve the new
  // release. The ordinary CLI and managed Session wrappers stay on `yui`.
  const pointer: ActiveReleasePointer = Object.freeze({
    schemaVersion: 1,
    releaseId,
    version: manifest.version,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    activatedAt: ports.now().toISOString()
  });
  writeActiveReleasePointer(home, pointer);

  // 7) Commit the old Controller: it closes its socket and exits.
  try {
    await ports.call(home, "controller.commit-handover", { handoverId });
  } catch (error) {
    // The commit RPC may fail because the old Controller exited after
    // responding. The promotion wait below resolves the true state.
    if (!isConnectionError(error)) throw error;
  }

  // 8) Wait for the candidate to promote itself (old owner gone + pointer
  // switched). A stuck old owner leaves the candidate read-only.
  const promotion = await waitForPromotion(
    ports,
    home,
    fence,
    locked.promotionTimeoutMs,
    locked.pollIntervalMs,
    locked.dualOwnerGraceMs
  );
  if (promotion === "promoted") {
    return { outcome: "activated", releaseId, handoverId, oldPid: old.pid };
  }
  if (promotion === "dual-owner") {
    return {
      outcome: "dual-owner",
      releaseId,
      handoverId,
      message: "The old Controller did not exit after the handover commit; "
        + "the candidate is read-only and no Controller is writing.",
      action: "Stop the old Controller with a fenced `controller stop` "
        + `(PID ${old.pid}); the candidate will then promote itself.`
    };
  }
  // Promotion timed out without a clear dual-owner signal. The receipt and
  // fence record the exact state for manual recovery.
  return {
    outcome: "aborted",
    phase: "promotion",
    message: "The candidate did not promote within the timeout.",
    action: "Inspect the handover fence and receipt; the old Controller may "
      + "still be running or the candidate may have exited.",
    recoverable: false
  };
}

async function activateWithoutOldController(
  ports: ReleaseActivatePorts,
  home: string,
  manifest: RuntimeReleaseManifest,
  releaseDir: string,
  releaseId: string,
  active: ActiveReleasePointer | null
): Promise<ReleaseActivateResult> {
  const handoverId = newHandoverId();
  const pointer: ActiveReleasePointer = Object.freeze({
    schemaVersion: 1,
    releaseId,
    version: manifest.version,
    buildId: manifest.buildId,
    packageDigest: manifest.packageDigest,
    activatedAt: ports.now().toISOString()
  });
  writeActiveReleasePointer(home, pointer);
  try {
    await ports.startControllerFromRelease(home, releaseDir);
  } catch (error) {
    if (error instanceof ControllerStartUnconfirmedError) {
      return {
        outcome: "aborted",
        phase: "start-controller",
        message: `New Controller startup is unconfirmed (PID ${error.pid}): ${error.message}`,
        action: "Preserve the new release pointer and inspect the exact Controller process before retrying.",
        recoverable: false
      };
    }
    // A pre-spawn failure cannot have started a Controller. Restore the
    // pointer's previous value, including its absence.
    if (active !== null) writeActiveReleasePointer(home, active);
    else removeActiveReleasePointer(home);
    return {
      outcome: "aborted",
      phase: "start-controller",
      message: `The new Controller did not start: ${messageOf(error)}`,
      action: "The active release pointer was restored; the old release is unchanged.",
      recoverable: true
    };
  }
  writeHandoverReceipt(home, Object.freeze({
    schemaVersion: 1,
    handoverId,
    outcome: "completed",
    old: null,
    candidate: null,
    previousReleaseId: active?.releaseId ?? null,
    activatedReleaseId: releaseId,
    startedAt: ports.now().toISOString(),
    completedAt: ports.now().toISOString()
  }));
  return { outcome: "activated", releaseId, handoverId };
}

async function readOldController(
  ports: ReleaseActivatePorts,
  home: string
): Promise<HandoverOwner | null> {
  try {
    const identity = await ports.call(home, "controller.identity", {});
    if (
      typeof identity !== "object"
      || identity === null
      || typeof (identity as { pid?: unknown }).pid !== "number"
    ) {
      throw new Error("Running Controller returned an invalid identity; handover cannot be fenced.");
    }
    const record = identity as Record<string, unknown>;
    if (record.releaseDrifted === true) {
      throw new Error(
        "The old Controller's release has drifted from its installed manifest; "
        + "refusing to hand over. Reinstall or restore the active release before activating."
      );
    }
    const startIdentity = typeof record.processStartIdentity === "string"
      ? record.processStartIdentity
      : undefined;
    if (startIdentity === undefined) {
      throw new Error("Running Controller did not provide a process-generation identity; handover cannot be fenced.");
    }
    return Object.freeze({
      pid: record.pid as number,
      processStartIdentity: startIdentity,
      buildId: typeof record.buildId === "string" ? record.buildId : "unknown",
      version: typeof record.version === "string" ? record.version : "unknown"
    });
  } catch (error) {
    if (isControllerNotRunning(error)) return null;
    throw error;
  }
}

async function waitForCandidateReady(
  ports: ReleaseActivatePorts,
  home: string,
  manifest: RuntimeReleaseManifest,
  timeoutMs: number,
  pollIntervalMs: number
): Promise<HandoverOwner | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = readCandidateDiscovery(home);
    if (candidate !== null) {
      const identity = readRuntimeIdentity(home);
      if (
        identity !== null
        && identity.mode === "candidate"
        && identity.buildId === manifest.buildId
        && identity.pid === candidate.pid
      ) {
        return Object.freeze({
          pid: candidate.pid,
          processStartIdentity: candidate.processStartIdentity,
          buildId: identity.buildId,
          version: identity.version
        });
      }
    }
    if (Date.now() >= deadline) return null;
    await ports.sleep(pollIntervalMs);
  }
}

async function waitForPromotion(
  ports: ReleaseActivatePorts,
  home: string,
  fence: HandoverFence,
  timeoutMs: number,
  pollIntervalMs: number,
  dualOwnerGraceMs: number
): Promise<"promoted" | "dual-owner" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  let dualOwnerSince: number | null = null;
  for (;;) {
    const receipt = readHandoverReceipt(home);
    if (
      receipt !== null
      && receipt.handoverId === fence.handoverId
      && receipt.outcome === "completed"
    ) {
      return "promoted";
    }
    const identity = readRuntimeIdentity(home);
    if (identity !== null && identity.mode === "candidate" && identity.dualOwner) {
      if (dualOwnerSince === null) dualOwnerSince = Date.now();
      // Give the old owner a short grace window to exit before declaring
      // dual-owner.
      if (Date.now() - dualOwnerSince > dualOwnerGraceMs) return "dual-owner";
    } else {
      dualOwnerSince = null;
    }
    if (Date.now() >= deadline) return "timeout";
    await ports.sleep(pollIntervalMs);
  }
}

async function rollbackHandover(
  ports: ReleaseActivatePorts,
  home: string,
  fence: HandoverFence
): Promise<string | null> {
  const candidate = readCandidateDiscovery(home);
  if (candidate !== null) {
    try {
      if (processGenerationIsLive(candidate.pid, candidate.processStartIdentity)) {
        ports.killOwnedProcess({
          pid: candidate.pid,
          processStartIdentity: candidate.processStartIdentity,
          buildId: "candidate",
          version: "candidate"
        });
        for (let attempt = 0; attempt < 20; attempt += 1) {
          if (!processGenerationIsLive(candidate.pid, candidate.processStartIdentity)) break;
          await ports.sleep(50);
        }
      }
      if (processGenerationIsLive(candidate.pid, candidate.processStartIdentity)) {
        return `candidate PID ${candidate.pid} is still live`;
      }
    } catch (error) {
      return `candidate PID ${candidate.pid}: ${messageOf(error)}`;
    }
    removeCandidateDiscovery(home);
  }
  try {
    await ports.call(home, "controller.rollback-handover", {
      handoverId: fence.handoverId
    });
  } catch (error) {
    return `old Controller rollback: ${messageOf(error)}`;
  }
  writeHandoverFence(home, Object.freeze({
    ...fence,
    phase: "rolled-back",
    updatedAt: new Date().toISOString()
  }));
  writeHandoverReceipt(home, Object.freeze({
    schemaVersion: 1,
    handoverId: fence.handoverId,
    outcome: "rolled-back",
    old: fence.old,
    candidate: fence.candidate,
    previousReleaseId: fence.fromReleaseId,
    activatedReleaseId: fence.toReleaseId,
    startedAt: fence.createdAt,
    completedAt: new Date().toISOString()
  }));
  return null;
}

async function recoverInterruptedHandover(
  ports: ReleaseActivatePorts,
  home: string,
  locked: LockedOptions
): Promise<ReleaseActivateResult | null> {
  const fence = readHandoverFence(home);
  if (fence === null) return null;
  if (fence.phase === "rolled-back") {
    removeHandoverFence(home);
    return null;
  }
  const candidateLive = readCandidateDiscovery(home) !== null
    && (() => {
      const discovery = readCandidateDiscovery(home);
      return discovery !== null && isOwnerLive({
        pid: discovery.pid,
        processStartIdentity: discovery.processStartIdentity,
        buildId: "candidate",
        version: "candidate"
      });
    })();
  const oldLive = isOwnerLive(fence.old);

  if (fence.phase === "committed") {
    if (candidateLive) {
      const promotion = await waitForPromotion(
        ports,
        home,
        fence,
        locked.promotionTimeoutMs,
        locked.pollIntervalMs,
        locked.dualOwnerGraceMs
      );
      if (promotion === "promoted") {
        return {
          outcome: "activated",
          releaseId: fence.toReleaseId,
          handoverId: fence.handoverId,
          oldPid: fence.old.pid
        };
      }
      if (promotion === "dual-owner") {
        return {
          outcome: "dual-owner",
          releaseId: fence.toReleaseId,
          handoverId: fence.handoverId,
          message: "The old Controller did not exit after the handover commit; "
            + "the candidate is read-only and no Controller is writing.",
          action: "Stop the old Controller with a fenced `controller stop`; "
            + "the candidate will then promote itself."
        };
      }
    }
    if (!oldLive) {
      // Both old and candidate are gone; the pointer may already be switched.
      removeHandoverFence(home);
      return null;
    }
    return {
      outcome: "dual-owner",
      releaseId: fence.toReleaseId,
      handoverId: fence.handoverId,
      message: "The handover was committed but the candidate is gone and the "
        + "old Controller is still live.",
      action: "Stop the old Controller with a fenced `controller stop`, then "
        + "retry the activation."
    };
  }

  // phase "fenced" or "candidate-ready"
  if (candidateLive) {
    // Resume the in-flight handover: wait for readiness, switch pointer,
    // commit, promote. The simplest safe resume is to re-drive from the
    // candidate-ready wait.
    const candidateReady = await waitForCandidateReady(
      ports,
      home,
      locked.manifest,
      locked.candidateReadyTimeoutMs,
      locked.pollIntervalMs
    );
    if (candidateReady === null) {
      const rollbackError = await rollbackHandover(ports, home, fence);
      if (rollbackError !== null) {
        return {
          outcome: "aborted", phase: "recovery",
          message: `Interrupted handover rollback is unconfirmed: ${rollbackError}`,
          action: "Preserve the handover fence and candidate discovery; inspect process owners before retrying.",
          recoverable: false
        };
      }
      return null;
    }
    const pointer: ActiveReleasePointer = Object.freeze({
      schemaVersion: 1,
      releaseId: locked.releaseId,
      version: locked.manifest.version,
      buildId: locked.manifest.buildId,
      packageDigest: locked.manifest.packageDigest,
      activatedAt: ports.now().toISOString()
    });
    writeActiveReleasePointer(home, pointer);
    try {
      await ports.call(home, "controller.commit-handover", {
        handoverId: fence.handoverId
      });
    } catch (error) {
      if (!isConnectionError(error)) throw error;
    }
    const promotion = await waitForPromotion(
      ports,
      home,
      fence,
      locked.promotionTimeoutMs,
      locked.pollIntervalMs,
      locked.dualOwnerGraceMs
    );
    if (promotion === "promoted") {
      return {
        outcome: "activated",
        releaseId: locked.releaseId,
        handoverId: fence.handoverId,
        oldPid: fence.old.pid
      };
    }
    return null;
  }

  // Candidate is dead: roll back the old Controller and start fresh.
  if (oldLive) {
    try {
      await ports.call(home, "controller.rollback-handover", {
        handoverId: fence.handoverId
      });
    } catch (error) {
      return {
        outcome: "aborted", phase: "recovery",
        message: `Old Controller rollback is unconfirmed: ${messageOf(error)}`,
        action: "Preserve the handover fence; inspect the old Controller before retrying.",
        recoverable: false
      };
    }
  }
  // The exact candidate generation is gone; only now can its stale
  // discovery be removed during interrupted-handover recovery.
  if (readCandidateDiscovery(home) !== null) removeCandidateDiscovery(home);
  removeHandoverFence(home);
  return null;
}

function isControllerNotRunning(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "CONTROLLER_NOT_RUNNING";
}

function isConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "CONTROLLER_NOT_RUNNING"
    || code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "EPIPE";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
