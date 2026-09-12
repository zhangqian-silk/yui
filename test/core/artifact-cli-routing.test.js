import assert from "node:assert/strict";
import test from "node:test";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";

test("artifact file commands reach execution, including commit-pinned reads", () => {
  for (const args of [
    ["list", "task-1"],
    ["read", "task-1", "design/plan.md", "a".repeat(40)],
    ["save", "task-1", "design/plan.md", "plan", "--message", "update"]
  ]) {
    const invocation = routeInvocation(["task", "artifact", ...args]);
    assert.equal(invocation.kind, "execute");
    assert.equal(invocation.node.name, args[0]);
  }
});
