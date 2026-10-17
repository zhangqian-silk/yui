import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask, activateTask, completeTask } from "../../dist/task/task.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createPublicationReference } from "../../dist/task/publicationReference.js";
import { createProject } from "../../dist/repository/project.js";
import { runTaskCommand } from "../../dist/commands/taskCommands.js";
import { projectTaskRemoteDeliveryFromStore, createTaskRemoteDeliveryProof, assertTaskRemoteDeliveryProof } from "../../dist/task/remoteDeliveryService.js";
import { buildWebTaskDetail } from "../../dist/web/webSnapshot.js";
import { readTaskContext, inspectTaskContext } from "../../dist/context/taskContext.js";
import { projectTaskRemoteDelivery } from "../../dist/task/remoteDelivery.js";

const now = new Date("2026-10-17T00:00:00Z");
const base = "a".repeat(40), head = "b".repeat(40);

test("Project scope changes preserve code facts, exact acceptance and current delivery across CLI/context/Web", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-delivery-scope-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["project-1", "project-2"]) store.saveProject(
    createProject(id, `app-${id}`, join(home, id), { stable: "master", development: "master" }, now));
  const task = completeTask(activateTask(createTask("task-1", "Scoped delivery", now, {
    projectBindings: ["project-1", "project-2"].map(projectId => ({
      projectId, directory: projectId, baseRef: "master", baseCommit: base, currentCommit: head
    }))
  }), now), now, { by: "user", summary: "Accepted result" });
  store.saveTask(task);
  const completion = createTaskEvent("event-1", task.id, "task.completed", {
    projectHeads: `project-1@${head},project-2@${head}`,
    projectBases: `project-1@${base},project-2@${base}`
  }, now);
  store.saveEvent(task.id, completion);
  store.saveMessage(task.id, createTaskMessage("message-1", task.id,
    "Only project-1 is required; exclude project-2. Restore project-2 if needed.",
    "user", { type: "user" }, now));
  store.savePublicationReference(task.id, createPublicationReference("publication-1", task.id, {
    projectId: "project-1", provider: "github", repository: "fixture/app", externalKind: "pull-request",
    externalId: "1", localCommit: head, state: "merged", verification: "verified", remoteCommit: "c".repeat(40)
  }, now));
  const run = args => runTaskCommand(args, store, { environment: {}, now: () => now });
  const delivery = () => projectTaskRemoteDeliveryFromStore(store, task);
  const change = (requirement, guard) => ["project", "delivery", task.id, "project-2",
    "--requirement", requirement, "--reason", "Final scope follows user's original instruction",
    "--source-message", "message-1", "--purpose", requirement === "excluded"
      ? "exclude project-2" : "Restore project-2 if needed", "--if-current", guard];
  assert.equal(delivery().integratedCoverageSatisfied, false);
  assert.throws(() => run(["project", "delivery", task.id, "project-2",
    "--requirement", "excluded", "--reason", "convenient", "--if-current", "none"]), /source-message/);
  const excluded = run(change("excluded", "none")).data;
  const scoped = delivery();
  assert.equal(scoped.integratedCoverageSatisfied, true);
  assert.equal(scoped.codeProjectCount, 2);
  assert.equal(scoped.requiredCodeProjectCount, 1);
  assert.equal(scoped.excludedProjectCount, 1);
  assert.equal(scoped.projects[1].codeDelivery, "code");
  assert.equal(scoped.projects[1].merged, false);
  assert.equal(scoped.projects[1].verified, false);
  assert.equal(scoped.projects[1].deliveryRequirement, "excluded");
  assert.equal(scoped.projects[1].scopeDecision.id, excluded.id);
  assert.deepEqual(buildWebTaskDetail(store, task.id).remoteDelivery, scoped);
  const ref = readTaskContext(store, task.id).records.find(r => r.ref.store === "remote-delivery").ref;
  assert.deepEqual(inspectTaskContext(store, task.id, ref).value, scoped);
  assert.deepEqual(run(["remote-delivery", task.id]).data, scoped);
  const proof = createTaskRemoteDeliveryProof(store, task);
  assert.throws(() => run(change("required", "none")), /changed/);
  run(change("required", excluded.id));
  assert.equal(delivery().integratedCoverageSatisfied, false);
  assert.throws(() => assertTaskRemoteDeliveryProof(store, task, proof), /evidence changed/);
  assert.deepEqual(store.getTask(task.id), task);
  assert.deepEqual(store.listEvents(task.id).find(e => e.id === completion.id), completion);
});

test("unchanged, excluded and unknown Projects remain distinct without inferred historical evidence", () => {
  const task = { id: "task-1", status: "completed", completedAt: now.toISOString(),
    projectBindings: [{ projectId: "project-1", directory: "app" }] };
  const completed = createTaskEvent("event-1", task.id, "task.completed", {
    projectHeads: `project-1@${base}`, projectBases: `project-1@${base}`
  }, now);
  const facts = { task, events: [completed], publications: [], managedWorkspaces: [], runs: [] };
  assert.equal(projectTaskRemoteDelivery(facts).status, "none");
  assert.equal(projectTaskRemoteDelivery(facts).projects[0].codeDelivery, "none");
  const missing = { ...facts, events: [] };
  assert.equal(projectTaskRemoteDelivery(missing).integratedCoverageSatisfied, false);
  const excluded = createTaskEvent("event-2", task.id, "task.project-delivery-decided", {
    projectId: "project-1", requirement: "excluded", reason: "No longer in delivery scope",
    sourceMessageId: "message-1", sourceDigest: "a".repeat(64), purpose: "exclude app", by: "leader"
  }, now);
  const scope = projectTaskRemoteDelivery({ ...missing, events: [excluded] });
  assert.equal(scope.status, "none");
  assert.equal(scope.integratedCoverageSatisfied, true);
  assert.equal(scope.projects[0].codeDelivery, "unknown");
  assert.equal(scope.projects[0].merged, false);
  assert.equal(scope.projects[0].verified, false);
  const restored = { ...excluded, id: "event-3", payload: { ...excluded.payload, requirement: "required" } };
  assert.equal(projectTaskRemoteDelivery({ ...missing, events: [restored, excluded] }).integratedCoverageSatisfied, false);
  assert.equal(projectTaskRemoteDelivery({ ...facts, events: [
    { ...completed, payload: { projectHeads: `project-1@${base}` } }
  ] }).projects[0].codeDelivery, "unknown", "missing base is not no change");
});
