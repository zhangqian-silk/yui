// Disposable dashboard data only: never starts a Controller or Provider.
import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfiguredAgent } from "../dist/agent/agent.js";
import { createRun, completeRun, failRun } from "../dist/agentRun/agentRun.js";
import { createTaskBrief } from "../dist/brief/taskBrief.js";
import { contextContentDigest, contextSnapshotRef, createContextSnapshot } from "../dist/context/contextSnapshot.js";
import { createRunInput } from "../dist/context/runInputContract.js";
import { createDecision } from "../dist/decision/decision.js";
import { resolveEffectiveLaunch } from "../dist/executor/effectiveLaunch.js";
import { createInputRequest } from "../dist/input/inputRequest.js";
import { createTaskMessage } from "../dist/message/message.js";
import { createRole, createRoleAgentBinding } from "../dist/role/role.js";
import { SqliteTaskStore } from "../dist/storage/sqliteStore.js";
import { CURRENT_CONFIG_SCHEMA_VERSION } from "../dist/storage/taskStore.js";
import { activateTask, archiveTask, completeTask, createTask, retireTask } from "../dist/task/task.js";
import { createWorkItem } from "../dist/workItem/workItem.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const yuiHome = resolve(process.env.YUI_HOME ?? resolve(projectRoot, "output/dev/web-home"));
// Refuse even an empty pre-existing Home (and dangling symlinks): seeding is
// not an update operation, and has no authority over existing data.
if (existsSync(yuiHome) || lstatSync(yuiHome, { throwIfNoEntry: false }) !== undefined) {
  throw new Error(`Refusing to seed existing YUI_HOME: ${yuiHome}. Choose a new disposable directory.`);
}
mkdirSync(dirname(yuiHome), { recursive: true });
mkdirSync(yuiHome); // Exclusive claim: a concurrent seed cannot open the same Home.
const now = new Date();
const store = new SqliteTaskStore(yuiHome);
try {
  store.transaction(writer => {
    const agent = createConfiguredAgent("codex", "codex", "codex", [], [], now);
    writer.saveConfiguredAgent(agent);
    writer.saveConfig({ schemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
      defaultAgent: agent.id, defaultWorkspace: resolve(yuiHome, "workspaces/global") });
    const tasks = [
      activateTask(createTask("task-1", "Ship the dashboard", now,
        { description: "Disposable current-contract preview data.", priority: "high", tags: ["web"] }), now),
      activateTask(createTask("task-2", "Review deployment decision", now,
        { priority: "urgent", tags: ["input"] }), now),
      createTask("task-3", "Draft onboarding guide", now, { tags: ["docs"] }),
      completeTask(activateTask(createTask("task-4", "Verify terminal scrolling", now), now), now,
        { by: "leader", summary: "Demo completion." }),
      archiveTask(retireTask(createTask("task-5", "Retired prototype", now),
        { by: "leader", summary: "Demo retirement." }, now), now,
        { by: "user", reason: "Superseded.", summary: "Demo archive." }),
      activateTask(createTask("task-6", "Inspect a failed execution", now,
        { priority: "high", tags: ["failure"] }), now)
    ];
    for (const task of tasks) {
      writer.saveTask(task);
      const role = createRole(task.id, "leader", [createRoleAgentBinding(agent)],
        agent.id, resolve(yuiHome, "workspaces", task.id), now);
      writer.saveRole(task.id, role);
      writer.saveMessage(task.id, createTaskMessage("message-1", task.id,
        `Demo requirement: ${task.title}.`, "user", { type: "user" }, now));
      writer.saveTaskBrief(task.id, createTaskBrief({ objective: task.title,
        boundaries: ["Disposable fixture; no external actions"], currentFocus: "Inspect the dashboard",
        leaderSummary: "Synthetic preview, not execution evidence.", updatedBy: "leader" }, now));
      if (!["task-1", "task-2", "task-6"].includes(task.id)) continue;
      const item = createWorkItem("work-item-1", task.id,
        { title: "Inspect demo evidence", assignee: "leader" }, now);
      writer.saveWorkItem(task.id, item);
      const ref = { layer: "L2", store: "task", refId: task.id,
        revision: task.updatedAt, digest: contextContentDigest(task) };
      const snapshot = createContextSnapshot({ id: "snapshot-1", taskId: task.id,
        scope: "task", sequence: 1, refs: [ref], resources: [{ ref, value: task }],
        acceptRefs: [], frozenAt: now, frozenBy: "controller" });
      writer.saveContextSnapshot(snapshot);
      const run = createRun("run-1", task.id, role.name, "new", createRunInput({
        source: { type: "yui", channel: "workitem-dispatch" },
        contextSnapshotRef: contextSnapshotRef(snapshot), deltaRefIds: []
      }), now, { workItemId: item.id, effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
      writer.saveRun(task.id === "task-6"
        ? failRun(run, "runtime-failed", "Synthetic failure for dashboard preview.", now)
        : completeRun(run, "Synthetic result for dashboard preview.", now));
    }
    writer.saveInputRequest("task-2", createInputRequest("input-1", "task-2",
      { taskId: "task-2", roleName: "leader", agentId: agent.id, runId: "run-1" }, {
        question: "Which demo direction should we inspect?",
        choices: [{ key: "dense", label: "Dense overview" }, { key: "detail", label: "Task detail" }],
        blockedRefs: []
      }, now));
    writer.saveDecision("task-1", createDecision("decision-1", "task-1",
      "Keep one durable authority", "SQLite owns Task facts; the dashboard projects them.", now));
  });
  store.validateCurrentRecords();
  console.log(`Seeded disposable web dashboard at ${yuiHome}`);
} finally {
  store.close();
}
