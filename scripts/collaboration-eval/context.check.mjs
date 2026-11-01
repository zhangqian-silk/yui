import test from "node:test";
import assert from "node:assert/strict";
import { measureFrames } from "./context-profile.mjs";
import { judgeContext } from "./context-oracle.mjs";

test("visible UTF-8, residence and recovery are separate, never token estimates", () => {
  const frames = [
    { stage: "entry", chunks: [{ kind: "notification", text: "中" }, { kind: "skill", text: "abc" }] },
    { stage: "continue", chunks: [{ kind: "context", text: "ab" }] },
    { stage: "recovery", reset: true, chunks: [{ kind: "skill", text: "abc" }] }
  ];
  const cost = measureFrames(frames);
  assert.equal(cost.newVisibleUtf8, 11);
  assert.equal(cost.newVisibleCharacters, 9);
  assert.deepEqual(cost.residentUtf8, [6, 8, 3]);
  assert.equal(cost.recoveryReloadUtf8, 3);
  assert.equal(cost.notificationUtf8, 3);
  assert.equal(cost.tokens, "unknown");
});

test("independent context score detects lost original and an analysis write", () => {
  const observation = {
    frames: [{ stage: "entry", chunks: [{ kind: "notification", text: "task-1 message-1" }] }],
    originals: [{ body: "Analysis only: preserve α.", id: "message-1", taskId: "task-1" }],
    source: { body: "Analysis only: preserve α.", id: "message-1", taskId: "task-1" },
    actionTrace: [{ phase: "query", args: ["--json", "task", "context", "task-1"], exitCode: 0 }],
    snapshots: [{ title: "Analysis only", status: "draft" }, { title: "Analysis only", status: "draft" }]
  };
  assert.equal(judgeContext(observation).status, "pending-human");
  assert.equal(judgeContext({ ...observation, originals: [] }).status, "fail");
  assert.equal(judgeContext({ ...observation, actionTrace: [{ phase: "write" }] }).status, "fail");
  assert.equal(judgeContext({ ...observation, snapshots: [observation.snapshots[0], { status: "active" }] }).status, "fail");
});
