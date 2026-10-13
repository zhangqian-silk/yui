import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let input = Buffer.alloc(0);
let upgraded = false;
let turnSequence = 0;
let activeTurnId;
let latestTurn;
let model = "fixture-default";
const controlled = process.env.YUI_FAKE_CONTROLLED === "1";
let threadId = process.env.YUI_FAKE_THREAD_ID ?? "fake-thread-1";
// Optional deterministic tool work for offline lifecycle exercises. Ordinary
// package smoke keeps its existing fixed reply and does not load a handler.
const turnHandler = process.env.YUI_FAKE_TURN_HANDLER === undefined ? undefined
  : (await import(process.env.YUI_FAKE_TURN_HANDLER)).handleTurn;

// Fixture-only ingress for notifications emitted by another Desktop client.
// It never calls turn/start on the Host's transport.
if (process.env.YUI_FAKE_DIRECT_PORT_FILE) {
  const server = createServer(socket => {
    let data = "";
    socket.on("data", chunk => {
      data += chunk;
      if (!data.endsWith("\n")) return;
      for (const event of JSON.parse(data)) sendJson(event);
      socket.end("observed\n");
    });
  });
  server.listen(0, "127.0.0.1", () =>
    writeFileSync(process.env.YUI_FAKE_DIRECT_PORT_FILE, String(server.address().port)));
  // The Host's stdio transport owns this fake Provider's lifetime. The optional
  // Desktop ingress must not keep it alive after that transport closes.
  server.unref();
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (!upgraded) upgrade();
  if (upgraded) receiveFrames();
});

