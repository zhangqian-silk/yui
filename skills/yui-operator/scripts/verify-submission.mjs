// Local, read-only transport comparison. This does not establish source
// semantics, authority, downstream completion or permission to acknowledge.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

try {
  const args = process.argv.slice(2);
  const [receiptFile, payloadFile, taskId, intent, submissionKey] = args;
  if (args.length !== 5 || args.some(arg => !arg)
    || !["record", "discuss", "develop"].includes(intent)) {
    throw new Error("Usage: node verify-submission.mjs <receipt.json> <payload> <task-id> <record|discuss|develop> <request-id>");
  }
  const receiptText = readFileSync(receiptFile, "utf8");
  let receipt;
  try {
    receipt = JSON.parse(receiptText);
  } catch {
    throw new Error("Invalid JSON receipt; retain the original file for inspection.");
  }
  const message = receipt?.data?.message;
  if (receipt?.ok !== true || receipt.data?.taskId !== taskId
    || message?.taskId !== taskId || message?.intent !== intent
    || message?.submissionKey !== submissionKey
    || typeof message?.id !== "string" || !message.id) {
    throw new Error("Saved submission identity or intent mismatch; retain evidence and inspect, do not resubmit.");
  }
  const payload = readFileSync(payloadFile);
  const bodySha256 = createHash("sha256").update(payload).digest("hex");
  if (message.bodyBytes !== payload.length || message.bodySha256 !== bodySha256) {
    throw new Error("Saved body checksum missing or mismatched; retain evidence and inspect the exact saved Message, do not resubmit.");
  }
  console.log(JSON.stringify({ ok: true, taskId, messageId: message.id,
    intent, submissionKey, bodyBytes: payload.length, bodySha256 }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
