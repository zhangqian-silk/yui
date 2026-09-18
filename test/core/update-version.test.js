import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runUpdateCommand } from "../../dist/cli/updateCommand.js";
import { createUpdatePorts } from "../../dist/cli/updatePorts.js";
import { findCommandNode } from "../../dist/cli/commandCatalog.js";

test("update accepts an exact bridge version and retains target-owned preflight refusal", () => {
  assert.ok(findCommandNode(["update"]).options.includes("--version"));
  const calls = [];
  let output = "";
  const ports = {
    stage: (version) => {
      calls.push(["stage", version]);
      return { binaryPath: "/unused/staged-yui", version: version ?? "1.0.0" };
    },
    preflight: () => {
      calls.push(["preflight"]);
      return {
        status: "blocked",
        stage: "unsupported",
        message: "This Home requires the bridge release.",
        action: "Install 0.99.0 first.",
        sceneUnchanged: true
      };
    },
    beginControllerHandover: () => assert.fail("must not stop the Controller"),
    activateBinary: () => assert.fail("must not change the global installation"),
    verify: () => assert.fail("must not verify an unactivated package"),
    cleanup: () => calls.push(["cleanup"])
  };
  assert.equal(runUpdateCommand(["--version", "0.99.0"], { YUI_HOME: "/unused/home" },
    undefined, text => { output += text; }, ports), 5);
  assert.deepEqual(calls, [["stage", "0.99.0"], ["preflight"], ["cleanup"]]);
  assert.match(output, /Install 0\.99\.0 first/);
  calls.length = 0;
  runUpdateCommand([], { YUI_HOME: "/unused/home" }, undefined, () => {}, ports);
  assert.deepEqual(calls, [["stage", undefined], ["preflight"], ["cleanup"]]);
  calls.length = 0;
  for (const args of [["--version"], ["--version", "latest"], ["--version", "^0.99.0"],
    ["--version", "0.99.0", "--version", "1.0.0"], ["--unknown"]]) {
    assert.throws(() => runUpdateCommand(args, { YUI_HOME: "/unused/home" },
      undefined, () => {}, ports), /Update usage/);
  }
  assert.deepEqual(calls, [], "invalid selectors must fail before staging");
});

test("pinned npm staging rejects a different installed version and removes only its staging directory", t => {
  const stagingRoot = mkdtempSync(join(tmpdir(), "yui-pinned-stage-"));
  t.after(() => rmSync(stagingRoot, { recursive: true, force: true }));
  const calls = [];
  let observedVersion = "1.0.0";
  const ports = createUpdatePorts({}, (command, args) => {
    calls.push({ command, args: [...args] });
    const stdout = Buffer.from(JSON.stringify({ ok: true, data: { version: observedVersion } }));
    return { pid: 1, output: [null, stdout, Buffer.alloc(0)], stdout,
      stderr: Buffer.alloc(0), status: 0, signal: null };
  }, stagingRoot);
  assert.throws(() => ports.stage("0.99.0"), /requested.*0\.99\.0.*staged.*1\.0\.0/i);
  assert.deepEqual(readdirSync(stagingRoot), []);
  assert.equal(calls[0].args.at(-1), "@zq-silk/yui@0.99.0");
  observedVersion = "0.99.0";
  const staged = ports.stage("0.99.0");
  try {
    assert.equal(staged.version, "0.99.0");
    assert.equal(readdirSync(stagingRoot).length, 1);
  } finally {
    ports.cleanup(staged);
  }
  assert.deepEqual(readdirSync(stagingRoot), []);
});
