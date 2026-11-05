import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { TaskStore } from "../storage/taskStore.js";
import { isEnabled } from "../role/availability.js";
import { createWorkMailbox, enqueueSignal, claimPending, completeProcessing, mailboxHasWork,
  type WorkMailbox } from "../coordination/workMailbox.js";
import { RUNTIME_HOST_UPGRADE_REASON, RUNTIME_HOST_UPGRADE_DRAINED as DRAINED,
  RUNTIME_HOST_UPGRADE_FAILED as FAILED, runtimeLifecycleTarget, runtimeCleanupDisposition,
  type RuntimeRoleOwner } from "../runtime/lifecycleReservation.js";
import type { EffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { AgentHostSnapshot } from "../runtime/agentHost.js";
import type { HostUpgradeFence } from "../runtime/hostUpgradeGate.js";
import type { ImplementationRef } from "../kernel/instanceHost.js";

const SOURCE = "host-upgrade/v1:";
type Request = HostUpgradeFence & Readonly<{
  targetGeneration: string;
  agentId: string;
  adapterId: string;
  effectiveDigest: string;
}>;
export type HostUpgradeResult = Readonly<{
  owner: RuntimeRoleOwner;
  nativeSessionId: string;
  status: "current" | "upgraded" | "waiting" | "paused" | "unsupported" | "failed" | "unknown";
  hostImplementation?: ImplementationRef;
  endpointImplementation?: ImplementationRef;
  detail?: string;
}>;
export type HostUpgradePorts = Readonly<{
  inspect(owner: RuntimeRoleOwner): Promise<AgentHostSnapshot>;
  control(owner: RuntimeRoleOwner, type: "prepare-upgrade" | "finish-upgrade", request: HostUpgradeFence): Promise<AgentHostSnapshot>;
  hostState(owner: RuntimeRoleOwner): Promise<"running" | "stopped" | "unavailable" | "starting">;
  restore(owner: RuntimeRoleOwner, request: Request, effective: EffectiveLaunchSnapshot, assertCurrent: () => void): Promise<void>;
  endpoint(adapterId: string): ImplementationRef;
  /** A derived target, not a second persisted configuration. The existing
   * request pins its digest, just as a version upgrade pins the fixed launch. */
  reconfiguration?(owner: RuntimeRoleOwner, effective: EffectiveLaunchSnapshot):
    Readonly<{ effective: EffectiveLaunchSnapshot; unsupported?: string }>;
  /** Called only after the exact Host drain receipt and physical exit. */
  adopt?(owner: RuntimeRoleOwner, request: Request, effective: EffectiveLaunchSnapshot, assertCurrent: () => void): void;
}>;

/** Reuse the durable role-runtime lane and its fixed claim/settlement contract.
 * The versioned signal source is a bounded exact request, not a second queue
 * or writable Session state. No environment, credentials or inputs are copied.
 * The drain signal is persisted BEFORE asking the old process to exit. */
export class HostUpgradeCoordinator {
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(private readonly store: TaskStore, private readonly target: ImplementationRef,
    private readonly ports: HostUpgradePorts) {}

  hasPending(): boolean {
    return !this.#closed && this.store.listWorkMailboxes().some(mailbox =>
      reasons(mailbox).includes(RUNTIME_HOST_UPGRADE_REASON));
  }
  stop(): void { this.#closed = true; }
  async close(): Promise<void> {
    this.stop();
    await this.#tail;
  }

  /** Read-only follow-up: never admits, drains, restores, or settles a request. */
  async status(): Promise<readonly HostUpgradeResult[]> {
    const results: HostUpgradeResult[] = [];
    for (const { owner, nativeSessionId, adapterId, agentId } of this.store.listRuntimeSessionCandidates()) {
      if (this.#closed) break;
      const result = (status: HostUpgradeResult["status"], detail?: string, snapshot?: AgentHostSnapshot): HostUpgradeResult => ({
        owner, nativeSessionId, status, detail, hostImplementation: snapshot?.hostImplementation,
        endpointImplementation: snapshot?.endpointImplementation
      });
      try {
        const mailbox = this.store.getWorkMailbox(runtimeLifecycleTarget(owner));
        const request = readRequest(mailbox);
        if (!this.enabled(owner)) { results.push(result("paused", "Role/Task remains paused.")); continue; }
        const state = await this.ports.hostState(owner);
        const live = state === "running" ? await this.ports.inspect(owner) : undefined;
        const session = this.session(owner, agentId);
        const target = session && this.reconfiguration(owner, session.effective);
        const changing = target && !isDeepStrictEqual(target.effective, session!.effective);
        if (target?.unsupported) {
          results.push(result("unsupported", target.unsupported, live));
        } else if (live && !request && !changing && this.verified(live, nativeSessionId, adapterId)) {
          results.push(result("current", "Loaded Host and Endpoint match this Controller.", live));
        } else if (request && (request.nativeSessionId !== nativeSessionId || live
          && (live.nativeSessionId !== request.nativeSessionId || live.processInstanceId !== request.processInstanceId))) {
          results.push(result("unknown", `Request ${request.requestId} does not match the observed Host/Session.`, live));
        } else if (request) {
          results.push(result(reasons(mailbox).includes(FAILED) || live?.hostUpgrade?.state === "failed" ? "failed"
            : state === "unavailable" ? "unknown" : "waiting",
          `Request ${request.requestId}; target=${request.targetGeneration}; Host=${state}; drain=${live?.hostUpgrade?.state
            ?? (reasons(mailbox).includes(DRAINED) ? "persisted" : "unconfirmed")}. ${live?.hostUpgrade?.detail ?? ""}`, live));
        } else if (changing) {
          results.push(result("waiting", "Task-main scope changed; original conversation awaits a drained Host refresh.", live));
        } else {
          results.push(result(live && (!live.controlCapabilities?.includes("prepare-upgrade")
            || !live.controlCapabilities.includes("finish-upgrade")) ? "unsupported" : "unknown",
          "No confirmed switch to this Controller's generation.", live));
        }
      } catch (error) { results.push(result("unknown", message(error))); }
    }
    return results;
  }

  request(): Promise<readonly HostUpgradeResult[]> {
    return this.serial(async () => {
      const results: HostUpgradeResult[] = [];
      for (const candidate of this.store.listRuntimeSessionCandidates()) {
        if (this.#closed) break;
        const { owner, nativeSessionId } = candidate;
        const result = (status: HostUpgradeResult["status"], detail?: string, snapshot?: AgentHostSnapshot): HostUpgradeResult => ({
          owner, nativeSessionId, status, detail, hostImplementation: snapshot?.hostImplementation,
          endpointImplementation: snapshot?.endpointImplementation
        });
        try {
          const existing = this.store.getWorkMailbox(runtimeLifecycleTarget(owner));
          if (readRequest(existing)) { results.push(await this.step(owner)); continue; }
          if (!this.enabled(owner)) { results.push(result("paused", "Role/Task remains paused; no Host is started.")); continue; }
          const snapshot = await this.ports.inspect(owner);
          if (this.#closed) break;
          if (snapshot.nativeSessionId !== nativeSessionId) {
            results.push(result("unknown", "Live Host does not match the recorded native Session.", snapshot)); continue;
          }
          const session = this.session(owner, candidate.agentId);
          if (!session || session.nativeSessionId !== nativeSessionId) throw new Error("Session changed before upgrade admission.");
          const target = this.reconfiguration(owner, session.effective);
          if (target.unsupported) {
            results.push(result("unsupported", target.unsupported, snapshot)); continue;
          }
          const changing = !isDeepStrictEqual(target.effective, session.effective);
          if (!changing && this.verified(snapshot, nativeSessionId, candidate.adapterId)) {
            results.push(result("current", undefined, snapshot)); continue;
          }
          if (!changing && this.sameImplementations(snapshot, candidate.adapterId)) {
            results.push(result("waiting", "Loaded implementations match; lifecycle/event readiness is not a version mismatch.", snapshot));
            continue;
          }
          if (!snapshot.controlCapabilities?.includes("prepare-upgrade")
            || !snapshot.controlCapabilities.includes("finish-upgrade")
            || !snapshot.hostImplementation?.generation || !snapshot.endpointImplementation?.generation
            || !snapshot.processInstanceId) {
            results.push(result("unsupported", "Old Host has no graceful-upgrade capability; retained without sending unsupported commands.", snapshot));
            continue;
          }
          if (existing && mailboxHasWork(existing)) {
            results.push(result("waiting", "Another exact lifecycle operation owns this Role.", snapshot)); continue;
          }
          const body = {
            nativeSessionId, processInstanceId: snapshot.processInstanceId,
            hostGeneration: snapshot.hostImplementation.generation, targetGeneration: this.target.generation,
            agentId: candidate.agentId, adapterId: candidate.adapterId, effectiveDigest: digest(target.effective)
          };
          const request: Request = { requestId: `host-upgrade-${digest([owner, body])}`, ...body };
          this.store.transaction(tx => {
            const latest = tx.getWorkMailbox(runtimeLifecycleTarget(owner));
            if (latest && mailboxHasWork(latest)) throw new Error("Runtime lane changed before upgrade admission.");
            const current = this.session(owner, candidate.agentId);
            if (!current || current.nativeSessionId !== nativeSessionId
              || digest(this.reconfiguration(owner, current.effective).effective) !== request.effectiveDigest) {
              throw new Error("Session changed before upgrade admission.");
            }
            tx.saveWorkMailbox(enqueueSignal(latest ?? createWorkMailbox(runtimeLifecycleTarget(owner)), {
              reason: RUNTIME_HOST_UPGRADE_REASON, refs: [{ type: "session", id: nativeSessionId }],
              source: SOURCE + JSON.stringify(request), dedupeKey: request.requestId, occurredAt: new Date().toISOString()
            }));
          });
          results.push(await this.step(owner));
        } catch (error) { results.push(result("unknown", message(error))); }
      }
      return results;
    });
  }

  reconcile(): Promise<readonly HostUpgradeResult[]> {
    return this.serial(async () => {
      const results: HostUpgradeResult[] = [];
      for (const mailbox of this.store.listWorkMailboxes()) {
        if (this.#closed) break;
        const target = mailbox.target;
        if (target.kind !== "role-runtime" && target.kind !== "global-role-runtime") continue;
        const owner: RuntimeRoleOwner = target.kind === "role-runtime"
          ? { scope: "task", taskId: target.taskId, roleName: target.roleName }
          : { scope: "global", roleName: target.roleName };
        try {
          if (!readRequest(mailbox)) continue;
          results.push(await this.step(owner));
        } catch (error) {
          results.push({ owner, nativeSessionId: "", status: "unknown", detail: message(error) });
        }
      }
      return results;
    });
  }

  private async step(owner: RuntimeRoleOwner): Promise<HostUpgradeResult> {
    let mailbox = this.store.getWorkMailbox(runtimeLifecycleTarget(owner));
    const request = readRequest(mailbox)!;
    const result = (status: HostUpgradeResult["status"], detail?: string, snapshot?: AgentHostSnapshot): HostUpgradeResult => ({
      owner, nativeSessionId: request.nativeSessionId, status, detail,
      hostImplementation: snapshot?.hostImplementation, endpointImplementation: snapshot?.endpointImplementation
    });
    try {
      if (runtimeCleanupDisposition(mailbox) !== "upgrade-host") return result("waiting", "Explicit lifecycle cleanup supersedes upgrade.");
      if (request.targetGeneration !== this.target.generation) return result("waiting", "Controller generation differs from the pinned update target.");
      if (!this.enabled(owner)) return result("paused", "Role/Task remains paused; original upgrade intent retained.");
      const assertCurrent = () => {
        const session = this.session(owner, request.agentId);
        const currentMailbox = this.store.getWorkMailbox(runtimeLifecycleTarget(owner));
        if (this.#closed || !session || session.status !== "active" || session.nativeSessionId !== request.nativeSessionId
          || digest(this.reconfiguration(owner, session.effective).effective) !== request.effectiveDigest || !this.enabled(owner)
          || runtimeCleanupDisposition(currentMailbox) !== "upgrade-host"
          || !isDeepStrictEqual(readRequest(currentMailbox), request)) {
          throw new Error("Upgrade no longer owns the original Session/configuration/lifecycle lane.");
        }
        if (this.reconfiguration(owner, session.effective).unsupported) {
          throw new Error("The pinned scope can no longer be resumed by this adapter.");
        }
        return session;
      };
      const session = assertCurrent();
      let live: AgentHostSnapshot | undefined;
      const hostState = await this.ports.hostState(owner);
      if (hostState === "running") {
        live = await this.ports.inspect(owner);
        if (digest(session.effective) === request.effectiveDigest
          && live.processInstanceId !== request.processInstanceId
          && this.verified(live, request.nativeSessionId, request.adapterId)) {
          assertCurrent();
          this.complete(owner, request);
          return result("upgraded", undefined, live);
        }
        if (reasons(mailbox).includes(FAILED)) return result("failed", "Prior upgrade failed; exact request and drain facts retained. Inspect before retrying.", live);
        if (live.nativeSessionId !== request.nativeSessionId || live.processInstanceId !== request.processInstanceId
          || live.hostImplementation?.generation !== request.hostGeneration) {
          return result("unknown", "Host changed without the target handshake; no process was stopped.", live);
        }
        if (!reasons(mailbox).includes(DRAINED)) {
          assertCurrent();
          live = await this.ports.control(owner, "prepare-upgrade", request);
          const drain = live.hostUpgrade;
          if (drain?.requestId !== request.requestId) return result("unknown", "Drain acknowledgement is missing or mismatched.", live);
          if (drain.state === "failed") {
            this.signal(owner, request, FAILED);
            return result("failed", drain.detail, live);
          }
          if (drain.state !== "drained") return result("waiting", "Admission fenced; waiting for native terminal, event persistence and owned-resource drain.", live);
          assertCurrent();
          this.signal(owner, request, DRAINED);
          mailbox = this.store.getWorkMailbox(runtimeLifecycleTarget(owner));
        }
        if (live.hostUpgrade?.requestId !== request.requestId || live.hostUpgrade.state !== "drained") {
          return result("unknown", "Persisted drain receipt does not match this live Host.", live);
        }
        assertCurrent();
        await this.ports.control(owner, "finish-upgrade", request);
        return result("waiting", "Old Host drained; awaiting its graceful process exit.", live);
      }
      if (reasons(mailbox).includes(FAILED)) return result("failed", "Prior launch is unconfirmed; retained request is not automatically replayed.");
      if (hostState !== "stopped" || !reasons(mailbox).includes(DRAINED)) {
        return result("unknown", "No proven old Host drain/exit; original inputs and Session retained.");
      }
      assertCurrent();
      const target = this.reconfiguration(owner, session.effective).effective;
      if (!isDeepStrictEqual(target, session.effective)) {
        if (!this.ports.adopt) return result("unsupported", "No drained scope-adoption capability is available.");
        this.ports.adopt(owner, request, target, assertCurrent);
      }
      const adopted = assertCurrent();
      if (digest(adopted.effective) !== request.effectiveDigest) throw new Error("Scope adoption did not match the pinned target.");
      // A failed or unknown launch is NOT automatically replayed. The existing
      // Host/pane and the exact mailbox request remain available for inspection.
      try { await this.ports.restore(owner, request, adopted.effective, assertCurrent); }
      catch (error) {
        this.signal(owner, request, FAILED);
        return result("failed", `Target Host launch/handshake failed: ${message(error)}`);
      }
      live = await this.ports.inspect(owner);
      if (live.processInstanceId === request.processInstanceId
        || !this.verified(live, request.nativeSessionId, request.adapterId)) {
        this.signal(owner, request, FAILED);
        return result("failed", "Target Host did not prove native identity, implementations and control/event capabilities.", live);
      }
      assertCurrent();
      this.complete(owner, request);
      return result("upgraded", undefined, live);
    } catch (error) { return result("unknown", message(error)); }
  }

  private verified(snapshot: AgentHostSnapshot, nativeSessionId: string, adapterId: string) {
    return snapshot.nativeSessionId === nativeSessionId && snapshot.adapterId === adapterId
      && this.sameImplementations(snapshot, adapterId)
      && snapshot.controlCapabilities?.includes("reconcile-turn")
      && snapshot.eventDelivery !== undefined && snapshot.eventDelivery.unpersisted === 0
      && snapshot.eventDelivery.failure === undefined && ["idle", "ready", "busy"].includes(snapshot.state);
  }
  private reconfiguration(owner: RuntimeRoleOwner, effective: EffectiveLaunchSnapshot) {
    return this.ports.reconfiguration?.(owner, effective) ?? { effective };
  }
  private sameImplementations(snapshot: AgentHostSnapshot, adapterId: string) {
    return isDeepStrictEqual(snapshot.hostImplementation, this.target)
      && isDeepStrictEqual(snapshot.endpointImplementation, this.ports.endpoint(adapterId));
  }
  private session(owner: RuntimeRoleOwner, agentId: string) {
    const set = owner.scope === "task" ? this.store.getTaskRoleSessionSet(owner.taskId, owner.roleName)
      : this.store.getGlobalRoleSessionSet(owner.roleName);
    return set?.activeAgentId === agentId ? set.sessions[agentId] : undefined;
  }
  private enabled(owner: RuntimeRoleOwner) {
    const role = owner.scope === "task" ? this.store.getRole(owner.taskId, owner.roleName) : this.store.getGlobalRole(owner.roleName);
    if (!role || !isEnabled(role)) return false;
    if (owner.scope === "global") return true;
    const task = this.store.getTask(owner.taskId);
    return !!task && ["active", "draft"].includes(task.status) && task.executionGate.state === "enabled";
  }
  private signal(owner: RuntimeRoleOwner, request: Request, reason: string) {
    this.store.transaction(tx => {
      const mailbox = tx.getWorkMailbox(runtimeLifecycleTarget(owner));
      if (!mailbox || !isDeepStrictEqual(readRequest(mailbox), request)) throw new Error("Upgrade mailbox changed.");
      tx.saveWorkMailbox(enqueueSignal(mailbox, { reason, refs: [], source: "host-upgrade",
        dedupeKey: `${request.requestId}:${reason}`, occurredAt: new Date().toISOString() }));
    });
  }
  private complete(owner: RuntimeRoleOwner, request: Request) {
    this.store.transaction(tx => {
      let mailbox = tx.getWorkMailbox(runtimeLifecycleTarget(owner));
      if (!mailbox || !isDeepStrictEqual(readRequest(mailbox), request)
        || runtimeCleanupDisposition(mailbox) !== "upgrade-host") throw new Error("Upgrade mailbox changed.");
      if (mailbox.processing) mailbox = completeProcessing(mailbox, mailbox.processing.batchId);
      if (mailbox.pending) {
        const batchId = request.requestId;
        mailbox = completeProcessing(claimPending(mailbox, {
          batchId, owner: "runtime-lifecycle", startedAt: new Date().toISOString()
        }), batchId);
      }
      tx.saveWorkMailbox(mailbox); // retain bounded dedupe receipts for repeated update
    });
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(run);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}
function reasons(mailbox: WorkMailbox | null) {
  return [...mailbox?.pending?.reasons ?? [], ...mailbox?.processing?.batch.reasons ?? []];
}
function readRequest(mailbox: WorkMailbox | null): Request | undefined {
  if (!reasons(mailbox).includes(RUNTIME_HOST_UPGRADE_REASON)) return undefined;
  const sources = [...mailbox?.pending?.sources ?? [], ...mailbox?.processing?.batch.sources ?? []]
    .filter(source => source.startsWith(SOURCE));
  const unique = [...new Set(sources)];
  if (unique.length !== 1) throw new Error("Host upgrade request is missing or ambiguous.");
  const request = JSON.parse(unique[0]!.slice(SOURCE.length)) as Request;
  for (const key of ["requestId", "nativeSessionId", "processInstanceId", "hostGeneration",
    "targetGeneration", "agentId", "adapterId", "effectiveDigest"] as const) {
    if (typeof request[key] !== "string" || !request[key] || request[key].includes("\0")) {
      throw new Error("Host upgrade request is invalid.");
    }
  }
  return request;
}
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
