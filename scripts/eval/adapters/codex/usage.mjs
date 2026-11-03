// Codex native usage projection. No scenario, Role or quality assumptions.
// Callers supply already-owned events and any additional exact Thread identities
// retained in their execution ledger (including Threads with missing streams).
export function tokenTotals(events, expectedThreadIds = []) {
  const last = new Map();
  const expected = new Set(expectedThreadIds.filter(id => typeof id === "string" && id));
  for (const e of events) {
    const m = e.message, p = m?.params;
    const threadId = p?.threadId ?? m?.result?.thread?.id;
    if (typeof threadId === "string" && threadId) expected.add(threadId);
    if (m?.method !== "thread/tokenUsage/updated" || !p?.threadId) continue;
    // total is cumulative per Thread; never sum successive snapshots or add
    // cached/reasoning subset fields to their parent.
    if (p.tokenUsage?.total) last.set(p.threadId, p.tokenUsage.total);
  }
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  const missingThreadIds = [...expected].filter(id => !last.has(id)).sort();
  const observedTotals = Object.fromEntries(fields.map(k =>
    [k, last.size && [...last.values()].every(v => Number.isFinite(v[k]))
      ? [...last.values()].reduce((s, v) => s + v[k], 0) : "unknown"]));
  return { status: !last.size ? "unknown" : missingThreadIds.length ? "partial" : "observed",
    ...(!last.size ? { reason: "No native cumulative token usage; fake bytes are not tokens" } : {}),
    threads: [...last], observedTotals,
    ...Object.fromEntries(fields.map(k => [k, missingThreadIds.length ? "unknown" : observedTotals[k]])),
    coverage: { expectedThreadIds: [...expected].sort(), observedThreadIds: [...last.keys()].sort(), missingThreadIds,
      limit: "Thread usage presence only, not complete request/Turn capture. Unknown identities cannot be enumerated. Latest cumulative Thread counters may include pre-window history; inspect per-Turn baselines before comparing window costs." },
  hidden: "unknown", subsets: ["cachedInputTokens ⊂ inputTokens", "reasoningOutputTokens ⊂ outputTokens"] };
}
// Caller supplies one owned Thread's observations and its optional baseline.
// Notifications are not one-to-one provider request receipts.
export function usageObservations(events, baseline) {
  const samples = [], seen = new Set();
  let previous = baseline, duplicateUpdates = 0;
  for (const e of events) {
    const usage = e.message?.params?.tokenUsage;
    if (!usage?.total) continue;
    const fingerprint = JSON.stringify(Object.entries(usage.total).sort(([a], [b]) => a.localeCompare(b)));
    if (seen.has(fingerprint)) { duplicateUpdates++; continue; }
    seen.add(fingerprint);
    const input = usage.total.inputTokens, prior = previous?.inputTokens;
    const delta = Number.isFinite(input) && Number.isFinite(prior) && input >= prior ? input - prior : "unknown";
    const last = usage.last?.inputTokens;
    samples.push({ at: e.at ?? null, cumulative: usage.total, last: usage.last ?? "unknown",
      inputDelta: delta, matchesLastInput: typeof delta === "number" && Number.isFinite(last) ? delta === last : "unknown" });
    previous = usage.total;
  }
  const inputs = samples.map(s => s.last?.inputTokens).filter(Number.isFinite);
  return { uniqueUpdates: samples.length, duplicateUpdates, requestCount: "unknown",
    observedLastInputSum: inputs.length === samples.length && inputs.length ? inputs.reduce((a, b) => a + b, 0) : "unknown",
    observedLastInputRange: inputs.length ? { first: inputs[0], last: inputs.at(-1),
      min: inputs.reduce((a, b) => Math.min(a, b)), max: inputs.reduce((a, b) => Math.max(a, b)) } : "unknown",
    samples: samples.length <= 64 ? samples : [...samples.slice(0, 32), ...samples.slice(-32)],
    omittedSamples: Math.max(0, samples.length - 64),
    coverage: "Observed cumulative usage updates only, deduplicated by total. Deltas may span hidden requests; last is not Turn total. A decrease is not proof of compaction. Matching input deltas do not prove complete request coverage." };
}
