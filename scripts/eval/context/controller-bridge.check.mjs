import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, symlinkSync, renameSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startControllerBridge } from "./controller-bridge.mjs";
import { bridgeConnection } from "./controller-bridge-client.mjs";

test("fixture bridge forwards bytes once to its fixed Home and contains hostile paths", { skip: process.platform !== "linux" }, async t => {
  const root = mkdtempSync("/tmp/yui-bridge-check-"), directory = join(root, "mailbox");
  mkdirSync(directory);
  const socketPath = join(root, "controller.sock"), received = [];
  const server = createServer(socket => socket.on("data", bytes => {
    received.push(bytes.toString());
    socket.end('{"id":"one","ok":true,"result":{"value":42}}\n');
  }));
  let bridge;
  t.after(async () => {
    await bridge?.close();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  bridge = startControllerBridge({ directory, socketPath, homeId: "own", homeFilesystemId: "own-fs" });
  const exchange = line => new Promise((resolve, reject) => {
    const socket = bridgeConnection(directory, { timeoutMs: 500 });
    socket.on("connect", () => socket.write(line));
    socket.on("data", bytes => { socket.destroy(); resolve(bytes.toString()); });
    socket.on("error", reject);
  });
  const request = '{"id":"one","homeId":"own","homeFilesystemId":"own-fs","method":"test"}\n';
  assert.match(await exchange(request), /"value":42/);
  assert.deepEqual(received, [request], "No rewritten identity, token, method or payload");
  await assert.rejects(exchange(request.replace('"own"', '"foreign"')), /bridge/i);
  assert.equal(received.length, 1, "Foreign Home is never forwarded");
  await assert.rejects(exchange(request + request), /bridge/i);

  const outside = join(root, "outside");
  writeFileSync(outside, "untouched");
  const id = randomUUID();
  symlinkSync(outside, join(directory, `${id}.request`));
  await delay(80);
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  assert.equal(received.length, 1, "Symlink requests are not read or forwarded");

  const replay = randomUUID();
  writeFileSync(join(directory, `${replay}.request`), request);
  await delay(80);
  writeFileSync(join(directory, `${replay}.request`), request);
  await delay(80);
  assert.equal(received.length, 2, "The same mailbox ID cannot be replayed");

  // Replacing the writable mailbox directory cannot redirect host writes.
  renameSync(directory, join(root, "parked"));
  mkdirSync(directory);
  writeFileSync(join(directory, `${randomUUID()}.request`), request);
  await delay(80);
  assert.equal(received.length, 2);
  await bridge.close();
  await assert.rejects(exchange(request), /bridge/i);
});
