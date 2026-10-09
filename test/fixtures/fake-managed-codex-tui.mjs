// Local protocol client only. No provider, account, model or Controller.
import WebSocket from "ws";
import { nativeTurnStart } from "./managed-codex-native-shape.mjs";
const url = process.argv[process.argv.indexOf("--remote") + 1];
const socket = new WebSocket(url, {
  headers: { authorization: `Bearer ${process.env.YUI_CODEX_REMOTE_AUTH_TOKEN}` }
});
const send = value => socket.send(JSON.stringify(value));
const timer = setTimeout(() => process.exit(2), 3000);
let resolved = 0;
socket.on("open", () => send({ id: 1, method: "initialize", params: {} }));
socket.on("message", bytes => {
  const message = JSON.parse(bytes.toString());
  if (message.error) process.exit(3);
  if (message.id === 1) send({ id: 2, method: "thread/resume", params: { threadId: "thread" } });
  if (message.id === 2) send({ id: 3, method: "turn/start", params: nativeTurnStart });
  if (message.id === "approval") send({ id: "approval", result: { decision: "decline" } });
  if (message.id === "mcp-form") send({ id: message.id, result: { action: "accept", content: { choice: "yes" } } });
  if (message.id === "mcp-url") send({ id: message.id, result: { action: "cancel", content: null } });
  if (message.method === "serverRequest/resolved" && ++resolved === 3) { clearTimeout(timer); socket.close(); }
});
socket.on("close", () => { clearTimeout(timer); process.exit(0); });
