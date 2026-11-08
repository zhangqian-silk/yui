import type { TaskStore } from "../storage/taskStore.js";
import { archiveExecutionChecks, archiveSettlementChecks } from "./archivePreflight.js";
import { taskLocalActor } from "./taskAuthority.js";
import { requireManagedGlobalCaller } from "../runtime/managedCaller.js";

export type TaskProcessData = Readonly<{
  taskId: string;
  scope: "telemetry-details";
  digest: string;
  telemetryRows: number;
  payloadBytes: number;
  preserved: readonly string[];
}>;

export type TaskProcessCleanupReceipt = Readonly<{
  taskId: string;
  requestId: string;
  digest: string;
  removedTelemetryRows: number;
  eventId: string;
}>;

/** Rechecked inside the deleting transaction, not merely at preview time.
 * Files and workspaces are outside this deliberately narrow operation. */
export function assertTaskProcessCleanupReady(store: TaskStore, taskId: string): void {
  const task = store.getTask(taskId);
  if (task === null) throw new Error(`Task not found: ${taskId}.`);
  if (task.status !== "archived") throw new Error("Process cleanup requires an archived Task.");
  const checks = [
    ...archiveSettlementChecks(store, task),
    ...archiveExecutionChecks(store, taskId, store.rootDirectory())
  ];
  for (const mailbox of store.listWorkMailboxes()) {
    const target = mailbox.target;
    const jobScope = target.kind === "global-role-runtime"
      ? store.getGlobalRole(target.roleName)?.jobOwner?.scope : undefined;
    const owned = "taskId" in target && target.taskId === taskId
      || jobScope?.kind === "task" && jobScope.taskId === taskId;
    if (owned && (mailbox.pending !== null || mailbox.processing !== null)) {
      throw new Error(`Process cleanup blocked by an unsettled ${target.kind} mailbox.`);
    }
  }
  if (checks.length !== 0) throw new Error(`Process cleanup blocked: ${checks[0]!.detail}`);
}

export type ProcessCleanupRequest =
  | { taskId: string; preview: true }
  | { taskId: string; preview: false; digest: string; requestId: string };

export function parseProcessCleanupArguments(args: readonly string[]): ProcessCleanupRequest {
  const usage = "Usage: yui task process-cleanup <task> --preview | "
    + "<task> --confirm <preview-digest> --request-id <id>. Scope: telemetry details only.";
  const taskId = args[0];
  if (!taskId || taskId.startsWith("--")) throw new Error(usage);
  if (args.length === 2 && args[1] === "--preview") return { taskId, preview: true };
  if (args.length === 5 && args[1] === "--confirm" && /^[a-f0-9]{64}$/.test(args[2]!)
    && args[3] === "--request-id" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(args[4]!)) {
    return { taskId, preview: false, digest: args[2]!, requestId: args[4]! };
  }
  throw new Error(usage);
}

export async function runTaskProcessCleanup(
  store: TaskStore,
  request: ProcessCleanupRequest,
  environment: NodeJS.ProcessEnv,
  assertPhysicalResourcesReleased: (taskId: string) => Promise<void>
) {
  const actor = taskLocalActor(store, environment, request.taskId);
  if (environment.YUI_SESSION_SCOPE === "global") requireManagedGlobalCaller(store, environment);
  if (request.preview) {
    const data = store.readTransaction(tx => {
      assertTaskProcessCleanupReady(tx, request.taskId);
      return tx.inspectTaskProcessData(request.taskId);
    });
    return { ...data, readOnly: true, authorizesCleanup: false,
      note: "Only telemetry details are selected. Apply rechecks execution and physical quiescence; no files or historical evidence are removed." };
  }
  // Runtime facts are inspected through the existing exact-owner checker.
  // The Store independently rechecks current durable facts and the preview
  // under its writer fence. Archived Tasks cannot launch new work.
  await assertPhysicalResourcesReleased(request.taskId);
  return store.transaction(tx => {
    taskLocalActor(tx, environment, request.taskId);
    if (environment.YUI_SESSION_SCOPE === "global") requireManagedGlobalCaller(tx, environment);
    return tx.clearTaskProcessData(request.taskId, request.digest, request.requestId, actor);
  });
}
