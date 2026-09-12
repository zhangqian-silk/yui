import { createInterface } from "node:readline";

const sessionId = process.argv[2];
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`);
  if (process.env.YUI_FAKE_CONTROLLED === "1" && message.type === "user") {
    process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: sessionId,
      uuid: `assistant-${Date.now()}`, message: { role: "assistant", content: [] } })}\n`);
  }
});
