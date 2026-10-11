// Model-free native execution probe for explicitly selected disposable fixtures.
// The caller supplies the actual thread/start response and its shell environment.
// This module never starts a Thread/Turn, chooses permissions, or retries.
import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";

export function executionProbeParameters({ startup, environment, node, fixture, output }) {
  assert.ok(startup?.sandbox && typeof startup.sandbox.type === "string", "Native sandbox receipt required");
  assert.ok(isAbsolute(startup.cwd), "Native cwd required");
  assert.ok(isAbsolute(node), "Exact Node executable required");
  assert.ok(environment?.YUI_SESSION_MANIFEST, "Own Session Manifest required");
  for (const path of [fixture, output]) {
    const child = relative(startup.cwd, path);
    assert.ok(isAbsolute(path) && child && !child.startsWith("..") && !isAbsolute(child),
      "Probe files must be inside the disposable native workspace");
  }
  return {
    cwd: startup.cwd,
    sandboxPolicy: structuredClone(startup.sandbox),
    env: { ...environment },
    timeoutMs: 15000,
    outputBytesCap: 16384,
    command: [node, "--input-type=module", "-e", `
import assert from "node:assert/strict";
import fs from "node:fs";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
const manifest = JSON.parse(fs.readFileSync(process.env.YUI_SESSION_MANIFEST, "utf8"));
assert.equal(manifest.owner.scope, "task");
assert.equal(manifest.owner.taskId, process.env.YUI_TASK_ID);
const command = manifest.contextProtocol.currentCommand;
assert.equal(typeof command, "string");
assert.ok(command.length);
// A notification has no AgentRun: use the manifest's complete currentCommand,
// never invent a run-id to fill the run-context template.
const context = spawnSync("/bin/sh", ["-c", command], {
  encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024
});
assert.equal(context.status, 0, context.stderr);
const parsed = JSON.parse(context.stdout);
assert.notEqual(parsed.ok, false);
const value = parsed.data ?? parsed;
assert.equal(value.taskId, manifest.owner.taskId);
const bytes = fs.readFileSync(process.argv[1]);
assert.ok(bytes.length);
const proof = {
  taskId: value.taskId, manifestDigest: manifest.digest, contextCommand: command,
  fixtureSha256: createHash("sha256").update(bytes).digest("hex"),
  contextSha256: createHash("sha256").update(context.stdout).digest("hex")
};
fs.writeFileSync(process.argv[2], JSON.stringify(proof), {flag: "wx"});
assert.deepEqual(JSON.parse(fs.readFileSync(process.argv[2], "utf8")), proof);
console.log(JSON.stringify(proof));
`, fixture, output]
  };
}

export async function preflightCodexExecution(request, input) {
  const parameters = executionProbeParameters(input);
  const result = await request("command/exec", parameters);
  assert.equal(result.exitCode, 0,
    `Native execution preflight failed (${input.startup.sandbox.type}); no model request should follow:\n${result.stderr}`);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.taskId, input.environment.YUI_TASK_ID);
  return { method: "command/exec", cwd: parameters.cwd, sandboxPolicy: parameters.sandboxPolicy,
    approvalPolicy: input.startup.approvalPolicy, result, proof };
}
