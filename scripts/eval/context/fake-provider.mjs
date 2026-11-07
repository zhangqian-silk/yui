// One disposable native owner per condition. Managed and detached clients see
// the SAME exact Thread/Turn/background state; unknown IDs are errors, not idle.
import { createServer as tcpServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pidIdentity, environmentInstructions, hash, save, now, isSessionRecovery, isBusinessScenario } from "./common.mjs";
import { handleTurn } from "./participant.mjs";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const threads = new Map(), connections = new Set();
let stopFaultInjected = false, leaderStarts = 0;
const http = httpServer(), ws = new WebSocketServer({ noServer: true });
http.on("upgrade", (request, socket, head) => ws.handleUpgrade(request, socket, head,
  client => ws.emit("connection", client, request, socket.fixtureEnvironment)));
const server = tcpServer(socket => {
  connections.add(socket); socket.on("close", () => connections.delete(socket));
  let b = Buffer.alloc(0);
  const handshake = chunk => {
    b = Buffer.concat([b, chunk]); const end = b.indexOf(10);
    if (end < 0) return;
    socket.removeListener("data", handshake);
    const { environment } = JSON.parse(b.subarray(0, end).toString());
    if (environment.COLLAB_EVAL_CONFIG !== process.argv[2]) return socket.destroy();
    socket.fixtureEnvironment = environment;
    socket.pause(); if (b.length > end + 1) socket.unshift(b.subarray(end + 1));
    http.emit("connection", socket); socket.resume();
  };
  socket.on("data", handshake);
});
ws.on("connection", (socket, request, environment) => {
  const send = m => { if (socket.readyState === 1) socket.send(JSON.stringify(m)); };
  // Report the requested policy, not unconditional successful exclusions.
  // The same proxy guard checks fake and real startup handshakes.
  const policy = params => ({ cwd: params.cwd, approvalPolicy: params.approvalPolicy,
    sandbox: { type: params.sandbox === "workspace-write" ? "workspaceWrite"
      : params.sandbox === "danger-full-access" ? "dangerFullAccess" : params.sandbox,
      writableRoots: params.runtimeWorkspaceRoots,
      excludeTmpdirEnvVar: params.config?.sandbox_workspace_write?.exclude_tmpdir_env_var,
      excludeSlashTmp: params.config?.sandbox_workspace_write?.exclude_slash_tmp,
      networkAccess: params.config?.sandbox_workspace_write?.network_access ?? false } });
  socket.on("message", bytes => {
    const m = JSON.parse(bytes.toString());
    if (m.id === undefined) return;
    const respond = result => send({ id: m.id, result });
    const error = message => send({ id: m.id, error: { code: -32602, message } });
    if (m.method === "initialize") return respond({ codexHome: environment.CODEX_HOME });
    if (m.method === "thread/start") {
      if (["native-normal", "normal-warm"].includes(config.scenario) || isSessionRecovery(config.scenario) || isBusinessScenario(config.scenario)) {
        // Offline launch-order proof only, not a model's load/understanding.
        const path = join(m.params.cwd, "AGENTS.md");
        let body; try { body = readFileSync(path, "utf8"); } catch {
          return error("Missing fixture startup guidance before thread/start");
        }
        if (!body.includes(environmentInstructions(join(environment.YUI_HOME, "../bin/yui"), config.product, config.cliEntryMode)))
          return error("Unexpected fixture startup guidance");
        save(join(config.evidence, `startup-access-${randomUUID()}.json`),
          { at: now(), cwd: m.params.cwd, path, bytes: Buffer.byteLength(body), sha256: hash(body),
            scope: "file present at native thread/start; not automatic inclusion or model comprehension" });
      }
      const row = { id: randomUUID(), turns: [], active: null, model: m.params.model ?? "fixture-default",
        role: environment.YUI_ROLE, shellEnvironment: m.params.config?.shell_environment_policy?.set ?? {},
        recoverySuccessor: isSessionRecovery(config.scenario) && environment.YUI_ROLE === "leader" && ++leaderStarts > 1 };
      threads.set(row.id, row);
      return respond({ ...policy(m.params), model: row.model, thread: { id: row.id, status: { type: "idle" }, turns: [] } });
    }
    const row = threads.get(m.params?.threadId);
    if (!row) return error("Unknown exact fixture Thread; no idle state fabricated");
    if (m.method === "thread/resume") {
      row.shellEnvironment = m.params.config?.shell_environment_policy?.set ?? {};
      return respond({ ...policy(m.params), model: row.model,
        thread: { id: row.id, status: { type: row.active ? "active" : "idle" }, turns: row.turns } });
    }
    if (m.method === "thread/read") return respond({ thread: { id: row.id,
      status: { type: row.active ? "active" : "idle" }, turns: row.turns } });
    if (m.method === "thread/turns/list") return respond({ data: row.turns, nextCursor: null });
    if (m.method === "thread/goal/get") return respond({ goal: null });
    if (m.method === "thread/backgroundTerminals/list") {
      // One explicit offline fault, after the stage-2 predecessor completed.
      // Do not invent idle/empty state; cleanup can inspect the actual state
      // afresh after this conclusive rejected observation.
      if (config.scenario === "session-recovery-stop-unknown" && row.role === "leader"
        && row.turns.length >= 2 && !row.active && !stopFaultInjected) {
        stopFaultInjected = true;
        save(join(config.evidence, "stop-unknown-injection.json"),
          { at: now(), threadId: row.id, method: m.method, fault: "exact predecessor background observation rejected once" });
        return error("Injected unknown predecessor background state; no idle proof");
      }
      return respond({ data: [], nextCursor: null });
    }
    if (m.method === "thread/backgroundTerminals/clean" || m.method === "thread/name/set") return respond({});
    if (m.method === "turn/interrupt") {
      const turn = row.turns.find(t => t.id === m.params.turnId);
      if (!turn) return error("Unknown exact fixture Turn");
      respond({});
      if (turn.status === "inProgress") {
        turn.status = "interrupted"; row.active = null;
        send({ method: "turn/completed", params: { threadId: row.id, turn } });
      }
      return;
    }
    if (m.method !== "turn/start") return error(`Unsupported fixture method ${m.method}`);
    if (row.active) return error("Exact Thread already has active Turn");
    const turn = { id: randomUUID(), status: "inProgress", items: [] };
    row.turns.push(turn); row.active = turn.id; respond({ turn });
    send({ method: "turn/started", params: { threadId: row.id, turn } });
    setImmediate(async () => {
      try {
        const text = await handleTurn({ threadId: row.id, turnId: turn.id,
          environment: { ...environment, ...row.shellEnvironment, CODEX_THREAD_ID: row.id }, input: m.params, config,
          initializationOnly: row.recoverySuccessor && row.turns.length === 1,
          command: (tool, phase = "completed") => {
            const id = tool.id ?? randomUUID();
            send({ method: `item/${phase}`, params: { threadId: row.id, turnId: turn.id,
              ...(phase === "completed" ? { completedAtMs: Date.now() } : {}),
              item: { type: "commandExecution", status: phase === "completed" ? "completed" : "inProgress",
                ...tool, id } } });
            return id;
          },
          cancelled: () => turn.status !== "inProgress" });
        if (turn.status !== "inProgress") return;
        const report = { id: randomUUID(), type: "agentMessage", text };
        send({ method: "item/started", params: { threadId: row.id, turnId: turn.id,
          item: { ...report, text: "" } } });
        send({ method: "item/completed", params: { threadId: row.id, turnId: turn.id, item: report } });
        turn.status = "completed"; turn.items = [report];
      } catch (e) {
        if (turn.status !== "inProgress") return;
        turn.status = "failed"; turn.error = { message: String(e) };
      }
      row.active = null; send({ method: "turn/completed", params: { threadId: row.id, turn } });
    });
  });
});
process.on("message", m => {
  if (m !== "finish") return;
  for (const socket of connections) socket.destroy();
  server.close(() => process.disconnect());
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
process.send({ host: "127.0.0.1", port: server.address().port, owner: pidIdentity(process.pid) });
