// Bounded pre-capability v1 Host wire fixture. Deliberately does not import
// current Host parsing/dispatch: installing a new Controller cannot update it.
import { createServer } from "node:net";
import { rmSync } from "node:fs";

const path = process.argv[2];
const snapshot = {
  schemaVersion: 1, state: "idle", adapterId: "codex",
  nativeSessionId: "old-session", processInstanceId: "old-process",
  endpointImplementation: { id: "yui.agent-endpoint.codex", generation: "old-build" },
  updatedAt: new Date().toISOString()
};
const server = createServer({ allowHalfOpen: true }, socket => {
  let text = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", chunk => { text += chunk; });
  socket.on("end", () => {
    const request = JSON.parse(text);
    process.send?.(request.type);
    socket.end(JSON.stringify(request.type === "status"
      ? { protocol: "yui-agent-host-control/v1", outcome: "status", snapshot }
      : { protocol: "yui-agent-host-control/v1", outcome: "rejected", snapshot,
        failure: { phase: "turn-submit", inputDisposition: "not-accepted",
          detail: "Agent Host control type is invalid." } }));
  });
});
server.listen(path, () => process.send?.("ready"));
process.on("SIGTERM", () => server.close(() => { rmSync(path, { force: true }); process.exit(0); }));
