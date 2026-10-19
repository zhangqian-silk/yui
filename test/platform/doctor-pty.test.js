import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectPty } from "../../dist/doctor/ptyProbe.js";

test("PTY diagnostics isolate native failure and bound a stalled probe without claiming success", t => {
  const root = mkdtempSync(join(tmpdir(), "yui-pty-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requireFrom = pathToFileURL(join(root, "entry.cjs")).href;
  assert.equal(inspectPty({ requireFrom }).find(c => c.name === "node-pty").status, "missing");
  const module = join(root, "node_modules/node-pty");
  mkdirSync(module, { recursive: true });
  writeFileSync(join(module, "package.json"), JSON.stringify({ name: "node-pty", version: "fixture", main: "index.cjs" }));
  const helper = join(module, "spawn-helper");
  writeFileSync(helper, "fixture", { mode: 0o700 });
  const inspect = source => {
    writeFileSync(join(module, "index.cjs"),
      `require.cache[${JSON.stringify(join(module, "pty.node"))}] = { exports: {} };\n${source}`);
    return inspectPty({ requireFrom, probeTimeoutMs: 60, timeoutMs: 500 });
  };
  const load = inspect('throw new Error("fixture native ABI mismatch")');
  assert.match(load.find(c => c.name === "node-pty").detail, /load failed.*fixture native ABI mismatch/s);
  const failed = inspect('exports.spawn = () => { throw new Error("posix_spawnp failed"); }');
  assert.match(failed.find(c => c.name === "pty spawn").detail, /spawn failed.*posix_spawnp failed/s);
  assert.doesNotMatch(JSON.stringify(failed), /permission denied|chmod/);
  const killReceipt = join(root, "kill-receipt");
  const stalled = inspect(`exports.spawn = () => ({
    onData() {}, onExit() {},
    kill(signal) { require("node:fs").writeFileSync(${JSON.stringify(killReceipt)}, signal); }
  });`);
  assert.match(stalled.find(c => c.name === "pty spawn").detail, /timeout/);
  assert.equal(readFileSync(killReceipt, "utf8"), "SIGKILL");
  const wrongOutput = inspect(`exports.spawn = () => ({
    onData(callback) { callback("wrong output"); },
    onExit(callback) { callback({ exitCode: 0 }); }, kill() {}
  });`);
  assert.match(wrongOutput.find(c => c.name === "pty spawn").detail, /unexpected output or exit/);
  assert.equal(wrongOutput.find(c => c.name === "pty spawn").status, "invalid");
  const crashed = inspect('process.kill(process.pid, "SIGKILL")');
  assert.match(JSON.stringify(crashed), /SIGKILL/);
  const hung = inspect('while (true) {}');
  assert.match(JSON.stringify(hung), /timeout/);
  if (process.platform === "darwin") {
    // Execute permission is user-specific, not an exact 0755-mode contract.
    const executable = inspect('exports.spawn = () => { throw new Error("fixture reached spawn"); }');
    assert.equal(executable.find(c => c.name === "pty helper").status, "ok");
    chmodSync(helper, 0o644);
    const denied = inspect('exports.spawn = () => { throw new Error("must not spawn"); }');
    assert.match(denied.find(c => c.name === "pty helper").detail, /mode=0644.*permission denied/);
    assert.ok(denied.find(c => c.name === "pty helper").detail.includes(helper));
    assert.equal(statSync(helper).mode & 0o777, 0o644);
    assert.equal(denied.some(c => c.name === "pty spawn"), false);
  }
});
