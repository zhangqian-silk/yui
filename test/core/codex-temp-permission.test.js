import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentAdapter } from "../../dist/executor/agentAdapter.js";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRoleAgentBinding } from "../../dist/role/role.js";
import { parseRoleOptions, patchRoleAgentBinding, roleOptionSpecs } from "../../dist/commands/roleConfiguration.js";
import { CodexAppServerRuntime } from "../../dist/runtime/codexAppServerRuntime.js";

const adapter = resolveAgentAdapter("codex");
const agent = createConfiguredAgent("fixture", "codex", "false", [], [], new Date("2026-10-25"));
const patch = (binding, args) => patchRoleAgentBinding(binding,
  parseRoleOptions(args, roleOptionSpecs({ update: true })));

test("Codex temp exclusions are explicit workspace-write settings, compiled per thread without daemon overrides", async () => {
  const initial = createRoleAgentBinding(agent);
  const binding = patch(initial, ["--sandbox", "workspace-write", "--approval", "never",
    "--exclude-tmpdir-env-var", "true", "--exclude-slash-tmp", "false"]);
  assert.deepEqual(binding.config.permission, {
    strategy: "configured", sandbox: "workspace-write", approval: "never",
    excludeTmpdirEnvVar: true, excludeSlashTmp: false
  });
  const requests = [];
  const runtime = new CodexAppServerRuntime({
    async request(method, params) {
      if (method === "thread/turns/list") {
        assert.equal(params.threadId, "native-id");
        assert.equal(params.itemsView, "notLoaded");
        assert.equal(params.limit, 1);
        return { data: [], nextCursor: null };
      }
      requests.push({ method, params });
      return { thread: { id: "native-id", status: { type: "idle" }, turns: [] } };
    }
  });
  for (const mode of ["new", "resume"]) {
    const launch = adapter.compileManagedControl({ agent, config: binding.config, workspace: "/fixture/work" }, mode, "native-id");
    assert.deepEqual(launch.codexThread.config.sandbox_workspace_write, {
      exclude_tmpdir_env_var: true, exclude_slash_tmp: false
    });
    assert.equal(launch.codexThread.sandbox, "workspace-write");
    assert.equal(launch.argv.some(value => /exclude_(tmpdir|slash)/.test(value)), false);
    if (mode === "new") await runtime.openConversation({ ...launch.codexThread, cwd: "/fixture/work" });
    else await runtime.resumeConversation("native-id", { ...launch.codexThread, cwd: "/fixture/work" });
  }
  assert.deepEqual(requests.map(request => request.method), ["thread/start", "thread/resume"]);
  for (const { params } of requests) assert.deepEqual(params.config.sandbox_workspace_write, {
    exclude_tmpdir_env_var: true, exclude_slash_tmp: false
  });
  const interactive = adapter.compileNew({ agent, config: binding.config, workspace: "/fixture/work" });
  assert.ok(interactive.argv.includes("sandbox_workspace_write.exclude_tmpdir_env_var=true"));
  assert.ok(interactive.argv.includes("sandbox_workspace_write.exclude_slash_tmp=false"));
  const cleared = patch(binding, ["--clear-exclude-tmpdir-env-var", "--clear-exclude-slash-tmp"]);
  assert.deepEqual(cleared.config.permission, {
    strategy: "configured", sandbox: "workspace-write", approval: "never"
  });
  assert.equal(adapter.compileManagedControl({ agent, config: cleared.config, workspace: "/fixture/work" }, "new")
    .codexThread.config.sandbox_workspace_write, undefined, "Omission preserves native defaults, not false.");
  assert.throws(() => patch(binding, ["--sandbox", "read-only"]), /workspace-write/);
  assert.throws(() => patch(initial, ["--exclude-slash-tmp", "true"]), /workspace-write/);
  assert.throws(() => patch(binding, ["--exclude-slash-tmp", "yes"]), /true.*false/);
  assert.throws(() => patch(binding, ["--exclude-slash-tmp", "true", "--clear-exclude-slash-tmp"]), /cannot/);
  assert.throws(() => patch(binding, ["--permission-strategy", "bypass", "--exclude-slash-tmp", "true"]), /cannot/);
  const claude = createRoleAgentBinding(createConfiguredAgent("other", "claude", "false", [], [], new Date("2026-10-25")));
  assert.throws(() => patch(claude, ["--exclude-slash-tmp", "true"]), /Codex/);
  for (const permission of [
    { strategy: "configured", sandbox: "workspace-write", excludeSlashTmp: "true" },
    { strategy: "configured", sandbox: "danger-full-access", excludeTmpdirEnvVar: false },
    { strategy: "bypass", excludeSlashTmp: true }
  ]) assert.throws(() => adapter.canonicalizeConfig({ adapterId: "codex", permission }));
});
