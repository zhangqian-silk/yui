import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderUpdateResult, runUpdateCommand } from "../../dist/cli/updateCommand.js";
import { runUpdate } from "../../dist/cli/updateOrchestrator.js";
import { activatedControllerEntrypoint, createUpdatePorts } from "../../dist/cli/updatePorts.js";
import { findCommandNode } from "../../dist/cli/commandCatalog.js";

test("staged preflight retains structured failure diagnostics without admitting failure", () => {
  const stderr = Buffer.from(JSON.stringify({ ok: false,
    code: "RUNTIME_ERROR",
    message: "Native Session is not registered in this YUI_HOME. Use the registered Operator Session."
  }));
  const ports = createUpdatePorts({}, () => ({ pid: 1, output: [null, Buffer.alloc(0), stderr],
    stdout: Buffer.alloc(0), stderr, status: 5, signal: null }));
  const result = ports.preflight({ binaryPath: "/unused/yui", version: "2.8.1" }, "/unused/home");
  assert.equal(result.status, "blocked");
  assert.equal(result.stage, "preflight");
  assert.match(result.message, /Native Session is not registered/);
  assert.match(result.message, /registered Operator/);
});

test("Host-only update status is read-only and bypasses staging and activation", () => {
  let output = "";
  assert.ok(findCommandNode(["update"]).options.includes("--hosts-status"));
  assert.equal(runUpdateCommand(["--hosts-status"], { YUI_HOME: "/unused/home" },
    undefined, text => { output += text; }, {
      stage: () => assert.fail("Status must not stage a package"),
      hostStatus: home => {
        assert.equal(home, "/unused/home");
        return [{ owner: { scope: "global", roleName: "operator" },
          nativeSessionId: "original", status: "waiting", detail: "native turn remains active" }];
      }
    }), 0);
  assert.match(output, /original.*waiting.*native turn remains active/);
});

test("update accepts an exact version and retains target-owned preflight refusal", () => {
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
        message: "This Home is not supported by the staged release.",
        action: "Inspect storage compatibility before retrying.",
        sceneUnchanged: true
      };
    },
    beginControllerHandover: () => assert.fail("must not stop the Controller"),
    activateBinary: () => assert.fail("must not change the global installation"),
    verify: () => assert.fail("must not verify an unactivated package"),
    cleanup: () => calls.push(["cleanup"])
  };
  assert.equal(runUpdateCommand(["--version", "1.0.0"], { YUI_HOME: "/unused/home" },
    undefined, text => { output += text; }, ports), 5);
  assert.deepEqual(calls, [["stage", "1.0.0"], ["preflight"], ["cleanup"]]);
  assert.match(output, /Inspect storage compatibility before retrying/);
  calls.length = 0;
  runUpdateCommand(["--version", "1.0.1"], { YUI_HOME: "/unused/home" },
    undefined, () => {}, ports);
  assert.deepEqual(calls, [["stage", "1.0.1"], ["preflight"], ["cleanup"]]);
  calls.length = 0;
  runUpdateCommand([], { YUI_HOME: "/unused/home" }, undefined, () => {}, ports);
  assert.deepEqual(calls, [["stage", undefined], ["preflight"], ["cleanup"]]);
  calls.length = 0;
  for (const args of [["--version"], ["--version", "latest"], ["--version", "^1.0.0"],
    ["--version", "1.0.0", "--version", "1.0.1"], ["--unknown"]]) {
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
  assert.throws(() => ports.stage("1.0.1"), /requested.*1\.0\.1.*staged.*1\.0\.0/i);
  assert.deepEqual(readdirSync(stagingRoot), []);
  assert.equal(calls[0].args.at(-1), "@zq-silk/yui@1.0.1");
  observedVersion = "1.0.1";
  const staged = ports.stage("1.0.1");
  try {
    assert.equal(staged.version, "1.0.1");
    assert.equal(readdirSync(stagingRoot).length, 1);
  } finally {
    ports.cleanup(staged);
  }
  assert.deepEqual(readdirSync(stagingRoot), []);
});

