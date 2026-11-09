import assert from "node:assert/strict";
import test from "node:test";
import { modelCommandArguments, MODEL_COMMAND_ACTIONS } from "../../dist/commands/modelCommands.js";
import { modelOperatorGuide } from "../../dist/models/modelOperatorGuide.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";

test("model shortcuts preserve capability identity, exact input and request IDs without executing", () => {
  const input = { revision: "r1", requestId: "same-write", kind: "binding",
    resource: { agentId: "codex", endpointId: null, model: "", scope: "yui-new-session" } };
  const command = modelCommandArguments(["save", "--task", "task-150", "--input", JSON.stringify(input), "--request-id", "same-call"]);
  assert.deepEqual(command.slice(0, 2), ["call", "models.save"]);
  assert.deepEqual(JSON.parse(command[command.indexOf("--input") + 1]), { operation: "resource", input });
  assert.equal(command[command.indexOf("--task") + 1], "task-150");
  assert.equal(command[command.indexOf("--request-id") + 1], "same-call");
  for (const action of MODEL_COMMAND_ACTIONS) {
    const parsed = modelCommandArguments([action, "--task", "task-150", "--input", '{"requestId":"original"}']);
    assert.equal(parsed[1], `models.${action === "save-provider" ? "save" : action}`);
    assert.deepEqual(JSON.parse(parsed[parsed.indexOf("--input") + 1]), action === "read"
      ? { requestId: "original" } : action === "save" || action === "save-provider"
        ? { operation: action === "save" ? "resource" : "provider", input: { requestId: "original" } }
        : { input: { requestId: "original" } });
  }
  assert.deepEqual(modelCommandArguments(["read", "--task", "task-150"]), ["call", "models.read", "--task", "task-150", "--input", "{}"]);
  assert.throws(() => modelCommandArguments(["save", "--input", "{}"]), /task/i);
  assert.throws(() => modelCommandArguments(["save", "--task", "task-150"]), /input/i);
  assert.throws(() => modelCommandArguments(["save", "--task", "task-150", "--input", "[]"]), /object/i);
  assert.throws(() => modelCommandArguments(["save", "--task", "task-150", "--input", "{}", "--exclusive"]), /option/i);
  assert.equal(routeInvocation(["models", "guide", "metabridge"]).kind, "execute");
  const guide = modelOperatorGuide("metabridge");
  assert.ok(guide.manuals.includes("model-connection-tools.md"));
  assert.throws(() => modelOperatorGuide("unknown"), /topic/i);
});
