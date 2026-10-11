// Deterministic native UI boundary, not the actual Codex TUI. The real Host
// relay, tmux and Web PTYs still own authentication, Thread and writer fencing.
import WebSocket from "ws";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const threadId = args[args.indexOf("resume") + 1];
const socket = new WebSocket(args[args.indexOf("--remote") + 1], {
  headers: { authorization: `Bearer ${process.env[args[args.indexOf("--remote-auth-token-env") + 1]]}` }
});
socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "initialize", params: {} })));
socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.error) throw new Error(JSON.stringify(message.error));
  if (message.id === 1) socket.send(JSON.stringify({
    id: 2, method: "thread/resume", params: { threadId }
  }));
  if (message.id === 2) {
    if (message.result.thread.id !== threadId) throw new Error("Wrong resumed Thread");
    appendFileSync(process.env.YUI_FAKE_TUI_LOG, JSON.stringify({ event: "attached", threadId }) + "\n");
    process.stdout.write(`\r\nDeterministic native view: ${threadId}\r\n`);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", bytes => {
      appendFileSync(process.env.YUI_FAKE_TUI_LOG, JSON.stringify({ event: "input", threadId, text: bytes.toString() }) + "\n");
      process.stdout.write(bytes);
    });
  }
});
