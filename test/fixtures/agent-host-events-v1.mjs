/**
 * Frozen minimum-supported Host wire fixture, introduced with Home 22.
 * Implements the v1 Inbox envelope, v5 status, and RPC-v4 discovery directly; imports NO
 * current Yui code (and never a database). Do not update this producer when
 * changing Controller contracts. It is not a pre-fix released legacy Host.
 * IPC is the disposable fake Provider; the process and Session stay alive
 * while its test replaces the Controller and migrates the Home.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync, linkSync, unlinkSync, chmodSync,
  readFileSync, lstatSync, statSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { dirname, join } from "node:path";

const [home, socket, workspace] = process.argv.slice(2);
const session = "original-session";
let sequence = 0;
const emitted = new Set();
const server = createServer({ allowHalfOpen: true }, client => {
  client.resume();
  client.on("end", () => client.end(JSON.stringify({
    protocol: "yui-agent-host/v5", outcome: "status",
    snapshot: {
      schemaVersion: 2, state: "ready", adapterId: "codex", nativeSessionId: session,
      attemptId: "original-attempt", updatedAt: new Date().toISOString(),
      compatibility: { control: "yui-agent-host/v5", events: "yui-agent-host-events/v1", rpc: 4, storage: "controller-owned" }
    }
  })));
});
mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
server.listen(socket, () => {
  chmodSync(socket, 0o600);
  process.send({ ready: true, pid: process.pid });
});
process.on("message", message => {
  void handleProviderMessage(message).catch(error => process.send({ pid: process.pid, error: String(error) }));
});

async function handleProviderMessage({ kind, output, eventId: replayId }) {
  if (kind === "stop") {
    server.close(() => process.disconnect());
    return;
  }
  if (kind === "replay") {
    if (!emitted.has(replayId)) throw new Error("Only this producer's original fact may be replayed.");
    process.send({ emitted: replayId, pid: process.pid, sequence, remote: await notifyController(replayId) });
    return;
  }
  const eventId = `agent-host-${randomUUID()}`;
  const receivedAt = new Date().toISOString();
  const fence = {
    taskId: "task-1", roleName: "worker", agentId: "codex", driverId: "openai/codex",
    nativeSessionId: session, conversationId: session,
    receiptId: "original-attempt", nativeTurnId: "original-turn"
  };
  const semanticKey = kind === "turn.completed"
    ? "terminal:openai/codex:codex:original-session:none:original-attempt:turn.completed:terminal:none:turn-terminal"
    : `provider-event:${eventId}`;
  const observation = {
    schemaVersion: 4, eventId, semanticKey, kind, authority: "provider-structured",
    receivedAt, observedAt: receivedAt, sequence: ++sequence, ordinal: 0, fence,
    payload: kind === "turn.completed" ? { output } :
      kind === "activity.observed" ? { activity: "model", activityId: `item-${sequence}` } : {}
  };
  const id = `turn-${createHash("sha256").update(JSON.stringify([
    2, "runtime-observation", fence.taskId, fence.roleName, semanticKey
  ])).digest("hex")}`;
  const directory = join(home, "runtime", "inbox");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.${id}-${randomUUID()}`);
  const fd = openSync(temp, "wx", 0o600);
  writeFileSync(fd, JSON.stringify({
    schemaVersion: 1, id, type: "runtime-observation", receivedAt, scope: "task", taskId: fence.taskId,
    observation, host: { protocol: "yui-agent-host-events/v1", adapterId: "codex", workspace }
  }));
  fsyncSync(fd);
  closeSync(fd);
  linkSync(temp, join(directory, `${id}.json`));
  unlinkSync(temp);
  const dir = openSync(directory, "r");
  fsyncSync(dir);
  closeSync(dir);
  emitted.add(id);
  process.send({ emitted: id, pid: process.pid, sequence, remote: await notifyController(id) });
}

/** Frozen RPC-v4 client, independently encoded from the current Controller.
 * Every hint rediscovers the Home/instance/token; no cached socket or DB read. */
async function notifyController(eventId) {
  let discovery;
  try {
    const path = join(home, "runtime", "controller.json");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Invalid discovery permissions");
    }
    discovery = JSON.parse(readFileSync(path, "utf8"));
    const physical = statSync(home, { bigint: true });
    if (discovery.schemaVersion !== 1 || discovery.protocolVersion !== 4
      || discovery.homeFilesystemId !== `${physical.dev}:${physical.ino}`
      || !/^home-[a-f0-9]+$/.test(discovery.homeId)
      || discovery.socketPath !== join("/tmp", `yui-${process.getuid()}`, `${discovery.homeId}.sock`)
      || !/^[a-f0-9]{64}$/.test(discovery.token)
      || !/^[a-f0-9]{32}$/.test(discovery.controllerInstanceId)) {
      throw new Error("Invalid RPC-v4 discovery fence");
    }
    const requestId = randomUUID();
    const request = {
      id: requestId, token: discovery.token, protocolVersion: 4,
      homeId: discovery.homeId, homeFilesystemId: discovery.homeFilesystemId,
      controllerInstanceId: discovery.controllerInstanceId,
      method: "runtime.host-observation-apply", params: { eventId }
    };
    const reply = await new Promise((resolve, reject) => {
      const client = createConnection(discovery.socketPath);
      let buffer = "", settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error("RPC-v4 hint timed out")), 100);
      client.on("connect", () => client.write(`${JSON.stringify(request)}\n`));
      client.on("error", error => finish(error));
      client.on("end", () => finish(new Error("RPC-v4 acknowledgement missing")));
      client.on("data", bytes => {
        buffer += bytes;
        if (Buffer.byteLength(buffer) > 1_048_576) return finish(new Error("Oversized RPC-v4 response"));
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, end));
          if (response.id !== requestId || response.ok !== true) throw new Error("RPC-v4 hint rejected");
          finish(null, response.result);
        } catch (error) { finish(error); }
      });
    });
    return { outcome: reply.outcome, controllerInstanceId: discovery.controllerInstanceId };
  } catch (error) {
    // Persistence already happened. Outage/hand-over only delays application.
    return { outcome: "pending", reason: String(error),
      ...(discovery === undefined ? {} : { controllerInstanceId: discovery.controllerInstanceId }) };
  }
}
