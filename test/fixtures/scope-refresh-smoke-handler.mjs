// Deterministic native tool work for the package smoke's single scope case.
// All mutations use the selected package CLI with the actual managed identity.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export async function handleTurn({ input, environment, threadId, turnId }) {
  const directory = dirname(environment.YUI_FAKE_INPUT_LOG);
  const configPath = join(directory, "scope-refresh.json");
  if (!existsSync(configPath)) return "Native Codex result.";
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (environment.YUI_TASK_ID !== config.taskId) return "Native Codex result.";
  const text = input.input?.map(item => item.text ?? "").join("\n") ?? "";
  const wakeId = /wake=(wake-\d+)\./u.exec(text)?.[1];
  if (!wakeId) throw new Error("Scope fixture requires its exact notification.");
  const cli = (...args) => {
    const reply = JSON.parse(execFileSync(config.cli, ["--json", ...args], {
      env: environment, encoding: "utf8", timeout: 12_000
    }));
    if (!reply.ok) throw new Error(JSON.stringify(reply));
    return reply.data;
  };
  cli("inbox", "claim", wakeId, "--request-id", `scope-claim-${wakeId}`);
  cli("inbox", "show", wakeId);
  const marker = join(directory, "scope-added.json");
  if (!existsSync(marker)) {
    const { inspectAgentHost } = await import(pathToFileURL(join(config.root, "dist/runtime/agentHost.js")).href);
    const before = await inspectAgentHost({
      home: environment.YUI_HOME, scope: "task", taskId: config.taskId, roleName: "leader"
    });
    const started = Date.now();
    const result = cli("task", "project", "add", config.taskId, config.projectId, "--directory", "scope-src");
    writeFileSync(marker, JSON.stringify({ before, result, threadId, turnId, wakeId, elapsedMs: Date.now() - started }));
    const deadline = Date.now() + 12_000;
    while (!existsSync(join(directory, "scope-yield"))) {
      if (Date.now() >= deadline) throw new Error("Scope fixture did not release its held Turn.");
      await delay(25);
    }
  }
  cli("inbox", "ack", wakeId, "--request-id", `scope-ack-${wakeId}`,
    "--reason", "Handled exact fixture notification; yield Turn for scope continuation");
  appendFileSync(join(directory, "scope-handled.jsonl"), `${JSON.stringify({ wakeId, threadId, turnId })}\n`);
  return "Scope notification handled.";
}
