import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import filesystem from "node:fs/promises";
import synchronousFilesystem from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { restartFileTaskController } from "../../dist/controller/clientRuntime.js";
import { readControllerDiscovery, stopOrphanedFileTaskController } from "../../dist/core/controllerClient.js";
import { startControllerServer } from "../../dist/core/controllerServer.js";
import { processGenerationIsLive } from "../../dist/core/fileLockOwner.js";
import { controllerSocketPath } from "../../dist/core/controllerEndpoint.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { yuiVersionIdentity } from "../../dist/version.js";

test("production restart retains the exact generation fence across a post-stop status reset",
  { timeout: 10_000 }, async t => {
    if (process.platform !== "linux") return t.skip("Linux Unix-socket unread-data reset fixture");
    await t.test("an uninspectable but live old generation cannot authorize successor startup",
      t => resetFixture(t, true));
    await t.test("validated discovery retains its fence when both ownership and generation inspection become unavailable",
      t => resetFixture(t, true, true));
    await t.test("an exited old generation recovers; a mismatched captured generation is never signalled",
      t => resetFixture(t, false));
  });

async function resetFixture(t, holdOldProcess, unknownGeneration = false) {
    const home = await mkdtemp(join(tmpdir(), "yui-controller-reset-"));
    let child, childExit, successor, homeId;
    t.after(async () => {
      if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
      await childExit;
      await successor?.close();
      if (homeId !== undefined) await rm(controllerSocketPath(homeId), { force: true });
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(home, { recursive: true, force: true });
    });
    const store = new SqliteTaskStore(home);
    homeId = store.getHomeIdentity().homeId;
    store.close();
    const errors = [];
    let stopAcknowledged = false;
    let discoveryMisses = 0;
    let faultArmed = false;
    const connect = net.createConnection;
    // Observe the actual OS error; do not replace callController or its socket.
    t.mock.method(net, "createConnection", (...args) => {
      const origin = new Error("Controller fixture connection origin");
      const socket = connect(...args);
      socket.on("error", error => {
        errors.push(error.code);
        error.fixtureConnectionOrigin = origin.stack;
      });
      return socket;
    });
    const lstat = filesystem.lstat;
    t.mock.method(filesystem, "lstat", async (...args) => {
      // Inject only the discovery-removal visibility race. All requests still
      // use real callController/Unix sockets, and options.call is absent.
      if (stopAcknowledged && discoveryMisses === 0
        && args[0] === join(home, "runtime/controller.json")) {
        discoveryMisses++;
        throw Object.assign(new Error("fixture discovery removed during stop"), { code: "ENOENT" });
      }
      return lstat(...args);
    });
    const readFileSync = synchronousFilesystem.readFileSync;
    t.mock.method(synchronousFilesystem, "readFileSync", (...args) => {
      // Simulate loss of the ownership inspection after its exact generation
      // was captured. Its kernel start identity and kill(pid, 0) stay readable.
      if (holdOldProcess && faultArmed
        && ((args[0] === `/proc/${child.pid}/status` && (stopAcknowledged || unknownGeneration))
          || (unknownGeneration && stopAcknowledged && args[0] === `/proc/${child.pid}/stat`))) {
        throw Object.assign(new Error("fixture ownership inspection unavailable"), { code: "EACCES" });
      }
      return readFileSync(...args);
    });
    syncBuiltinESMExports();
    const source = `
      import { createServer } from "node:net";
      import { mkdir, writeFile, chmod } from "node:fs/promises";
      import { join, dirname } from "node:path";
      import { controllerSocketPath } from ${JSON.stringify(new URL("../../dist/core/controllerEndpoint.js", import.meta.url).href)};
      import { readHomeFilesystemId } from ${JSON.stringify(new URL("../../dist/core/homeFilesystemIdentity.js", import.meta.url).href)};
      import { currentProcessStartIdentity } from ${JSON.stringify(new URL("../../dist/core/fileLockOwner.js", import.meta.url).href)};
      const home = process.env.YUI_HOME;
      const socketPath = controllerSocketPath(${JSON.stringify(homeId)});
      await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
      let stopping = false, pendingAck;
      process.on("message", message => { if (message === "continue-ack") pendingAck(); });
      const server = createServer({ pauseOnConnect: true }, socket => {
        if (stopping) {
          // Closing with unread kernel data produces a real post-stop status
          // ECONNRESET, while the exact captured Controller generation exits.
          setTimeout(() => {
            socket.destroy();
            if (${JSON.stringify(holdOldProcess)}) server.close();
            else process.exit(0);
          }, 20);
          return;
        }
        let data = "";
        socket.on("data", chunk => {
          data += chunk;
          if (!data.endsWith("\\n")) return;
          const request = JSON.parse(data);
          if (request.method === "controller.status") socket.end(JSON.stringify({
            id: request.id, ok: true, result: { running: true, pid: process.pid,
              ...${JSON.stringify(yuiVersionIdentity())}, protocolVersion: 1 }
          }) + "\\n");
          else if (request.method === "controller.stop") {
            stopping = true;
            pendingAck = () => socket.end(JSON.stringify({
              id: request.id, ok: true, result: { stopped: true }
            }) + "\\n");
            process.send("stop-ack-ready");
          }
        });
        socket.resume();
      });
      await new Promise(resolve => server.listen(socketPath, resolve));
      await chmod(socketPath, 0o600);
      await mkdir(join(home, "runtime"), { recursive: true, mode: 0o700 });
      await writeFile(join(home, "runtime/controller.json"), JSON.stringify({
        schemaVersion: 1, protocolVersion: 1, homeId: ${JSON.stringify(homeId)},
        homeFilesystemId: readHomeFilesystemId(home), controllerInstanceId: "1".repeat(32),
        pid: process.pid, processStartIdentity: currentProcessStartIdentity(),
        socketPath, token: "2".repeat(64)
      }), { mode: 0o600 });
      process.send("ready");
    `;
    child = spawn(process.execPath, ["--input-type=module", "-e", source, "/fixture/controllerMain.js"], {
      env: sanitizedTestEnv({ YUI_HOME: home }), stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    childExit = once(child, "exit");
    assert.equal((await once(child, "message"))[0], "ready", stderr);
    child.on("message", message => {
      if (message === "stop-ack-ready") {
        stopAcknowledged = true;
        child.send("continue-ack");
      }
    });
    const captured = await readControllerDiscovery(home);
    assert.equal(captured.pid, child.pid);
    // A live PID is not authority to stop a different captured generation.
    await assert.rejects(stopOrphanedFileTaskController(home, 100, {
      force: true, expectedPid: child.pid,
      expectedProcessStartIdentity: (BigInt(captured.processStartIdentity) + 1n).toString()
    }), /ownership changed/);
    assert.equal(processGenerationIsLive(child.pid, captured.processStartIdentity), true);
    let spawns = 0;
    faultArmed = true;
    const restarting = restartFileTaskController(home, {
      pollIntervalMs: 5, requestTimeoutMs: 500, shutdownTimeoutMs: holdOldProcess ? 30 : 1000,
      spawnController: async () => {
        spawns++;
        assert.equal(processGenerationIsLive(child.pid, captured.processStartIdentity), false,
          "a successor is not started until the exact old generation has exited");
        await childExit;
        successor = await startControllerServer(home);
        return process.pid;
      }
    });
    if (holdOldProcess) {
      await assert.rejects(restarting, error => unknownGeneration
        ? /Unverified process generation/.test(error.message)
        : error.code === "CONTROLLER_TIMEOUT");
      faultArmed = false;
      assert.equal(processGenerationIsLive(child.pid, captured.processStartIdentity), true);
      assert.equal(spawns, 0);
    } else {
      const result = await restarting;
      assert.equal(result.restarted, true);
      assert.equal(result.pid, process.pid);
      assert.equal(spawns, 1);
      assert.equal((await readControllerDiscovery(home)).homeId, captured.homeId);
    }
    assert.ok(errors.includes("ECONNRESET"), `expected a real status reset, observed ${errors}`);
    assert.equal(stopAcknowledged, true);
    assert.equal(discoveryMisses, 1);
}
