import assert from "node:assert/strict";
import test from "node:test";
import {
  authoredNotificationSummary, taskMessagePresentation, taskNotificationPresentation
} from "../../dist/interaction/notificationPresentation.js";
import { withSessionContextPointer } from "../../dist/context/sessionBootstrapManifest.js";

test("notification presentation is bounded, attributed and cannot turn reports into acceptance", () => {
  const text = "Yui-Summary: Tests failed; merge is not authorized.\n\nFull original report.";
  const run = { id: "run-1", purpose: "review", status: "failed", result: { output: text } };
  const message = { id: "message-1", taskId: "task-1", kind: "role-result",
    author: { type: "role", roleName: "reviewer" }, body: "Result pointer",
    createdAt: "2026-10-01T00:00:00.000Z",
    resultRef: { type: "agent-run-result", runId: run.id } };
  const presentation = taskMessagePresentation(message, () => run);
  assert.equal(presentation.summary, "Tests failed; merge is not authorized.");
  assert.equal(presentation.summarySource, "agent-run-result");
  assert.match(presentation.fact, /Review result.*failed.*pending/);
  const oversized = "Yui-Summary: " + "通过".repeat(100) + "; NOT VERIFIED";
  assert.equal(authoredNotificationSummary(oversized), undefined, "Never clip a trailing qualification.");
  assert.equal(authoredNotificationSummary("An unmarked report.\nYui-Summary: hidden line"), undefined);
  assert.equal(taskMessagePresentation(message, () => ({ ...run, result: { output: oversized } })).summary, undefined);
  const messages = Array.from({ length: 25 }, (_, i) => ({ ...message, id: `message-${i + 1}` }));
  const wake = { id: "wake-1", taskId: "task-1", reasons: ["role-result:run-1"],
    fromCursor: "2026-10-02T00:00:00.000Z", toCursor: "2026-10-02T00:01:00.000Z",
    refs: messages.map(m => ({ type: "message", taskId: "task-1", id: m.id })) };
  const store = { listMessages: () => messages, getRun: () => run };
  const notification = taskNotificationPresentation(wake, store);
  assert.match(notification, /21 more messages/);
  assert.match(notification, /yui task wake show task-1 wake-1 --json/);
  assert.ok(Buffer.byteLength(notification) < 4000);
  assert.equal(store.getRun().result.output, text);
  const first = withSessionContextPointer(notification, { YUI_SESSION_MANIFEST: "/exact/digest-one.json" });
  assert.equal(withSessionContextPointer(notification, { YUI_SESSION_MANIFEST: "/exact/digest-one.json" }), first,
    "No sent/read state can silently drop the recovery pointer.");
  const changed = withSessionContextPointer(notification, { YUI_SESSION_MANIFEST: "/exact/digest-two.json" });
  assert.ok(changed.includes("/exact/digest-two.json") && !changed.includes("/exact/digest-one.json"));
  assert.equal(withSessionContextPointer(notification, {}), notification);
});
