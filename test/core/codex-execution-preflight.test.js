import test from "node:test";
import assert from "node:assert/strict";
import { executionProbeParameters, preflightCodexExecution } from "../../scripts/lib/codex-execution-preflight.mjs";

test("execution preflight preserves native sandbox and scoped environment, never substitutes a model Turn", async () => {
  const input = {
    startup: { cwd: "/fixture/work", sandbox: { type: "workspaceWrite", writableRoots: ["/fixture/work"], networkAccess: false },
      approvalPolicy: "never" },
    environment: { YUI_SESSION_MANIFEST: "/fixture/manifest.json", YUI_TASK_ID: "task-1", YUI_HOME: "/fixture/home" },
    node: "/bin/node", fixture: "/fixture/work/input.json", output: "/fixture/work/proof.json"
  };
  const calls = [];
  const result = await preflightCodexExecution(async (method, parameters) => {
    calls.push({method, parameters});
    return {exitCode: 0, stdout: '{"taskId":"task-1"}', stderr: ""};
  }, input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "command/exec");
  assert.deepEqual(calls[0].parameters.sandboxPolicy, input.startup.sandbox);
  assert.deepEqual(calls[0].parameters.env, input.environment);
  assert.equal(result.proof.taskId, "task-1");
  let count = 0;
  await assert.rejects(preflightCodexExecution(async () => {
    count++;
    return {exitCode: 1, stdout: "", stderr: "bwrap: loopback: Failed RTM_NEWADDR"};
  }, input), /Native execution preflight failed.*workspaceWrite/);
  assert.equal(count, 1, "No retry or permission downgrade");
  assert.throws(() => executionProbeParameters({...input, output: "/other/proof.json"}), /inside/);
  assert.throws(() => executionProbeParameters({...input, startup: {cwd: "/fixture/work"}}), /receipt/);
});
