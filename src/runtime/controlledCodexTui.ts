import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { JsonObject } from "./jsonLineChannel.js";
import type { AgentHostLaunchPayload } from "./launchBroker.js";
import type { CodexNativeAccess } from "./codexNativeAccess.js";
import { localCodexTuiEnvironment } from "./codexInteractiveHost.js";

/** The TUI is a view of the Host-owned connection. It cannot launch, fork,
 * reconfigure, or submit outside the Host's existing input admission. */
export async function openControlledCodexTui(
  payload: AgentHostLaunchPayload, threadId: string, access: CodexNativeAccess,
  input: {
    mutate(method: string, params: JsonObject): Promise<JsonObject>;
    respond(id: string | number, turnId: string, result: JsonObject): Promise<void>;
    onExit(): void;
    onError(error: unknown): void;
  }
): Promise<{ close(): void }> {
  const baseArgs: unknown = JSON.parse(payload.environment.YUI_AGENT_BASE_ARGS ?? "[]");
  if (!Array.isArray(baseArgs) || baseArgs.some(arg => typeof arg !== "string")) throw new Error("Invalid Codex base arguments.");
  const token = randomBytes(32).toString("hex");
  const server = new WebSocketServer({
    host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024, perMessageDeflate: false,
    verifyClient: (info: { req: IncomingMessage }) => info.req.headers.authorization === `Bearer ${token}`
  });
  let socket: WebSocket | undefined;
  let closed = false;
  let markReady!: () => void;
  let failReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject; });
  void ready.catch(() => {});
  const unsubscribe = access.events(message => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  });
  server.on("connection", client => {
    if (socket || closed) { client.close(1008, "TUI already attached."); return; }
    socket = client;
    client.on("error", input.onError);
    client.on("message", (bytes, binary) => {
      void (async () => {
        if (binary) throw new Error("Expected native JSON request.");
        const message = JSON.parse(bytes.toString()) as JsonObject;
        const id = message.id;
        if (typeof id !== "number" && typeof id !== "string") return; // notifications
        try {
          if (message.method === undefined) {
            const request = access.requests.find(request => request.id === id);
            if (!request) throw new Error("Native request is no longer pending.");
            await input.respond(id, request.turnId, message.result as JsonObject);
            return;
          }
          const method = String(message.method), params = (message.params ?? {}) as JsonObject;
          if (method === "turn/start") access.validateTurn(params);
          const result = method === "initialize" ? access.initialized
            : ["turn/start", "turn/steer", "turn/interrupt"].includes(method) ? await input.mutate(method, params)
              : await access.read(method, params);
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id, result }));
          if (method === "thread/resume") {
            markReady();
            for (const request of access.requests) client.send(JSON.stringify({
              id: request.id, method: request.method, params: request.params
            }));
          }
        } catch (error) {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({
            id, error: { code: -32600, message: error instanceof Error ? error.message : String(error) }
          }));
        }
      })().catch(input.onError);
    });
  });
  try { await once(server, "listening"); }
  catch (error) { unsubscribe(); server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Native TUI relay did not bind.");
  const child = spawn(payload.command, [...baseArgs,
    "--remote", `ws://127.0.0.1:${address.port}`, "--remote-auth-token-env", "YUI_CODEX_REMOTE_AUTH_TOKEN",
    "resume", threadId], {
    cwd: payload.cwd, stdio: "inherit",
    env: { ...localCodexTuiEnvironment(payload.environment), YUI_CODEX_REMOTE_AUTH_TOKEN: token }
  });
  const close = () => {
    if (closed) return;
    closed = true; unsubscribe(); socket?.terminate(); server.close(); child.kill("SIGTERM");
  };
  server.on("error", input.onError);
  child.on("error", error => { failReady(error); input.onError(error); close(); input.onExit(); });
  child.once("exit", () => { failReady(new Error("Native TUI exited before attachment.")); close(); input.onExit(); });
  const deadline = setTimeout(() => failReady(new Error("Native TUI did not attach to the selected Thread.")), 10_000);
  try { await ready; } catch (error) { close(); throw error; } finally { clearTimeout(deadline); }
  return { close };
}
