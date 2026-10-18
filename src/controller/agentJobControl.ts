import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { TaskStore } from "../storage/taskStore.js";
import { jobScopeKey, type JobDefinition, type JobTrigger } from "../job/jobDefinition.js";
import { jobAgentRoleName, type AgentJobRun, type JobAgentAttempt, type JobAgentRecipient } from "../job/agentJob.js";
import { validateBusinessResult, type JobBusinessResult } from "../job/jobBusinessResult.js";
import { assertCallerAuthorized, type DurableJobCaller } from "./jobControl.js";
import { authorizeScope } from "./jobDefinitionControl.js";
import { createGlobalRole, createRoleAgentBinding } from "../role/role.js";
import { createTaskMessage, createGlobalRoleMessage, type TaskMessageRecipient } from "../message/message.js";
import { messageAssignmentBlocker } from "../message/messageContinuation.js";
import { enqueueWork } from "../coordination/workMailboxQueue.js";
import { currentProviderConversation } from "../runtime/providerRuntimeIdentity.js";
import { requireManagedTaskCaller } from "../runtime/managedCaller.js";
import { assertRoleRuntimeMutationAllowed } from "../commands/roleRuntimeGuard.js";
import { prepareOperatorNewSession } from "../operator/operatorSessionHistory.js";
import { RUNTIME_CLEANUP_REQUIRED_REASON, runtimeLifecycleTarget } from "../runtime/lifecycleReservation.js";
import { jobAttemptOwnsInput, recordJobAgentObservation } from "../job/agentJobObservation.js";
import { assertJobRoleRunnable } from "../job/agentRoleScope.js";
import { providerRetryPending } from "../runtime/providerRetry.js";

export function authorizeAgentDefinition(store: TaskStore, job: JobDefinition, caller: DurableJobCaller, write: boolean): void {
  const config = job.configuration;
  if (config.kind !== "agent") throw new Error("Not an Agent Job.");
  // Execution readers get only their selected Job. They cannot edit/dispatch it.
  if (!write && caller.scope === "global" && caller.role !== "operator") {
    assertCallerAuthorized(store, caller, "");
    const owner = store.getGlobalRole(caller.role!)?.jobOwner;
    if (owner && owner.jobId === job.id && isDeepStrictEqual(owner.scope, job.scope)) return;
    throw new Error("This Job Agent may read only its owning Job.");
  }
  if (!write && caller.scope === "task" && config.target.kind === "task"
    && caller.taskId === config.target.taskId && caller.role === config.target.roleName) {
    assertCallerAuthorized(store, caller, caller.taskId);
    requireTaskTarget(store, config.target, false);
    return;
  }
  authorizeScope(store, job.scope, caller, true);
  if (caller.scope === "task" && caller.role !== "leader") throw new Error("Only the Task Leader manages Agent Jobs.");
  if (write) requireWritableTaskManager(store, caller);
  if (write && job.scope.kind === "task") {
    const task = store.getTask(job.scope.taskId);
    if (task?.status !== "active" || task.executionGate.state !== "enabled") throw new Error("Agent Jobs require their owning Task to be active and execution-enabled.");
  }
  const target = config.target;
  if (target.kind === "operator" && job.scope.kind !== "global") throw new Error("Task Jobs cannot delegate to Operator.");
  if (target.kind === "task") {
    if (job.scope.kind === "task" && job.scope.taskId !== target.taskId) throw new Error("Task Agent target escapes Job Task.");
    if (write) requireTaskTarget(store, target);
  }
  if (write && target.kind === "job" && !store.getConfiguredAgent(target.agentId)) throw new Error("Job Agent is not configured.");
}

