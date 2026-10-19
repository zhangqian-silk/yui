// One disposable package-smoke effect. This is a deterministic Provider
// replacement, not model validation or production routing.
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { handleJobTurn } from "./job-agent-smoke-handler.mjs";

export async function handleTurn({ input, environment }) {
  const text = input.input?.map(item => item.text ?? "").join("\n") ?? "";
  const cli = (...args) => JSON.parse(execFileSync("yui", ["--json", ...args], {
    env: environment, encoding: "utf8", timeout: 10000
  })).data;
  const global = /Yui Global Message: role=([\w-]+) message=([\w-]+)\./u.exec(text);
  const wake = /Yui Task notification: task=(task-\d+) wake=(wake-\d+)/u.exec(text);
  let originals;
  let inboxId;
  if (global) {
    originals = [cli("role", "message", "show", global[1], global[2])];
    inboxId = global[2];
  } else if (wake) {
    const value = cli("task", "wake", "show", wake[1], wake[2]);
    originals = value.messages.map(message => cli("task", "message", "show", `${wake[1]}/${message.id}`));
    inboxId = wake[2];
  } else return "Native Codex result.";
  // Read each original once, then dispatch its existing fixture behavior.
  const jobResult = await handleJobTurn({ cli, global, wake, originals, inboxId });
  if (jobResult !== undefined) return jobResult;
  if (global?.[1] !== "operator") return "Native Codex result.";
  const original = originals[0];
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