function upgrade() {
  const end = input.indexOf("\r\n\r\n");
  if (end < 0) return;
  const request = input.subarray(0, end).toString("utf8");
  input = input.subarray(end + 4);
  const key = /^sec-websocket-key:\s*(.+)$/imu.exec(request)?.[1]?.trim();
  if (key === undefined) process.exit(2);
  const accept = createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
  process.stdout.write(
    `HTTP/1.1 101 Switching Protocols\r\n`
    + `Upgrade: websocket\r\n`
    + `Connection: Upgrade\r\n`
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  upgraded = true;
}

function receiveFrames() {
  for (;;) {
    if (input.length < 2) return;
    const opcode = input[0] & 0x0f;
    const masked = (input[1] & 0x80) !== 0;
    let length = input[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (input.length < 4) return;
      length = input.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (input.length < 10) return;
      const wide = input.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) process.exit(3);
      length = Number(wide);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (input.length < offset + maskLength + length) return;
    const mask = masked ? input.subarray(offset, offset + 4) : undefined;
    offset += maskLength;
    const payload = Buffer.from(input.subarray(offset, offset + length));
    input = input.subarray(offset + length);
    if (mask !== undefined) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    if (opcode === 0x8) {
      sendFrame(0x8, payload);
      process.exit(0);
    }
    if (opcode === 0x9) {
      sendFrame(0xA, payload);
      continue;
    }
    if (opcode !== 0x1) continue;
    handleMessage(JSON.parse(payload.toString("utf8")));
  }
}

function handleMessage(message) {
  const respond = (result) => sendJson({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      respond({ codexHome: process.env.CODEX_HOME ?? "/tmp/fake-codex-home" });
      break;
    case "thread/start":
      if (process.env.YUI_FAKE_UNIQUE_THREADS === "1") threadId += `-${randomUUID()}`;
      model = message.params.model ?? model;
      respond({ model, thread: { id: threadId, status: { type: "idle" }, turns: [] } });
      break;
    case "thread/resume":
      threadId = message.params.threadId;
      model = message.params.model ?? model;
      respond({ model, thread: { id: message.params.threadId, status: { type: "idle" },
        turns: JSON.parse(process.env.YUI_FAKE_RESUMED_TURNS ?? "[]") } });
      break;
    case "thread/name/set":
      if (process.env.YUI_FAKE_EXPECT_THREAD_NAME !== undefined
        && message.params.name !== process.env.YUI_FAKE_EXPECT_THREAD_NAME) {
        sendJson({
          id: message.id,
          error: { code: -32602, message: "unexpected thread name" }
        });
      } else if (process.env.YUI_FAKE_REJECT_THREAD_NAME === "1") {
        sendJson({
          id: message.id,
          error: { code: -32601, message: "thread naming is unavailable" }
        });
      } else {
        respond({});
      }
      break;
    case "thread/read":
      respond({
        thread: {
          id: message.params.threadId ?? threadId,
          status: { type: activeTurnId !== undefined ? "active" : latestTurn?.status === "failed" ? "systemError" : "idle" },
          turns: activeTurnId === undefined ? (latestTurn ? [latestTurn] : JSON.parse(process.env.YUI_FAKE_RESUMED_TURNS ?? "[]"))
            : [{ id: activeTurnId, status: "inProgress", items: [] }]
        }
      });
      break;
    case "thread/turns/list":
      respond({ data: latestTurn ? [latestTurn] : JSON.parse(process.env.YUI_FAKE_RESUMED_TURNS ?? "[]"), nextCursor: null });
      break;
    case "thread/items/list": {
      const turns = JSON.parse(process.env.YUI_FAKE_RESUMED_TURNS ?? "[]");
      const items = turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse();
      const offset = Number(message.params.cursor ?? 0);
      const limit = message.params.limit ?? 40;
      respond({ data: items.slice(offset, offset + limit),
        nextCursor: offset + limit < items.length ? String(offset + limit) : null });
      break;
    }
    case "thread/goal/get":
      respond({ goal: null });
      break;
    case "thread/backgroundTerminals/clean":
      respond({});
      break;
    case "thread/backgroundTerminals/list":
      respond({ data: [], nextCursor: null });
      break;
    case "turn/start":
      turnSequence += 1;
      const turnId = `fake-turn-${turnSequence}`;
      if (controlled || turnHandler) activeTurnId = turnId;
      respond({ turn: { id: turnId, status: "inProgress", items: [], error: null } });
      setImmediate(async () => {
        if (process.env.YUI_FAKE_PROTOCOL_EVENTS !== undefined) {
          for (const event of JSON.parse(process.env.YUI_FAKE_PROTOCOL_EVENTS)) sendJson(event);
          return;
        }
        sendJson({
          method: "turn/started",
          params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } }
        });
        if (process.env.YUI_FAKE_CAPACITY_FAILURE === "1" && turnSequence === 1) {
          const error = {
            message: "Selected model is at capacity. Please try a different model.",
            codexErrorInfo: "serverOverloaded", additionalDetails: null, misalignment: null
          };
          sendJson({ method: "error", params: { threadId, turnId, error, willRetry: true } });
          sendJson({ method: "turn/completed", params: {
            threadId, turn: { id: turnId, status: "failed", error, items: [] }
          } });
          return;
        }
        if (controlled) return;
        let text = "Native Codex result.";
        let failure;
        try {
          if (turnHandler) text = await turnHandler({
            threadId, turnId, input: message.params,
            environment: { ...process.env, CODEX_THREAD_ID: threadId }
          });
        } catch (error) {
          failure = String(error);
        }
        // An interrupt is a terminal, never followed by a fabricated success.
        if (turnHandler && activeTurnId !== turnId) return;
        activeTurnId = undefined;
        sendJson({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: failure ? "failed" : "completed",
              ...(failure ? { error: { message: failure } } : {}),
              items: [{ id: "item-1", type: "agentMessage", text: failure ?? text }]
            }
          }
        });
      });
      break;
    case "turn/steer":
      respond({ turnId: `fake-turn-${turnSequence}` });
      break;
    case "turn/interrupt":
      respond({});
      activeTurnId = undefined;
      setImmediate(() => sendJson({
        method: "turn/completed",
        params: { threadId, turn: {
          id: `fake-turn-${turnSequence}`, status: "interrupted", items: []
        } }
      }));
      break;
    default:
      break;
  }
}

function sendJson(value) {
  if (value.method === "turn/started" && value.params.threadId === threadId) {
    activeTurnId = value.params.turn.id;
  }
  if (value.method === "turn/completed" && value.params.threadId === threadId
    && typeof value.params.turn?.id === "string"
    && ["completed", "failed", "interrupted"].includes(value.params.turn.status)) {
    latestTurn = value.params.turn;
    if (activeTurnId === latestTurn.id) activeTurnId = undefined;
  }
  sendFrame(0x1, Buffer.from(JSON.stringify(value), "utf8"));
}

function sendFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  process.stdout.write(Buffer.concat([header, payload]));
}
