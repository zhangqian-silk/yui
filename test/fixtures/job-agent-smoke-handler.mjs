// Deterministic Agent behavior through the installed CLI, real Host and Provider
// transport. This never contacts a model or reads the fixture database directly.
import { setTimeout as delay } from "node:timers/promises";

export async function handleJobTurn({ cli, global, wake, originals, inboxId }) {
  const message = originals.find(message => message.body.startsWith("JobRun "));
  if (!message) return undefined;
  const selector = /yui job run-claim (.+) --json/u.exec(message.body)?.[1].split(" ");
  if (!selector) throw new Error("Fixture Job context pointer missing.");
  // Wait only for acceptance of this exact native input; never resubmit it.
  const deadline = Date.now() + 5000;
  for (;;) {
    // Task acceptance is established by its exact wake, not the unused Job
    // evidence projection. Global delivery still needs that evidence.
    const delivery = global ? cli("job", "run-evidence", ...selector).delivery.at(-1) : undefined;
    const delivered = global ? delivery?.control?.outcome === "accepted" || delivery?.delivery?.via === "provider"
      : cli("task", "wake", "show", wake[1], wake[2]).wake.status === "consumed";
    if (delivered) break;
    if (Date.now() > deadline) throw new Error("Exact Job input acceptance was not observed.");
    await delay(25);
  }
  cli("inbox", "claim", inboxId, "--request-id", `job-fixture-claim-${inboxId}`);
  cli("job", "run-claim", ...selector);
  const context = cli("job", "run-context", ...selector);
  if (context.configuration.input !== "Deterministic Job Agent smoke.") throw new Error("Job durable input mismatch.");
  const outcome = context.cancelRequestedAt ? "cancelled" : "succeeded";
  cli("job", "run-report", ...selector, "--result", JSON.stringify({
    schemaVersion: 1, sourceRun: { scope: context.scope, runId: context.id },
    outcome, summary: "Deterministic Agent explicitly reported the exact Run.", evidence: []
  }));
  cli("inbox", "ack", inboxId, "--request-id", `job-fixture-ack-${inboxId}`, "--reason", `Reported JobRun ${context.id}.`);
  return `Reported ${context.id}.`;
}