function requireTaskTarget(store: TaskStore, target: { taskId: string; roleName: string; ownerRunId?: string }, runnable = true): void {
  const task = store.getTask(target.taskId);
  if (!task || runnable && (task.status !== "active" || task.executionGate.state !== "enabled")) throw new Error("Task Agent requires an active, execution-enabled Task.");
  if (!store.getRole(target.taskId, target.roleName)) throw new Error("Task Agent Role is unavailable.");
  const recipient = taskRecipient(store, target);
  if (recipient.ownerRunId) {
    const owner = store.getRun(target.taskId, recipient.ownerRunId)!;
    // Validate a proposed recipient with the shared Assignment guard. This
    // temporary value is never stored or delivered; continuations of the same
    // Assignment remain valid, but a redispatch/workspace/owner change does not.
    const blocker = messageAssignmentBlocker(store, { taskId: target.taskId,
      createdAt: owner.createdAt, recipient });
    if (blocker && (runnable || !["execution-disabled", `task-${task.status}`].includes(blocker))) {
      throw new Error(`Task Agent Assignment unavailable: ${blocker}.`);
    }
  }
}

function taskRecipient(store: TaskStore, target: { taskId: string; roleName: string; ownerRunId?: string }): TaskMessageRecipient {
  if (target.roleName === "leader" && !target.ownerRunId) return { roleName: "leader" };
  const owner = target.ownerRunId ? store.getRun(target.taskId, target.ownerRunId) : null;
  if (!owner || owner.roleName !== target.roleName) throw new Error("Task Agent requires its exact existing Assignment.");
  if (!owner.workItemId && !owner.reviewRoundId) throw new Error("Task Agent target has no existing Assignment scope.");
  return { roleName: target.roleName, ownerRunId: owner.id,
    ...(owner.workItemId ? { workItemId: owner.workItemId } : {}),
    ...(owner.reviewRoundId ? { reviewRoundId: owner.reviewRoundId } : {}) };
}

function requireWritableTaskManager(store: TaskStore, caller: DurableJobCaller): void {
  if (caller.scope !== "task") return;
  const current = requireManagedTaskCaller(store, { YUI_SESSION_SCOPE: "task", YUI_TASK_ID: caller.taskId,
    YUI_ROLE: caller.role, YUI_NATIVE_SESSION_ID: caller.nativeSessionId });
  const set = store.getTaskRoleSessionSet(current.taskId, current.roleName);
  if (current.executionAuthority !== "delivery"
    || set?.sessions[current.agentId]?.effective.profileAccess !== "write") {
    throw new Error("Agent Job management requires a current writable delivery Session.");
  }
}

function requireManager(store: TaskStore, job: JobDefinition, caller: DurableJobCaller, write = true): void {
  authorizeScope(store, job.scope, caller, true);
  if (caller.scope === "task" && caller.role !== "leader") throw new Error("Only the Task Leader manages Agent Jobs.");
  if (write) requireWritableTaskManager(store, caller);
}

function ownedRole(store: TaskStore, home: string, job: JobDefinition, runId: string, now: Date): JobAgentRecipient {
  if (job.configuration.kind !== "agent" || job.configuration.target.kind !== "job") throw new Error("Not a Job-owned Agent.");
  const isolated = job.configuration.concurrency === "isolated";
  const name = jobAgentRoleName(job.scope, job.id, isolated ? runId : undefined);
  const workspace = join(home, "workspaces", "job-agents", name);
  const jobOwner = { scope: job.scope, jobId: job.id, ...(isolated ? { runId } : {}) };
  const existing = store.getGlobalRole(name);
  if (existing) {
    if (!isDeepStrictEqual(existing.jobOwner, jobOwner) || existing.activeAgentId !== job.configuration.target.agentId) {
      throw new Error("Job Role binding changed; inspect its Session/configuration before dispatch.");
    }
  } else {
    const agent = store.getConfiguredAgent(job.configuration.target.agentId);
    if (!agent) throw new Error("Job Agent is not configured.");
    const role = createGlobalRole(name, [createRoleAgentBinding(agent)], agent.id,
      workspace, now, {
        description: `Execution Agent owned by Job ${jobScopeKey(job.scope)}/${job.id}.`,
        responsibilities: ["Read the exact JobRun context from its original queued message. Preserve its input, results and evidence independently of this conversation."],
        constraints: ["No Operator authority, Task creation/delegation authority, or implicit Project write access.",
          "Delivery and native Turn completion are not Job business completion. Report only the exact claimed Run.",
          "On cancellation stop this Run's work only. Never replay unknown effects; continuation preserves the same Run."],
        expectedOutput: "Use job run-claim and run-context, then job run-report for an explicit business result; acknowledge the original inbox message with its concrete disposition."
      }, "write");
    store.createGlobalRoleIfAbsent({ ...role, jobOwner });
  }
  mkdirSync(workspace, { recursive: true });
  return { scope: "global", roleName: name };
}

