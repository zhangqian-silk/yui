// Same external executable boundary for both modes. No business/oracle imports.
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pidIdentity, now, redactTransport } from "./common.mjs";
import { attributeNativeEvents, nativeDiagnostic, nativeControlObservation } from "./native-ownership.mjs";
import { assertIsolationRequest, assertIsolationReceipt } from "./isolation.mjs";
const descriptor = JSON.parse(readFileSync(process.env.COLLAB_EVAL_CONFIG, "utf8"));
const args = process.argv.slice(2);
if (args.includes("daemon") && !args.includes("version")) throw Error("Shared daemon mutation forbidden");
// Match the actual product launch suffix, not managed identity or arbitrary
// occurrences in config values/help arguments. Detached proxies are still WS.
const proxy = args.at(-2) === "app-server" && args.at(-1) === "proxy"
  && !args.some(a => ["--help", "-h", "--version", "-V"].includes(a));
const commandClass = proxy ? "app-server-proxy"
  : args.some(a => ["--version", "-V", "version"].includes(a)) ? "version"
  : args.some(a => ["--help", "-h", "help"].includes(a)) ? "help" : "ordinary";
if (descriptor.mode === "fake" && !proxy) {
  await import("../../../test/fixtures/fake-codex-cli.mjs");
} else {
  // Captured by the Host-owned proxy, never supplied by subject tool output.
  // Native metadata/control clients intentionally have no managed identity.
  // Keep their transport, but never invent a Task/Role binding from config.
  const managed = proxy && process.env.YUI_HOME && process.env.YUI_ROLE && process.env.YUI_SESSION_MANIFEST;
  const binding = managed ? { taskId: process.env.YUI_TASK_ID, roleName: process.env.YUI_ROLE,
    home: process.env.YUI_HOME, cli: join(process.env.YUI_HOME, "../bin/yui"),
    product: descriptor.product, node: process.execPath, manifestPath: process.env.YUI_SESSION_MANIFEST,
    ...(descriptor.originalTool ? { originalTool: descriptor.originalTool } : {}) } : undefined;
  const log = value => appendFileSync(join(descriptor.evidence, `transport-${process.pid}.jsonl`),
    JSON.stringify({ at: now(), connectionKind: !proxy ? "metadata" : managed ? "managed" : "detached-control",
      protocol: proxy ? "app-server-ws" : "ordinary-stdio", commandClass,
      binding, ...redactTransport(value) }) + "\n");
  // Retain only tiny request/response identity history, not broadcast bodies.
  // Valid forwarding is unchanged. Unproven input stays explicitly metadata-only.
  const controls = [], controlIds = new Set(), inspections = new Map();
  const startups = new Map(), isolatedThreads = new Set();
  let rejectedStartup;
  function capture(direction, message) {
    const event = { at: now(), binding, sourceConnection: `transport-${process.pid}.jsonl`, direction, message };
    const owned = attributeNativeEvents([...controls, event]).events.includes(event);
    const id = JSON.stringify(message.id);
    if (direction === "host" && message.id !== undefined
      && ["thread/read", "thread/backgroundTerminals/clean", "thread/backgroundTerminals/list"].includes(message.method))
      inspections.set(id, inspections.has(id) ? null : { id: message.id, method: message.method,
        params: { threadId: message.params?.threadId } });
    const controlObservation = direction === "native" && message.id !== undefined
      ? nativeControlObservation(inspections.get(id), message) : undefined;
    if (direction === "native" && message.id !== undefined) inspections.delete(id);
    log({ at: event.at, direction, message: owned ? message : nativeDiagnostic(message),
      nativeContent: owned ? "owned-full" : "unattributed-metadata", controlObservation });
    // Enforce only fixture subject launches, never detached native account
    // metadata/control clients. This is a refusal, not a permission rewrite.
    if (managed) {
      const root = join(process.env.YUI_HOME, ".."), id = JSON.stringify(message.id);
      if (direction === "host" && ["thread/start", "thread/resume"].includes(message.method)) {
        assertIsolationRequest(message.params, root, descriptor.permissionMode);
        startups.set(id, { params: message.params, method: message.method, requestId: message.id });
      } else if (direction === "host" && message.method === "turn/start"
        && !isolatedThreads.has(message.params?.threadId)) {
        throw Error("Isolation model Turn requires an acknowledged matching sandbox receipt");
      } else if (direction === "native" && startups.has(id)) {
        const startup = startups.get(id); startups.delete(id);
        if (message.result) {
          rejectedStartup = { method: startup.method, requestId: startup.requestId,
            threadId: message.result.thread?.id };
          assertIsolationReceipt(message.result, startup.params, root, descriptor.permissionMode);
          rejectedStartup = undefined;
          isolatedThreads.add(message.result.thread.id);
        }
      }
    }
    if (direction === "host" && ["thread/start", "thread/resume", "turn/start"].includes(message.method)
      && message.id !== undefined) {
      controlIds.add(JSON.stringify(message.id));
      controls.push({ ...event, message: { id: message.id, method: message.method,
        params: { cwd: message.params?.cwd, threadId: message.params?.threadId } } });
    } else if (direction === "native" && message.id !== undefined && controlIds.has(JSON.stringify(message.id))) {
      controls.push({ ...event, message: { id: message.id, error: message.error ? { code: message.error.code } : undefined,
        result: message.result ? { thread: message.result.thread ? {
          id: message.result.thread.id, cwd: message.result.thread.cwd } : undefined,
        turn: message.result.turn ? { id: message.result.turn.id } : undefined } : undefined } });
    }
  }
  // Capture decoded WS messages for both modes. Credential fields are removed;
  // stderr/config/account payloads are never persisted.
  function decoder(direction) {
    let buffer = Buffer.alloc(0), upgraded = false, fragments = [], fragmentBytes = 0, finished = false;
    const push = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n"); if (end < 0) return;
        // Record only a protocol category, never headers (which can carry auth).
        const firstLine = buffer.subarray(0, buffer.indexOf("\r\n")).toString("ascii");
        const phase = /^GET \S+ HTTP\/1\.[01]$/.test(firstLine) ? "upgrade-request"
          : /^HTTP\/1\.[01] 101(?: |$)/.test(firstLine) ? "upgrade-response" : undefined;
        if (!phase) throw Error("Unexpected app-server WS upgrade header");
        log({ direction, protocolEvidence: phase });
        buffer = buffer.subarray(end + 4); upgraded = true;
      }
      while (buffer.length >= 2) {
        let n = buffer[1] & 127, o = 2; const masked = !!(buffer[1] & 128);
        if (n === 126) { if (buffer.length < 4) return; n = buffer.readUInt16BE(2); o = 4; }
        if (n === 127) { if (buffer.length < 10) return; n = Number(buffer.readBigUInt64BE(2)); o = 10; }
        if (n > 32 * 1024 * 1024) throw Error("Oversized native frame");
        if (buffer.length < o + (masked ? 4 : 0) + n) return;
        const mask = masked ? buffer.subarray(o, o + 4) : null; o += masked ? 4 : 0;
        let b = Buffer.from(buffer.subarray(o, o + n));
        const op = buffer[0] & 15, fin = Boolean(buffer[0] & 0x80);
        buffer = buffer.subarray(o + n);
        if (mask) for (let i = 0; i < b.length; i++) b[i] ^= mask[i % 4];
        if ([8, 9, 10].includes(op)) continue;
        if (op === 1 && fragments.length || op === 0 && !fragments.length || ![0, 1].includes(op))
          throw Error("Unsupported/interleaved native WS message");
        if (op === 0 || !fin) {
          fragments.push(b); fragmentBytes += b.length;
          if (fragmentBytes > 32 * 1024 * 1024) throw Error("Oversized fragmented native message");
          if (!fin) continue;
          b = Buffer.concat(fragments); fragments = []; fragmentBytes = 0;
        }
        let message;
        try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b)); }
        catch { log({ direction, invalidFrame: true }); continue; }
        capture(direction, message);
      }
    };
    push.finish = () => {
      if (finished) return;
      finished = true;
      if (buffer.length || fragments.length) log({ direction, invalidFrame: {
        reason: "incomplete WS payload at stream end", pendingBytes: buffer.length + fragmentBytes } });
    };
    return push;
  }
  let upstream, child, failed = false;
  const fail = error => {
    if (failed) return;
    failed = true;
    log({ direction: "isolation-rejected", error: String(error), startup: rejectedStartup, fallback: "none" });
    process.stdin.pause(); upstream.end(); child?.kill("SIGTERM");
    if (!child) process.exit(1);
  };
  if (descriptor.mode === "fake") {
    const endpoint = descriptor.endpoint;
    const actual = pidIdentity(endpoint.owner.pid);
    if (actual?.start !== endpoint.owner.start || endpoint.host !== "127.0.0.1") throw Error("Provider owner changed");
    upstream = createConnection({ host: endpoint.host, port: endpoint.port });
    upstream.write(JSON.stringify({ environment: { ...process.env } }) + "\n");
  } else {
    child = spawn(descriptor.providerBin, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    upstream = child.stdin;
    child.stderr.on("data", b => {
      log({ direction: "stderr", bytes: b.length, body: "omitted" });
      process.stderr.write(b);
    });
    child.once("error", e => { log({ direction: "spawn-error", code: e.code }); process.exitCode = 1; });
    // exit may precede the last stdout chunk. Wait for stdio close before exit.
    child.once("close", (code, signal) => {
      log({ direction: "exit", code, signal, nativeLifecycle: "not-observed" });
      // An executable's close is not a Subject native Turn/Thread terminal.
      process.stdout.end(() => process.stderr.write("", () => {
        if (!failed && signal) {
          process.removeAllListeners(signal);
          process.kill(process.pid, signal);
        } else process.exit(failed ? 1 : code ?? 1);
      }));
    });
    log({ direction: "custody", child: pidIdentity(child.pid) });
  }
  const incoming = proxy ? decoder("native") : undefined, outgoing = proxy ? decoder("host") : undefined;
  const output = child ? child.stdout : upstream;
  output.on("data", b => {
    if (failed) return;
    try { incoming?.(b); process.stdout.write(b); } catch (error) { fail(error); }
  });
  output.once("end", () => incoming?.finish());
  output.once("close", () => incoming?.finish());
  process.stdin.on("data", b => {
    if (failed) return;
    try { outgoing?.(b); upstream.write(b); } catch (error) { fail(error); }
  });
  process.stdin.on("end", () => { outgoing?.finish(); upstream.end(); });
  if (!child) {
    upstream.on("close", () => process.exit(0));
    upstream.on("error", e => { log({ direction: "error", code: e.code }); process.exit(1); });
  }
  process.on("SIGTERM", () => {
    log({ direction: "stop-signal", signal: "SIGTERM", child: child ? pidIdentity(child.pid) : undefined });
    upstream.end(); child?.kill("SIGTERM"); if (!child) process.exit(0);
  });
}