test("target preflight admits only contiguous same-major storage upgrades", ()=>{
  let from="1.0",to="1.1";
  const ports=createUpdatePorts({},()=>{
    const data={outcome:"update-preflight",status:"migration-ready",stepCount:1,
      steps:[{fromVersion:from,toVersion:to,name:"minor"}],
      classification:{storageVersion:from,currentStorageVersion:to,
        classification:{verdict:"MIGRATABLE",status:"migration-ready"}}};
    const stdout=Buffer.from(JSON.stringify({ok:true,data}));
    return {pid:1,output:[null,stdout,Buffer.alloc(0)],stdout,stderr:Buffer.alloc(0),status:0,signal:null};
  });
  const staged={binaryPath:"/unused/yui",version:"1.0.0"};
  assert.equal(ports.preflight(staged,"/unused/home").status,"migration-ready");
  to="2.0";
  assert.equal(ports.preflight(staged,"/unused/home").status,"blocked");
  to="1.2";
  assert.equal(ports.preflight(staged,"/unused/home").status,"blocked");
  from=1;to=1;
  assert.equal(ports.preflight(staged,"/unused/home").status,"blocked");
});

test("update preserves successful migration retention warnings without replay or abort", () => {
  const backupRetention = {
    keep: 3, retained: 4, deleted: ["/unused/home/backups/old.db"],
    protected: [{ path: "/unused/home/backups/recovery.db", reason: "explicit recovery pin" }],
    warnings: [{ path: "/unused/home/backups/old.db.retention.json", message: "permission denied" }]
  };
  const stdout = Buffer.from(JSON.stringify({ ok: true, data: {
    outcome: "upgraded", report: { backupPath: "/unused/home/backups/current.db", backupRetention }
  } }));
  const nativePorts = createUpdatePorts({}, () => ({ pid: 1,
    output: [null, stdout, Buffer.alloc(0)], stdout, stderr: Buffer.alloc(0), status: 0, signal: null }));
  const staged = { binaryPath: "/unused/yui", version: "2.29.1" };
  const migration = nativePorts.migrateStorage(staged, "/unused/home");
  assert.deepEqual(migration.backupRetention, backupRetention);
  let migrations = 0;
  let failVerification = false;
  const ports = {
    stage: () => staged,
    preflight: () => ({ status: "migration-ready", stepCount: 1 }),
    activateBinary: () => {},
    migrateStorage: () => { migrations++; return migration; },
    beginControllerHandover: () => () => {},
    controllerStatus: () => ({ running: false }),
    stopController: () => ({ stopped: false }),
    startController: () => {},
    restoreController: () => {},
    verify: () => { if (failVerification) throw new Error("health check failed"); },
    cleanup: () => {}
  };
  const result = runUpdate(ports, { home: "/unused/home" });
  assert.equal(result.outcome, "updated");
  assert.deepEqual(result.backupRetention, backupRetention);
  assert.match(renderUpdateResult(result), /Cleanup warning \(migration succeeded\).*permission denied/);
  assert.equal(migrations, 1);
  failVerification = true;
  const failure = runUpdate(ports, { home: "/unused/home" });
  assert.equal(failure.phase, "post-verify");
  assert.deepEqual(failure.backupRetention, backupRetention);
  assert.match(renderUpdateResult(failure), /explicit recovery pin/);
  assert.equal(migrations, 2, "Each separate update invokes migration once; cleanup warnings never replay it.");
});

test("Controller entrypoint resolution requires real files in a supported install layout", t=>{
  const root=mkdtempSync(join(tmpdir(),"yui-controller-entrypoint-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  assert.throws(()=>activatedControllerEntrypoint(join(root,"missing","yui")),/ENOENT|entrypoint/);
  const cli=join(root,"package","dist","cli.js");
  const controller=join(root,"package","dist","controller","controllerMain.js");
  mkdirSync(join(root,"package","dist","controller"),{recursive:true});
  writeFileSync(cli,"// fixture CLI\n");
  assert.throws(()=>activatedControllerEntrypoint(cli),/entrypoint/i);
  writeFileSync(controller,"// fixture Controller\n");
  assert.equal(activatedControllerEntrypoint(cli),controller);
  const linked=join(root,"linked-yui");
  symlinkSync(cli,linked);
  assert.equal(activatedControllerEntrypoint(linked),controller);
  const shim=join(root,"npm","bin","yui");
  const shimController=join(root,"npm","lib","node_modules","@zq-silk","yui","dist","controller","controllerMain.js");
  mkdirSync(join(root,"npm","bin"),{recursive:true});
  mkdirSync(join(root,"npm","lib","node_modules","@zq-silk","yui","dist","controller"),{recursive:true});
  writeFileSync(shim,"#!/bin/sh\n");
  writeFileSync(shimController,"// fixture Controller\n");
  assert.equal(activatedControllerEntrypoint(shim),shimController);
});
