// Invoked by the deterministic native protocol fixture, inside the real Host's
// Session environment. These are ordinary managed CLI operations, not Store seeds.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function handleTurn({ environment, threadId, turnId, input }) {
  appendFileSync(join(environment.YUI_HOME, "native-turns.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), threadId, turnId, input }) + "\n");
  const marker = join(environment.YUI_HOME, "web-smoke-native-result.json");
  if (existsSync(marker)) return "Deterministic continuation completed.";
  const cli = environment.YUI_SMOKE_CLI;
  const taskId = environment.YUI_TASK_ID;
  if (!cli || !taskId) throw new Error("Expected explicit smoke CLI and managed Task.");
  const run = args => {
    const result = spawnSync(cli, ["--json", ...args], {
      env: environment, encoding: "utf8", timeout: 15000
    });
    if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
    const value = JSON.parse(result.stdout);
    if (args[0] === "job" && value.data === undefined) return JSON.parse(value.output);
    return value.data ?? value;
  };
  const context = run(["task", "context", taskId]);
  const record = context.records.find(r => r.ref.store === "managed-workspace");
  const workspace = record?.value ?? run(["task", "context", "inspect", taskId,
    "--store", record.ref.store, "--ref", record.ref.refId, "--digest", record.ref.digest]).value;
  const entry = workspace.entries[0];
  const head = spawnSync("git", ["-C", entry.path, "rev-parse", "HEAD"],
    { env: environment, encoding: "utf8" }).stdout.trim();
  const artifact = run(["task", "artifact", "save", taskId, "report.md",
    "# Fixed evidence 😀\n\n<script>window.injected = true</script>\n\n```js\nconst answer = 42;\n```\n"]);
  const image = run(["task", "artifact", "save", taskId, "pixel.png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "--encoding", "base64"]);
  const job = run(["job", "start", "--task", taskId, "--project", entry.projectId,
    "--head", head, "--workspace", workspace.root, "--request-id", "native-preview",
    "--env", "YUI_HTTP_PREVIEW=1", "--step", `http=node ${entry.directory}/server.cjs`]);
  writeFileSync(marker, JSON.stringify({ artifact, image, job, workspace, nativeSessionId: environment.CODEX_THREAD_ID }, null, 2));
  return "Native fixture saved pinned artifacts and requested a real managed HTTP Job.";
}
