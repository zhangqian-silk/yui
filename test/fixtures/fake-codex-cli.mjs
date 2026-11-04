// Deterministic external boundary for the assembled-package smoke. No model,
// account, network, or real Codex installation is used.
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.150.1");
} else if (args.includes("--help")) {
  console.log("--model --config --profile --add-dir --search --dangerously-bypass-approvals-and-sandbox\n"
    + "  --sandbox [possible values: read-only, workspace-write, danger-full-access]\n"
    + "  --ask-for-approval [possible values: untrusted, on-request, never]");
} else if (args.includes("app-server") && args.includes("daemon") && args.includes("version")) {
  console.log(JSON.stringify({ status: "running", appServerVersion: "0.150.1" }));
} else if (args.includes("app-server") && args.includes("proxy")) {
  process.env.YUI_FAKE_THREAD_ID = `fixture-${process.env.YUI_TASK_ID ?? "global"}-${process.env.YUI_ROLE ?? "reader"}`;
  await import("./fake-codex-app-server-proxy.mjs");
} else if (args.includes("--remote") && process.env.YUI_FAKE_TUI_LOG) {
  await import("./fake-codex-tui.mjs");
} else if (args.includes("app-server") && (args.includes("--stdio") || args.includes("stdio://"))) {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (["thread/read", "thread/name/set"].includes(request.method) && process.env.CODEX_HOME) {
      const file = join(process.env.CODEX_HOME, "fixture-title-"
        + createHash("sha256").update(request.params.threadId).digest("hex") + ".json");
      if (request.method === "thread/name/set") writeFileSync(file, JSON.stringify({ name: request.params.name }));
      const name = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).name : null;
      const result = request.method === "thread/read" ? { thread: { id: request.params.threadId, name } } : {};
      process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      return;
    }
    const results = {
      initialize: { userAgent: "fixture", codexHome: process.env.CODEX_HOME },
      "model/list": { data: JSON.parse(process.env.YUI_FAKE_MODELS ?? "[]"), nextCursor: null },
      "configRequirements/read": { requirements: null },
      "modelProvider/capabilities/read": { webSearch: false }
    };
    const reply = Object.hasOwn(results, request.method)
      ? { id: request.id, result: results[request.method] }
      : { id: request.id, error: { code: -32601, message: `Unexpected fixture RPC: ${request.method}` } };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
} else {
  throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
}
