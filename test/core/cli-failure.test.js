import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { CliError } from "../../dist/errors/cliError.js";
import { describeCliFailure, renderCliFailure } from "../../dist/errors/cliFailure.js";
import { ControllerClientError, classifyControllerSocketError, callController } from "../../dist/core/controllerClient.js";
import { controllerSocketPath } from "../../dist/core/controllerEndpoint.js";
import { readHomeFilesystemId } from "../../dist/core/homeFilesystemIdentity.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { StorageSchemaError } from "../../dist/storage/storageSchema.js";
import { ManagedRuntimeDriftError } from "../../dist/runtime/managedCaller.js";

test("one failure projection preserves contracts, causes and safe recovery in text and JSON", () => {
  const cause = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
  const error = classifyControllerSocketError(cause, false);
  const failure = describeCliFailure(error);
  assert.equal(failure.code, "RUNTIME_ERROR");
  assert.equal(failure.exitCode, 5);
  assert.equal(failure.details.diagnostic.controller.delivery, "not-sent");
  assert.match(failure.message, /ECONNREFUSED/);
  assert.match(failure.message, /unverified/);
  assert.doesNotMatch(failure.message, /Run `yui start`/);
  const json = JSON.parse(renderCliFailure(failure, true));
  assert.equal(json.message, failure.message);
  assert.ok(renderCliFailure(failure, false).includes(json.message));

  const unknown = describeCliFailure(new ControllerClientError(
    "CONTROLLER_TIMEOUT", "Timed out", undefined,
    { delivery: "unconfirmed", method: "task.message.send", requestId: "request-1" }
  ));
  assert.equal(unknown.details.diagnostic.controller.requestId, "request-1");
  assert.match(unknown.message, /may have applied/);
  assert.match(unknown.message, /Do not replay/);

  const usage = describeCliFailure(new CliError("USAGE_ERROR", "Invalid value", "yui config --help", { field: "x" }));
  assert.equal(usage.exitCode, 2);
  assert.equal(usage.details.field, "x");
  assert.match(JSON.parse(renderCliFailure(usage, true)).message, /yui config --help/);
  const storage = describeCliFailure(new StorageSchemaError("STORAGE_SCHEMA_UNSUPPORTED", "Storage is newer"));
  assert.equal(storage.exitCode, 5);
  assert.match(storage.message, /matching CLI/);
  assert.doesNotMatch(storage.message, /yui start/);
  const session = describeCliFailure(new ManagedRuntimeDriftError("Manifest owner mismatch"));
  assert.match(session.message, /Operator.*Session/s);
  assert.doesNotMatch(session.message, /yui start/);
  const receipt = { id: "operation-1", effect: "unknown" };
  const partial = describeCliFailure(new CliError("RUNTIME_ERROR", "Partial cleanup", undefined, {
    receipts: Array(130).fill(receipt), original: receipt
  }));
  assert.deepEqual(partial.details.receipts, Array(130).fill(receipt));
  assert.deepEqual(partial.details.original, receipt);
});

test("local transport distinguishes unsent failure, missing acknowledgement and error response without replay", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-error-transport-"));
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", data => {
      const request = JSON.parse(data.toString());
      received.push(request.id);
      if (request.method === "invalid") socket.end('{"token":"private-token"}\n');
      if (request.method === "reject") socket.end(JSON.stringify({
        id: request.id, ok: false,
        error: { code: "UNAUTHORIZED", message: "Controller authentication failed." }
      }) + "\n");
      // timeout deliberately keeps the connection open without acknowledging.
    });
  });
  let socketPath;
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (socketPath !== undefined) rmSync(socketPath, { force: true });
    rmSync(home, { recursive: true, force: true });
  });
  const store = new SqliteTaskStore(home);
  const homeId = store.getHomeIdentity().homeId;
  store.close();
  socketPath = controllerSocketPath(homeId);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "runtime"), { recursive: true });
  writeFileSync(join(home, "runtime/controller.json"), JSON.stringify({
    schemaVersion: 1, protocolVersion: 1, homeId,
    homeFilesystemId: readHomeFilesystemId(home),
    controllerInstanceId: "1".repeat(32), pid: process.pid, processStartIdentity: "1",
    socketPath, token: "2".repeat(64)
  }), { mode: 0o600 });
  const received = [];
  server.listen(socketPath);
  await once(server, "listening");
  for (const [method, code, delivery] of [
    ["invalid", "INVALID_RESPONSE", "unconfirmed"],
    ["timeout", "CONTROLLER_TIMEOUT", "unconfirmed"],
    ["reject", "UNAUTHORIZED", "response-received"]
  ]) {
    await assert.rejects(callController(home, method, {}, { timeoutMs: 100, id: method }), error => {
      assert.equal(error.code, code);
      assert.equal(error.diagnostic.delivery, delivery);
      assert.equal(error.diagnostic.requestId, method);
      assert.doesNotMatch(JSON.stringify(describeCliFailure(error)), /private-token/);
      return true;
    });
  }
  assert.deepEqual(received, ["invalid", "timeout", "reject"]);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(callController(home, "offline", {}, { id: "not-sent" }), error => {
    assert.equal(error.diagnostic.delivery, "not-sent");
    assert.equal(error.diagnostic.method, "offline");
    return true;
  });
});

test("diagnostics preserve a bounded cause chain without dumping payloads or secrets", () => {
  const error = new Error("startup failed", {
    cause: Object.assign(new Error("EACCES token=private-token https://user:password@example.test/path"), {
      code: "EACCES",
      payload: "private message body"
    })
  });
  const failure = describeCliFailure(error, {
    environment: { CUSTOM_SECRET: "environment-secret" },
    privateValues: ["private message body"]
  });
  assert.match(failure.message, /startup failed.*EACCES/s);
  assert.doesNotMatch(JSON.stringify(failure), /private-token|user:password|private message body/);
  const nested = describeCliFailure(new CliError("DATA_ERROR",
    "Invalid private message body environment-secret",
    undefined, { token: "unlabelled-secret", apiKey: "unknown-key-value", nested: { body: "private message body" } }
  ), { environment: { CUSTOM_SECRET: "environment-secret" }, privateValues: ["private message body"] });
  assert.equal(nested.exitCode, 4);
  assert.doesNotMatch(JSON.stringify(nested), /unlabelled-secret|unknown-key-value|private message body|environment-secret/);
  const aggregate = describeCliFailure(new AggregateError([
    new Error("original cleanup failed"), new Error("restoration failed")
  ], "multiple failures"));
  assert.match(aggregate.message, /original cleanup failed.*restoration failed/s);
});
