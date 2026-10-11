// Opt-in smoke instrumentation: transparent native proxy except a model-free
// preflight before exposing thread/start success. No native results are mocked.
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { openCodexInteractiveConnection } from "../../dist/runtime/structuredProviderHost.js";
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { preflightCodexExecution } from "./codex-execution-preflight.mjs";

export async function runProbeProxy(native, args, evidence, limit) {
  const proxy = args.at(-2) === "app-server" && args.at(-1) === "proxy";
  if (!proxy) {
    const child = spawn(native, args, {stdio: "inherit"});
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  // app-server proxy transports WebSocket bytes, not stdio JSONL. Reuse Yui's
  // real native connection and ws framing; do not implement another protocol.
  const nativeConnection = await openCodexInteractiveConnection({
    command: native, args, environment: process.env, cwd: process.cwd()
  }, true);
  const transport = new Duplex({read() {}, write(chunk, encoding, callback) {
    process.stdout.write(chunk, encoding, callback);
  }});
  process.stdin.on("data", chunk => transport.push(chunk));
  process.stdin.on("end", () => transport.push(null));
  const server = createServer(), sockets = new WebSocketServer({noServer: true, perMessageDeflate: false});
  let client, closing = false;
  const close = () => {closing = true; nativeConnection.close(); process.exit(0);};
  server.on("upgrade", (req, socket, head) => sockets.handleUpgrade(req, socket, head, ws => {
    client = ws;
    ws.on("message", data => receiveClient(data.toString()));
    ws.on("close", close);
  }));
  server.emit("connection", transport);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {
    close();
  });
  const pending = new Map(), starts = new Map();
  const send = (message) => void nativeConnection.send(message).catch(fail);
  const save = (name, data) => fs.writeFileSync(join(evidence, name), JSON.stringify(data, null, 2));
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = `execution-preflight-${randomUUID()}`;
    const timer = setTimeout(() => { pending.delete(id); reject(Error("Native preflight timeout")); }, 20000);
    pending.set(id, {resolve, reject, timer});
    send({id, method, params});
  });
  const fail = (error) => {
    if (closing) return;
    closing = true;
    save("preflight-failure.json", {at: new Date().toISOString(), error: String(error.stack ?? error)});
    nativeConnection.close(); process.exit(1);
  };
  nativeConnection.onClose(fail);
  function receiveClient(line) {
    try {
      const message = JSON.parse(line);
      if (message.method === "thread/start" || message.method === "thread/resume") starts.set(message.id, message.params);
      if (message.method === "turn/start") {
        const log = join(evidence, "model-requests.jsonl");
        const count = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").length : 0;
        if (count >= limit) throw Error("Explicit model request budget exhausted; request not forwarded");
        fs.appendFileSync(log, JSON.stringify({at: new Date().toISOString(), id: message.id,
          threadId: message.params.threadId}) + "\n");
      }
      send(message);
    } catch (error) { fail(error); }
  }
  nativeConnection.onMessage(async message => {
    try {
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id); clearTimeout(p.timer);
        if (message.error) p.reject(Error(JSON.stringify(message.error))); else p.resolve(message.result);
        return;
      }
      const params = starts.get(message.id);
      if (params && message.result) {
        starts.delete(message.id);
        const startup = message.result;
        const environment = params.config?.shell_environment_policy?.set;
        if (environment?.YUI_SESSION_MANIFEST) {
          assert.equal(startup.model, "gpt-6-luna");
          assert.equal(startup.approvalPolicy, "never");
          assert.equal(startup.sandbox.type, "dangerFullAccess",
            "Normal development fixture must receive the configured bypass strategy");
          const fixture = join(startup.cwd, "fixture-value.txt");
          const output = join(startup.cwd, "preflight-proof.json");
          save("native-startup.json", {params, startup, environment});
          if (!fs.existsSync(output)) {
            const daemon = fs.realpathSync(join(process.env.CODEX_HOME, "packages/app-server-daemon/current/bin/codex"));
            const schema = join(evidence, "daemon-schema");
            const generated = spawnSync(daemon, ["app-server", "generate-json-schema", "--out", schema],
              {encoding: "utf8", timeout: 10000});
            assert.equal(generated.status, 0, generated.stderr);
            const properties = JSON.parse(fs.readFileSync(join(schema, "v2/CommandExecParams.json"), "utf8")).properties;
            for (const key of ["command", "env", "cwd", "sandboxPolicy", "timeoutMs"]) assert.ok(properties[key], `Native version lacks ${key}`);
            save("native-version.json", {path: daemon,
              version: spawnSync(daemon, ["--version"], {encoding: "utf8", timeout: 5000}).stdout.trim(),
              sha256: createHash("sha256").update(fs.readFileSync(daemon)).digest("hex"),
              commandSchemaSha256: createHash("sha256").update(fs.readFileSync(join(schema, "v2/CommandExecParams.json"))).digest("hex")});
            // Separate sandbox diagnostic, not a passed isolation assertion.
            // Do not alter host capabilities or silently downgrade this probe.
            const sandboxDiagnostic = await request("command/exec", {
              command: ["/bin/true"], cwd: startup.cwd, env: environment,
              sandboxPolicy: {type: "readOnly", networkAccess: false}, timeoutMs: 5000
            });
            save("readonly-diagnostic.json", {sandboxPolicy: {type: "readOnly", networkAccess: false},
              result: sandboxDiagnostic});
            if (!fs.existsSync(fixture)) fs.writeFileSync(fixture, randomUUID() + "\n", {flag: "wx"});
            const proof = await preflightCodexExecution(request, {
              startup, environment, node: process.execPath, fixture, output
            });
            save("preflight.json", proof);
          }
        }
      }
      if (message.method === "turn/started" || message.method === "turn/completed") {
        fs.appendFileSync(join(evidence, "native-turns.jsonl"), JSON.stringify(message) + "\n");
      }
      if (message.method === "item/completed") {
        fs.appendFileSync(join(evidence, "native-items.jsonl"), JSON.stringify(message) + "\n");
      }
      client.send(JSON.stringify(message));
    } catch (error) { fail(error); }
  });
}
