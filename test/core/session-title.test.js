import assert from "node:assert/strict";
import test from "node:test";
import { taskRoleSessionTitle, operatorSessionTitle, resolveTaskRoleSessionTitle } from "../../dist/runtime/sessionTitle.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createGlobalRole, createRoleAgentBinding, copyGlobalRoleToTaskRole, updateGlobalRole, updateRole } from "../../dist/role/role.js";
import { parseRoleOptions, roleOptionSpecs, roleProfilePatch } from "../../dist/commands/roleConfiguration.js";

test("titles preserve Task identity and planning authority, independent of lifecycle", () => {
  const task = { id: "task-159", title: "会话标识优化", status: "active" };
  assert.equal(taskRoleSessionTitle(task, "leader", { executionAuthority: "planning", instanceCode: "北京-1" }),
    "Yui Leader task-159 Draft @北京-1 · 会话标识优化");
  assert.equal(taskRoleSessionTitle(task, "leader", { executionAuthority: "delivery" }),
    "Yui Leader task-159 · 会话标识优化");
  const old = "Yui Leader task-159 Draft @old · 会话标识优化";
  assert.equal(resolveTaskRoleSessionTitle(old, task, "leader", { generatedTitle: old, executionAuthority: "planning" }),
    "Yui Leader task-159 Draft · 会话标识优化");
  assert.equal(resolveTaskRoleSessionTitle("我的标题", task, "leader", { generatedTitle: old }), "我的标题");
  assert.equal(resolveTaskRoleSessionTitle(old, task, "leader"), old, "untagged historical titles remain untouched");
  const long = taskRoleSessionTitle({ ...task, title: "😀".repeat(30) }, "leader",
    { executionAuthority: "planning", instanceCode: "界".repeat(24) });
  assert.ok(long.length <= 80);
  assert.ok(long.startsWith(`Yui Leader task-159 Draft @${"界".repeat(24)}`));
  assert.ok(long.isWellFormed());
  assert.throws(() => taskRoleSessionTitle(task, "r".repeat(80)), /identity.*length/i);
  assert.equal(operatorSessionTitle(new Date("2026-11-02T00:00:00Z"), "UTC", "dev-bj"),
    "Yui Operator @dev-bj · 1102");
});

test("Role display configuration is independent, copied once, and does not change launch identity", () => {
  const now = new Date("2026-11-02T00:00:00Z");
  const binding = createRoleAgentBinding(createConfiguredAgent("codex", "codex", "codex", [], [], now));
  const roles = Object.fromEntries(["operator", "leader", "assistant"].map(name =>
    [name, createGlobalRole(name, [binding], "codex", "/workspace", now)]));
  const patch = args => roleProfilePatch(parseRoleOptions(args, roleOptionSpecs({ update: true })));
  for (const name of Object.keys(roles)) {
    const before = structuredClone(roles);
    const changed = updateGlobalRole(roles[name], patch(["--instance-code", `${name}-1`]), now);
    assert.equal(changed.instanceCode, `${name}-1`);
    assert.equal(changed.launchRevision, roles[name].launchRevision);
    for (const other of Object.keys(roles).filter(value => value !== name)) assert.deepEqual(roles[other], before[other]);
    roles[name] = changed;
  }
  const taskRole = copyGlobalRoleToTaskRole(roles.leader, "task-159", now);
  roles.leader = updateGlobalRole(roles.leader, patch(["--clear-instance-code"]), now);
  assert.equal(roles.leader.instanceCode, undefined);
  assert.equal(taskRole.instanceCode, "leader-1");
  assert.equal(updateRole(taskRole, patch(["--clear-instance-code"]), now).instanceCode, undefined);
  for (const value of ["", " a", "a b", "a\n", "@a", "\u001b", "x".repeat(25), "a\u202e", "a\\b", "😀"]) {
    assert.throws(() => patch(["--instance-code", value]), /Instance code/);
  }
  assert.throws(() => patch(["--instance-code", "one", "--clear-instance-code"]), /cannot be used together/);
});
