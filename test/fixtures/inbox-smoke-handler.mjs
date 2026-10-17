// One disposable package-smoke effect. This is a deterministic Provider
// replacement, not model validation or production routing.
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export async function handleTurn({ input, environment }) {
  const text = input.input?.map(item => item.text ?? "").join("\n") ?? "";
  const match = /Yui Global Message: role=operator message=([A-Za-z0-9-]+)\./u.exec(text);
  if (!match) return "Native Codex result.";
  const cli = (...args) => JSON.parse(execFileSync("yui", ["--json", ...args], {
    env: environment, encoding: "utf8", timeout: 10000
  })).data;
  const original = cli("role", "message", "show", "operator", match[1]);
  if (original.inputControl?.requestId !== "update-pending") return "Inspected fixture notification.";
  const deadline = Date.now() + 5000;
  while (cli("inbox", "show", original.id).delivery?.via !== "provider") {
    if (Date.now() >= deadline) throw new Error("Exact input acceptance did not reach the fixture.");
    await delay(25);
  }
  cli("inbox", "claim", original.id, "--request-id", "fixture-routing-claim");
  const routed = cli("task", "create", "inbox routing effect").task;
  // Deliberately omit ACK after a real isolated business operation. A repeated
  // turn would create another Task, so the smoke can detect effect replay.
  return `Routed to ${routed.id}; deliberately omitted handling ACK.`;
}
