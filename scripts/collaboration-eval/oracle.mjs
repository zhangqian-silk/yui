// Independent evaluator: never imported by the participant.
// Expected business constraints are literal, not computed by participant code.
export function judgeNotification(observation) {
  const failures = [];
  const effects = observation.ledger;
  if (effects.length !== 1) failures.push("duplicate-or-missing-effect");
  if (effects[0]?.key !== "notice-17" || effects[0]?.recipient !== "local-inbox"
    || effects[0]?.body !== "Build ready") failures.push("wrong-effect-identity");
  const receipt = observation.receipt;
  if (receipt?.key !== "notice-17" || receipt?.effectId !== effects[0]?.effectId
    || receipt?.status !== "confirmed") failures.push("receipt-not-bound-to-original-effect");
  if (!observation.persistedReceipt || !observation.discoveredOriginal) {
    failures.push("durable-evidence-gap");
  }
  return { status: failures.length ? "fail" : "scripted-pass", failures,
    phase: failures.length ? "action" : null, attribution: failures.length ? "unknown" : null };
}
