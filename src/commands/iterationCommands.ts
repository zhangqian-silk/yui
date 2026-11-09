import { openTaskArtifactRepository } from "../artifacts/taskArtifactRepository.js";
import { openIteration, validateKnowledge, type KnowledgeRef, type Experiment } from "../iteration/iteration.js";
import { taskLocalActor, assertTaskDeliveryAuthority } from "../task/taskAuthority.js";
import { requireManagedTaskCaller, requireManagedGlobalCaller } from "../runtime/managedCaller.js";
import type { TaskStore } from "../storage/taskStore.js";
import { parseMultiValueTail } from "./taskCommandSupport.js";

/** Knowledge operations never launch an execution or infer resource permission. */
export async function runIterationCommand(args: string[], store: TaskStore, environment: NodeJS.ProcessEnv) {
  const [action, taskId, ...tail] = args;
  const task = taskId === undefined ? null : store.getTask(taskId);
  if (!task || !taskId) throw new Error("Iteration Task is unavailable.");
  if (store.getRole(taskId, "leader")?.template !== "experiment-leader") {
    throw new Error("Iteration commands require an explicitly selected ExperimentLeader Task.");
  }
  const parsed = parseMultiValueTail(tail, new Set(["--request-id", "--expected-head", "--experiment", "--cursor"]), new Set(),
    "yui task iteration overview|read|save <task> [<json>] [--experiment <ref-json>]");
  const repo = openTaskArtifactRepository(store.rootDirectory(), taskId, () => store.getConfig());
  const knowledge = openIteration(repo);
  let worker: ReturnType<typeof requireManagedTaskCaller> | undefined;
  let assigned: Experiment | undefined;
  let assignmentRef: KnowledgeRef | undefined;
  if (environment.YUI_SESSION_SCOPE === "task" && environment.YUI_ROLE !== "leader") {
    worker = requireManagedTaskCaller(store, environment);
    const run = worker.currentRunId === undefined ? null : store.getRun(taskId, worker.currentRunId);
    const reference = parsed.options.get("--experiment");
    if (worker.taskId !== taskId || !run?.workItemId || run.purpose !== "execution" || !reference) {
      throw new Error("Worker iteration access requires its current execution Assignment and --experiment.");
    }
    assignmentRef = JSON.parse(reference);
    const value = await knowledge.read(assignmentRef!);
    if (value.kind !== "experiment" || !value.workItemIds?.includes(run.workItemId)) {
      throw new Error("Experiment is outside this Assignment.");
    }
    assigned = value;
  } else {
    if (environment.YUI_SESSION_SCOPE === "global") requireManagedGlobalCaller(store, environment);
    taskLocalActor(store, environment, taskId);
  }
  const equal = (left: KnowledgeRef, right: KnowledgeRef) => left.taskId === right.taskId
    && left.kind === right.kind && left.id === right.id && left.commit === right.commit;
  const authorizeRead = async (reference: KnowledgeRef) => {
    const value = await knowledge.read(reference);
    if (assigned && assignmentRef) {
      const allowed = equal(reference, assignmentRef) || equal(reference, assigned.plan)
        || value.kind === "execution" && equal(value.experiment, assignmentRef);
      if (!allowed) throw new Error("Knowledge reference is outside this Assignment.");
    }
    return value;
  };
  if (action === "init" && parsed.positionals.length === 0 && !worker) {
    if (!["draft", "active"].includes(task.status) || task.executionGate.state !== "enabled") {
      throw new Error("Initialize knowledge only in an open enabled Task.");
    }
    await repo.ensure();
    return { taskId, commit: await repo.head() };
  }
  if (action === "overview" && parsed.positionals.length === 0) {
    if (assigned) return { taskId, commit: await repo.head(), experiment: assignmentRef, value: assigned };
    return knowledge.overview(parsed.options.get("--cursor"));
  }
  if (action === "read" && parsed.positionals.length === 1) {
    const reference = JSON.parse(parsed.positionals[0]) as KnowledgeRef;
    const value = await authorizeRead(reference);
    return { ref: reference, value };
  }
  if (action === "compare" && parsed.positionals.length === 2) {
    const references = parsed.positionals.map(value => JSON.parse(value) as KnowledgeRef);
    const [left, right] = await Promise.all(references.map(authorizeRead));
    const leftFields = left as unknown as Record<string, unknown>;
    const rightFields = right as unknown as Record<string, unknown>;
    return { references, differences: [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter(key => JSON.stringify(leftFields[key]) !== JSON.stringify(rightFields[key]))
      .map(key => ({ field: key, left: leftFields[key] ?? null, right: rightFields[key] ?? null })),
    interpretation: "Differences are observations, not a comparability or improvement verdict." };
  }
  if (action !== "save" || parsed.positionals.length !== 1) throw new Error("Invalid iteration command arguments.");
  if (!["draft", "active"].includes(task.status) || task.executionGate.state !== "enabled") {
    throw new Error("Iteration mutations require an open Task with execution enabled.");
  }
  const record = validateKnowledge(JSON.parse(parsed.positionals[0]));
  if (record.kind === "execution" || record.kind === "analysis") {
    if (task.status !== "active") throw new Error("Execution evidence requires an active Task.");
    if (!worker) assertTaskDeliveryAuthority(store, environment, taskId);
  }
  if (worker) {
    if (record.kind !== "execution" || !assignmentRef || !equal(record.experiment, assignmentRef)
      || record.runId !== worker.currentRunId) {
      throw new Error("Workers may submit only execution evidence for their exact current Run and assigned experiment.");
    }
  }
  if (record.kind === "experiment") {
    for (const id of record.workItemIds ?? []) {
      if (!store.getWorkItem(taskId, id)) throw new Error("Experiment WorkItem is unavailable in this Task.");
    }
  }
  if (record.kind === "execution" && record.runId && !store.getRun(taskId, record.runId)) {
    throw new Error("Execution Run is unavailable in this Task.");
  }
  if (record.kind === "execution" && record.jobRunId) {
    const job = store.getDurableJob(taskId, record.jobRunId);
    const agentJob = store.getAgentJobRun(record.jobRunId);
    if (!job && !(agentJob?.scope.kind === "task" && agentJob.scope.taskId === taskId)) {
      throw new Error("Execution JobRun is unavailable in this Task.");
    }
  }
  if (record.kind === "plan" && record.source) {
    if (!store.getTask(record.source.taskId)) throw new Error("Source plan Task is unavailable.");
    const source = await openIteration(openTaskArtifactRepository(store.rootDirectory(), record.source.taskId,
      () => store.getConfig())).read(record.source);
    if (source.kind !== "plan") throw new Error("Reusable source must be a fixed plan.");
  }
  if (record.kind === "analysis" && record.decisionId && !store.getDecision(taskId, record.decisionId)) {
    throw new Error("Analysis Decision is unavailable in this Task.");
  }
  const requestId = parsed.options.get("--request-id");
  const expectedHead = parsed.options.get("--expected-head");
  if (!requestId || !expectedHead) throw new Error("--request-id and --expected-head are required.");
  return knowledge.save({ requestId, expectedHead, record });
}
