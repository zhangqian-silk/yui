import assert from "node:assert/strict";
import test from "node:test";
import { workerEnvelope, selfAcceptanceDenied } from "./native-worker.mjs";

test("Worker uses only its exact native AgentRun envelope", () => {
  const input = text => ({ input: [{ type: "text", text }] });
  assert.deepEqual(workerEnvelope(input("Manifest pointer\n task=ignored\n"
    + "task=task-1 run=run-3 role=reader\nOther guidance"), "task-1", "reader"),
  { taskId: "task-1", runId: "run-3", roleName: "reader" });
  assert.throws(() => workerEnvelope(input("task=task-2 run=run-3 role=reader"), "task-1", "reader"), /mismatch/);
  assert.throws(() => workerEnvelope(input("task=task-1 run=run-3 role=writer"), "task-1", "reader"), /mismatch/);
  assert.throws(() => workerEnvelope(input("task=task-1 run=run-3 role=reader\n"
    + "task=task-1 run=run-4 role=reader"), "task-1", "reader"), /ambiguous/);
  assert.throws(() => workerEnvelope(input("wake only"), "task-1", "reader"), /Missing/);
});

test("self-acceptance needs an original authority diagnosis, not failure or command wording", () => {
  const response = message => ({ exitCode: 2, stderr: JSON.stringify({
    ok: false, details: { diagnostic: { causes: [{ message }] } }
  }) });
  assert.equal(selfAcceptanceDenied(response("Work Item is not awaiting acceptance.")), false);
  assert.equal(selfAcceptanceDenied({ exitCode: 2, stderr: "Forbidden self-acceptance probe: timed out" }), false);
  assert.equal(selfAcceptanceDenied(response(
    "A managed Task Session may perform this action only as the matching Leader: task-1.")), true);
});