function queueAttempt(store: TaskStore, home: string, job: JobDefinition, runId: string, index: number, now: Date): JobAgentAttempt {
  if (job.configuration.kind !== "agent") throw new Error("Not an Agent Job.");
  const target = job.configuration.target;
  const recipient: JobAgentRecipient = target.kind === "operator" ? { scope: "global", roleName: "operator" }
    : target.kind === "task" ? { scope: "task", taskId: target.taskId, roleName: target.roleName,
      ...(target.ownerRunId === undefined ? {} : { ownerRunId: target.ownerRunId }) }
    : ownedRole(store, home, job, runId, now);
  const selector = `${job.scope.kind === "global" ? "--global" : `--task ${job.scope.taskId}`} --job ${job.id} --run ${runId}`;
  const body = `JobRun ${runId}, continuation ${index}. Read durable input, not this notification as requirements.\n`
    + `Claim this exact call: yui job run-claim ${selector} --json\n`
    + `Read full context: yui job run-context ${selector} --json\n`
    + `Report explicit business outcome with yui job run-report ${selector} --result '<JobBusinessResult JSON>' --json.\n`
    + "Do not replay unknown effects or treat Turn completion as success. Preserve existing Role/Task/Assignment/resource boundaries. Check cancellation before effects.";
  const inputControl = { action: "queue" as const, requestId: `job-agent:${runId}:${index}` };
  let messageId: string;
  if (recipient.scope === "global") {
    messageId = store.nextGlobalRoleMessageId();
    let message = createGlobalRoleMessage(messageId, recipient.roleName, body, "system", { type: "system" }, now, { inputControl });
    const set = store.getGlobalRoleSessionSet(recipient.roleName);
    const session = set?.sessions[set.activeAgentId];
    if (session) message = { ...message, deliveryTarget: { agentId: session.agentId, nativeSessionId: session.nativeSessionId } };
    store.saveGlobalRoleMessage(message);
  } else {
    requireTaskTarget(store, { ...recipient });
    const resolved = taskRecipient(store, recipient);
    messageId = store.nextMessageId(recipient.taskId);
    store.saveMessage(recipient.taskId, createTaskMessage(messageId, recipient.taskId, body, "system", { type: "system" }, now,
      { ...(resolved.ownerRunId ? { recipient: resolved } : {}), inputControl }));
    enqueueWork(store, resolved.ownerRunId ? { kind: "task", taskId: recipient.taskId }
      : { kind: "role", taskId: recipient.taskId, roleName: "leader" },
    resolved.ownerRunId ? "message-continuation" : "job-agent-input", now,
    [{ type: "message", taskId: recipient.taskId, id: messageId }], { dedupeKey: `message:${recipient.taskId}:${messageId}` });
  }
  return { messageId, recipient, createdAt: now.toISOString() };
}

function sessionsFor(store: TaskStore, recipient: JobAgentRecipient) {
  return recipient.scope === "global" ? store.getGlobalRoleSessionSet(recipient.roleName)
    : store.getTaskRoleSessionSet(recipient.taskId, recipient.roleName);
}

