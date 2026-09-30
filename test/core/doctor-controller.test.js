import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  ControllerClientError,
  classifyControllerSocketError,
  controllerCallMayHaveApplied,
  readControllerDiscovery
} from "../../dist/core/controllerClient.js";
import { assertFileTaskControllerStorageCompatible, ensureFileTaskController } from "../../dist/controller/clientRuntime.js";
import { buildDoctorReport, checkController } from "../../dist/doctor/doctor.js";
import { assertRuntimeCoherence } from "../../dist/runtime/runtimeCoherence.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { yuiVersionIdentity } from "../../dist/version.js";

test("doctor reports Controller reachability without starting it", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-doctor-controller-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();

  const report = await buildDoctorReport({ HOME: home, YUI_HOME: home }, { run: () => "fixture" });
  const stopped = report.checks.find(check => check.name === "controller");
  assert.equal(stopped.status, "missing");
  assert.match(stopped.detail, /yui start/);
  assert.match(stopped.detail, /ENOENT/);
  assert.equal(report.storage.healthy, true);

  await assert.rejects(readControllerDiscovery(home), error =>
    error.code === "CONTROLLER_NOT_RUNNING"
      && error.cause?.code === "ENOENT"
      && error.message.includes(error.cause.message)
  );

  const running = await checkController(home, async () => ({ running: true, pid: 123 }));
  assert.equal(running.status, "ok");
  assert.match(running.detail, /pid=123/);

  const unreachable = await checkController(home, async () => {
    throw new ControllerClientError("CONTROLLER_UNAVAILABLE", "socket could not be reached");
  });
  assert.equal(unreachable.status, "invalid");
  assert.doesNotMatch(unreachable.detail, /yui start/);
  assert.match(unreachable.detail, /controller status/);
  assert.match(unreachable.detail, /unverified/);
  assert.match(unreachable.detail, /socket could not be reached/);
});

test("a denied Controller socket tells the Agent to request sandbox escalation without implying delivery", async () => {
  const denied = classifyControllerSocketError(
    Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    false
  );
  assert.equal(denied.code, "CONTROLLER_ACCESS_DENIED");
  assert.match(denied.message, /same Yui CLI command.*outside.*sandbox/i);
  assert.match(denied.message, /EPERM.*operation not permitted/s);
  assert.equal(denied.cause?.code, "EPERM");
  assert.equal(controllerCallMayHaveApplied(denied), false);
  const eacces = classifyControllerSocketError(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    false
  );
  assert.equal(eacces.code, "CONTROLLER_ACCESS_DENIED");
  assert.match(eacces.message, /EACCES.*permission denied/s);

  const doctor = await checkController("/unused", async () => { throw denied; });
  assert.equal(doctor.status, "invalid");
  assert.match(doctor.detail, /outside.*sandbox/i);
  assert.doesNotMatch(doctor.detail, /yui start|restart/i);

  const identity = yuiVersionIdentity();
  await assert.rejects(
    assertRuntimeCoherence({ actualHome: "/unused" }, {
      identity,
      inspectStorage: () => ({ status: "current", currentVersion: identity.storageVersion }),
      callController: async () => { throw denied; }
    }),
    error => error === denied && !/yui start|restart/i.test(error.message)
  );

  const afterDelivery = classifyControllerSocketError(
    Object.assign(new Error("operation not permitted"), { code: "EPERM" }),
    true
  );
  assert.equal(afterDelivery.code, "CONTROLLER_DELIVERY_UNKNOWN");
  assert.equal(controllerCallMayHaveApplied(afterDelivery), true);
  assert.match(afterDelivery.message, /EPERM.*operation not permitted/s);
  assert.equal(afterDelivery.cause?.code, "EPERM");

  const refused = classifyControllerSocketError(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
    false
  );
  assert.equal(refused.code, "CONTROLLER_UNAVAILABLE");
  assert.match(refused.message, /ECONNREFUSED.*connection refused/s);
  assert.equal(refused.cause?.code, "ECONNREFUSED");
});

test("Controller failure reaches the CLI with recovery guidance while offline reads remain available", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-controller-cli-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  new SqliteTaskStore(home).close();
  const cli = resolve("dist/cli.js");
  const environment = { ...process.env, YUI_HOME: home, YUI_STORE_WORKER: "false" };
  for (const name of Object.keys(environment)) if (name.startsWith("YUI_")) delete environment[name];
  environment.YUI_HOME = home;
  environment.YUI_STORE_WORKER = "false";
  const read = spawnSync(process.execPath, [cli, "task", "list"], { env: environment, encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  const request = spawnSync(process.execPath, [cli, "web", "--status"], { env: environment, encoding: "utf8" });
  assert.equal(request.status, 5, request.stderr);
  assert.match(request.stderr, /discovery record is missing.*yui doctor.*yui start/s);
  assert.match(request.stderr, /ENOENT/);
  for (const [command, expectedCode] of [
    [["web", "--status"], "RUNTIME_ERROR"],
    [["controller", "live-identity"], "CONTROLLER_NOT_RUNNING"]
  ]) {
    const result = spawnSync(process.execPath, [cli, ...command, "--json"], { env: environment, encoding: "utf8" });
    assert.equal(result.status, 5);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.code, expectedCode);
    assert.equal(failure.details.diagnostic.home, home);
    assert.equal(failure.details.diagnostic.controller.delivery, "not-sent");
    assert.match(failure.message, /ENOENT.*not sent.*yui doctor/s);
  }
  assert.equal(existsSync(join(home, "runtime/controller.json")), false);

  const unavailable = new ControllerClientError("CONTROLLER_UNAVAILABLE", "fixture socket refused");
  const call = async () => { throw unavailable; };
  await assert.rejects(
    assertFileTaskControllerStorageCompatible(home, { call }),
    error => error.cause === unavailable && /fixture socket refused.*yui doctor/s.test(error.message)
  );
  const identity = yuiVersionIdentity();
  await assert.rejects(
    assertRuntimeCoherence({ actualHome: home }, {
      identity,
      inspectStorage: () => ({ status: "current", currentVersion: identity.storageVersion }),
      callController: call
    }),
    error => error.cause === unavailable && /fixture socket refused.*yui doctor/s.test(error.message)
  );

  let started = 0;
  await assert.rejects(
    ensureFileTaskController(home, {
      call: async () => { throw new ControllerClientError("CONTROLLER_NOT_RUNNING", "fixture stopped"); },
      spawnController: () => { started += 1; return 4242; },
      startupTimeoutMs: 1,
      pollIntervalMs: 1
    }),
    /Startup PID: 4242.*timeout does not prove it stopped.*yui doctor/s
  );
  assert.equal(started, 1);
});
