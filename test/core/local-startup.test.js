import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";

const execute = promisify(execFile);
const cli = resolve("dist/cli.js");

test("start is idempotent and leaves Codex stopped when no active Role needs it", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-local-start-"));
  const environment = { ...process.env, YUI_HOME: home, HOME: home };
  const run = async (...args) => execute(process.execPath, [cli, ...args], {
    env: environment, timeout: 20_000
  });
  t.after(async () => {
    try { await run("controller", "stop"); }
    finally { rmSync(home, { recursive: true, force: true }); }
  });
  const store = new SqliteTaskStore(home);
  store.saveConfiguredAgent(createConfiguredAgent("unused-codex", "codex", "false", [], [], new Date()));
  store.close();

  const first = JSON.parse((await run("start", "--json")).stdout).data;
  assert.deepEqual(first.codex, { daemons: [], app: "not-applicable" });
  assert.ok(first.controller);
  const second = JSON.parse((await run("start", "--json")).stdout).data;
  assert.deepEqual(second.codex, { daemons: [], app: "not-applicable" });
  assert.equal(second.controller.pid, first.controller.pid);
  assert.equal(second.controller.controllerInstanceId, first.controller.controllerInstanceId);
  const controllerOnly = JSON.parse((await run("controller", "start", "--json")).stdout).data;
  assert.equal(controllerOnly.pid, first.controller.pid);
});