/** Only an actual delivery of the original message can claim this execution. */
function currentExecution(store: TaskStore, run: AgentJobRun, caller: DurableJobCaller) {
  const attempt = run.attempts.at(-1)!;
  const recipient = attempt.recipient;
  if (caller.scope !== recipient.scope || caller.role !== recipient.roleName
    || recipient.scope === "task" && caller.taskId !== recipient.taskId) throw new Error("Caller is not this Run's execution target.");
  assertCallerAuthorized(store, caller, recipient.scope === "task" ? recipient.taskId : "");
  if (recipient.scope === "task") requireTaskTarget(store, recipient);
  else {
    const role = store.getGlobalRole(recipient.roleName);
    if (role) assertJobRoleRunnable(store, role);
  }
  const binding = sessionsFor(store, recipient)?.providerBinding;
  const turn = binding?.run;
  if (!binding || !turn || turn.status !== "accepted" || !turn.nativeTurnId
    || currentProviderConversation(binding).conversationId !== caller.nativeSessionId) {
    throw new Error("An exact accepted native Turn is required; inspect the original delivery.");
  }
  if (!jobAttemptOwnsInput(store, attempt, binding)) throw new Error("Current Turn does not own the original Job message; unrelated work cannot claim this Run.");
  return { nativeSessionId: caller.nativeSessionId!, attemptId: turn.attemptId, nativeTurnId: turn.nativeTurnId };
}

function observeAttempt(store: TaskStore, run: AgentJobRun, now: Date): AgentJobRun {
  const attempt = run.attempts.at(-1)!;
  const binding = sessionsFor(store, attempt.recipient)?.providerBinding;
  recordJobAgentObservation(store, attempt.recipient, binding, now);
  return store.getAgentJobRun(run.id)!;
}

