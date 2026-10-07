// Public business strategy, intentionally independent of case IDs and oracles.
// An unknown effect must be queried by its original identity before any action.
export function recoverNotification(pending, lookup) {
  if (pending.status !== "unknown" || typeof pending.key !== "string") {
    throw new Error("Expected an unknown operation with its original request key.");
  }
  const receipt = lookup(pending.key);
  if (receipt?.status !== "confirmed") return { key: pending.key, status: "unknown" };
  if (receipt.recipient !== pending.recipient || receipt.body !== pending.body) {
    throw new Error("Authoritative receipt payload does not match the original request.");
  }
  return { key: pending.key, effectId: receipt.effectId, status: "confirmed" };
}