/** No transport or second scheduler: original Role messages own delivery and retry. */
export function controlAgentJob(store: TaskStore, home: string, job: JobDefinition, input: {
  op: string; caller: DurableJobCaller; runId?: string; trigger?: JobTrigger; retryOf?: string; result?: JobBusinessResult; expectedSessionId?: string; expectedAttemptId?: string;
}, now: Date): unknown {
  const { caller, op } = input;
  authorizeAgentDefinition(store, job, caller, false);
  const history = () => store.listAgentJobRuns(job.scope, job.id).filter(run => {
    const role = caller.scope === "global" ? store.getGlobalRole(caller.role ?? "") : null;
    if (role?.jobOwner?.runId && role.jobOwner.runId !== run.id) return false;
    try { authorizeAgentDefinition(store, { ...job, configuration: run.configuration }, caller, false); return true; }
    catch { return false; }
  });
  if (op === "show") return { ...job, results: summarizeAgentRuns(history()) };
  if (op === "runs") return history();
  if (["session-inspect", "session-create", "session-stop", "session-new"].includes(op)) {
    requireManager(store, job, caller, op !== "session-inspect");
    if (job.configuration.kind !== "agent" || job.configuration.target.kind !== "job") throw new Error("This Job uses a shared Role; inspect that Role's existing Session.");
    if (job.configuration.concurrency === "isolated" && !history().some(run => run.id === input.runId)) throw new Error("Isolated Session operations require an exact existing Run.");
    const roleName = jobAgentRoleName(job.scope, job.id, job.configuration.concurrency === "isolated" ? input.runId : undefined);
    if (op === "session-create") {
      authorizeAgentDefinition(store, job, caller, true);
      ownedRole(store, home, job, input.runId ?? "", now);
    }
    const role = store.getGlobalRole(roleName);
    if (op === "session-stop") {
      const set = store.getGlobalRoleSessionSet(roleName);
      const current = set?.sessions[set.activeAgentId];
      if (!current || !input.expectedSessionId || current.nativeSessionId !== input.expectedSessionId) throw new Error("Inspect and select the exact Job-owned Session before stopping.");
      if (set?.providerBinding?.run && !["completed", "failed", "cancelled", "rejected"].includes(set.providerBinding.run.status)) {
        throw new Error("Job Session has an active or unknown native Turn; cancel/settle that exact call before stopping.");
      }
      const target = runtimeLifecycleTarget({ scope: "global", roleName });
      enqueueWork(store, target, RUNTIME_CLEANUP_REQUIRED_REASON, now, []);
      return { status: "accepted", roleName, nativeSessionId: current.nativeSessionId,
        boundary: "Cleanup requested, not yet proven stopped. Inspect the Session before replacement." };
    }
    if (op === "session-new") {
      if (!role) throw new Error("Create the Job Role first.");
      assertRoleRuntimeMutationAllowed(store, { scope: "global", roleName }, "Job Session replacement");
      const set = store.getGlobalRoleSessionSet(roleName);
      const old = set?.sessions[set.activeAgentId];
      if (!set || !old || !input.expectedSessionId || old.nativeSessionId !== input.expectedSessionId) throw new Error("Job Session changed; inspect and supply its exact expectedSessionId.");
      if (providerRetryPending(set.providerBinding)) throw new Error("Existing bounded Provider recovery owns this input; inspect its retry evidence before replacement.");
      if (old.status !== "ended" || set.providerBinding?.run
        && !["completed", "failed", "cancelled", "rejected"].includes(set.providerBinding.run.status)) throw new Error("Old Job Session is not proven stopped; preserve its writer and unknown effects.");
      for (const pending of history().filter(run => !run.businessResult)) {
        const observed = observeAttempt(store, pending, now);
        if (!observed.attempts.at(-1)?.terminal) throw new Error("Unsettled Job input prevents replacement; inspect its original delivery.");
      }
      // Shared Role lifecycle history, not a second conversation registry.
      store.saveGlobalRoleSessionSet(prepareOperatorNewSession(set, role.activeAgentId, now));
    }
    return { role, sessions: role ? sessionsFor(store, { scope: "global", roleName }) : null,
      operations: { enter: `yui session enter ${roleName}`, inspect: `yui config role show ${roleName}` },
      boundary: "Use existing exact Role lifecycle operations. Replacement never proves an old Run stopped or authorizes replay." };
  }
  if (op === "run") {
    requireManager(store, job, caller);
    authorizeAgentDefinition(store, job, caller, true);
    const trigger = input.trigger;
    if (!trigger || !["manual", "retry"].includes(trigger.source) || !trigger.key.trim()) throw new Error("Agent Run requires a manual/retry trigger identity.");
    const runs = history();
    const same = runs.find(run => isDeepStrictEqual(run.trigger, trigger));
    if (same) {
      if (same.definitionRevision !== job.revision || same.retryOf !== input.retryOf) throw new Error("Agent Job trigger conflicts with its original snapshot.");
      return { run: same, created: false };
    }
    if (job.configuration.kind !== "agent") throw new Error("Not an Agent Job.");
    const occupied = runs.find(run => !run.businessResult || run.status === "unknown-needs-attention");
    if (occupied && job.configuration.concurrency !== "isolated") return { run: occupied, created: false, reason: "overlap" };
    if (input.retryOf && !runs.some(run => run.id === input.retryOf
      && ["failed", "cancelled", "timed-out"].includes(run.status))) throw new Error("Retry requires an exact failed/cancelled/timed-out Agent Run.");
    const id = `job-${randomUUID()}`;
    const run: AgentJobRun = { schemaVersion: 1, executor: "agent", id, scope: job.scope,
      definitionId: job.id, definitionRevision: job.revision, configuration: structuredClone(job.configuration),
      trigger: structuredClone(trigger), ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      status: "queued", createdAt: now.toISOString(), updatedAt: now.toISOString(),
      attempts: [queueAttempt(store, home, job, id, 0, now)] };
    store.saveAgentJobRun(run);
    return { run, created: true };
  }
  let run = history().find(run => run.id === input.runId);
  if (!run) throw new Error("Exact Agent JobRun not found.");
  // Read historical execution under its original target, not a revised definition.
  authorizeAgentDefinition(store, { ...job, configuration: run.configuration }, caller, false);
  if (op === "run-get" || op === "run-context" || op === "run-result") return {
    ...run, ...(op === "run-context" ? { history: history().slice(-16).map(r => ({ id: r.id, status: r.status,
      result: r.businessResult ? { outcome: r.businessResult.outcome, summary: r.businessResult.summary.slice(0, 512) } : null })),
      historyRead: `yui job runs ${job.scope.kind === "global" ? "--global" : `--task ${job.scope.taskId}`} --job ${job.id} --json`,
      authority: "Only the saved input within the selected Role's existing authority. No implicit Task/Project or external-resource grants." } : {})
  };
  if (op === "run-evidence") return { runId: run.id, scope: run.scope, attempts: run.attempts,
    delivery: run.attempts.map(attempt => attempt.recipient.scope === "global"
      ? store.queryGlobalRoleMessages(attempt.recipient.roleName, { id: attempt.messageId, limit: 1 }).messages[0] ?? null
      : store.listMessages(attempt.recipient.taskId).find(m => m.id === attempt.messageId) ?? null), businessResult: run.businessResult ?? null };
  if (op === "run-confirm") return observeAttempt(store, run, now);
  if (op === "run-claim" || op === "run-report") {
    const execution = currentExecution(store, run, caller);
    run = observeAttempt(store, run, now);
    const last = run.attempts.at(-1)!;
    if (last.execution && !isDeepStrictEqual(last.execution, execution)) throw new Error("This native attempt does not own the Run; use explicit safe continuation.");
    if (op === "run-report") {
      if (!last.execution) throw new Error("Claim the exact Run before reporting its result.");
      const result = validateBusinessResult(input.result!, { scope: run.scope, runId: run.id });
      if (run.businessResult) {
        if (!isDeepStrictEqual(run.businessResult, result)) throw new Error("Job business result is immutable.");
        return run;
      }
      run = { ...run, status: result.outcome, businessResult: structuredClone(result), terminalAt: now.toISOString(), updatedAt: now.toISOString() };
    } else if (!last.execution) run = { ...run, status: "running", updatedAt: now.toISOString(),
      attempts: [...run.attempts.slice(0, -1), { ...last, execution }] };
    store.saveAgentJobRun(run);
    return run;
  }
  requireManager(store, job, caller);
  if (op === "run-cancel") {
    if (run.businessResult || run.cancelRequestedAt) return run;
    const next = { ...run, cancelRequestedAt: now.toISOString(), updatedAt: now.toISOString() };
    store.saveAgentJobRun(next);
    return next; // Cooperative exact-call cancellation; never stop the shared Role.
  }
  if (op === "run-continue") {
    // Reconciliation of a repeated command returns the already-created
    // successor, even if it has since finished. Never create another input.
    if (input.expectedAttemptId && run.attempts.slice(0, -1).some(attempt =>
      attempt.execution?.attemptId === input.expectedAttemptId)) return run;
    run = observeAttempt(store, run, now);
    if (providerRetryPending(sessionsFor(store, run.attempts.at(-1)!.recipient)?.providerBinding)) {
      throw new Error("Existing bounded Provider recovery owns this input; do not submit a competing continuation.");
    }
    if (run.businessResult || !run.attempts.at(-1)!.terminal) throw new Error("Continuation requires a proven exact prior native terminal and an unfinished business result. Unknown effects must not be replayed.");
    if (!input.expectedAttemptId || run.attempts.at(-1)!.execution?.attemptId !== input.expectedAttemptId) {
      throw new Error("Inspect the last native terminal and supply its exact expectedAttemptId before continuation.");
    }
    const snapshot = { ...job, configuration: run.configuration };
    authorizeAgentDefinition(store, snapshot, caller, true);
    const next: AgentJobRun = { ...run, status: "queued", updatedAt: now.toISOString(),
      attempts: [...run.attempts, queueAttempt(store, home, snapshot, run.id, run.attempts.length, now)] };
    store.saveAgentJobRun(next);
    return next;
  }
  throw new Error(`Unsupported Agent Job operation: ${op}.`);
}

export function summarizeAgentRuns(runs: AgentJobRun[]) {
  const ordered = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const summary = (run: AgentJobRun | undefined) => run ? {
    runId: run.id, sourceRun: { scope: run.scope, runId: run.id }, status: run.status,
    outcome: run.businessResult?.outcome ?? null, summary: run.businessResult?.summary.slice(0, 512) ?? null
  } : null;
  return { latest: summary(ordered[0]), latestSuccessful: summary(ordered.find(run => run.businessResult?.outcome === "succeeded")) };
}
