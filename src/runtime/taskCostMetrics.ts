import type { RuntimeCostSnapshot, RuntimeObservation } from "./runtimeObservation.js";
import type { UsageMetric } from "./taskUsageMetrics.js";

export type CostEvidence = Readonly<{
  nativeSessionId: string;
  roleName: string;
  agentId: string;
  driverId: string;
  source: string;
  currency: string;
  semantics: RuntimeCostSnapshot["semantics"];
  basis?: RuntimeCostSnapshot["basis"];
  amount: UsageMetric;
}>;
export type CostMetric = Readonly<{
  status: UsageMetric["status"];
  amounts: readonly (UsageMetric & { currency: string })[];
  reasons: readonly string[];
  evidence: readonly CostEvidence[];
}>;
export type TaskCosts = Readonly<{
  scope: "observed-sources-only";
  actual: CostMetric;
  estimated: CostMetric;
}>;

/** No price catalog, currency conversion, token-to-money guess, or billing claim. */
export function projectTaskCosts(
  observations: readonly RuntimeObservation[],
  inScope: (observation: RuntimeObservation) => boolean,
  workItem: boolean,
  missingEvidence: readonly string[] = []
): TaskCosts {
  const main = observations.filter(o => o.fence.nativeSessionId !== undefined
    && o.fence.continuationId === undefined && o.fence.parentContinuationId === undefined
    && (o.authority === "provider-structured" || o.authority === "driver-inferred"));
  const resource = (o: RuntimeObservation) => JSON.stringify([
    o.fence.driverId, o.fence.nativeSessionId
  ]);
  const sessions = new Map<string, RuntimeObservation[]>();
  for (const o of main) sessions.set(resource(o), [...(sessions.get(resource(o)) ?? []), o]);
  const project = (kind: RuntimeCostSnapshot["kind"]): CostMetric => {
    const evidence: CostEvidence[] = [];
    const reasons: string[] = [...missingEvidence];
    if (observations.some(o => inScope(o) && o.payload.cost?.kind === kind
      && (o.fence.continuationId !== undefined || o.fence.parentContinuationId !== undefined))) {
      reasons.push("child-usage-overlap-unproven");
    }
    for (const all of sessions.values()) {
      if (!all.some(inScope)) continue;
      const costs = all.filter(o => o.payload.cost?.kind === kind);
      if (costs.length === 0) { reasons.push("cost-unobserved"); continue; }
      // Different native Roles and sources cannot safely claim independent charges.
      const overlap = new Set(all.map(o => JSON.stringify([o.fence.roleName, o.fence.agentId]))).size > 1;
      const currencies = [...new Set(costs.map(o => o.payload.cost!.currency))].sort();
      for (const currency of currencies) {
        const versions = costs.filter(o => o.payload.cost!.currency === currency);
        const latest = versions.at(-1)!;
        const cost = latest.payload.cost!;
        // Missing receipts can carry only a coverage boundary, with no cost
        // field. Keep known subtotals but do not erase that boundary by first
        // filtering down to monetary observations.
        const local = qualityReasons(all.filter(o => inScope(o)
          && (o.payload.cost === undefined || o.payload.cost.kind === kind)));
        let value: number | null = null;
        const semantics = new Set(versions.map(o => o.payload.cost!.semantics));
        const sources = new Set(versions.map(o => o.payload.cost!.source));
        if (overlap) local.push("native-session-role-overlap");
        else if (semantics.size > 1) local.push("cost-source-overlap");
        else if (cost.semantics === "cumulative-session") {
          if (sources.size > 1) local.push("cost-source-overlap");
          else if (workItem) local.push("cumulative-not-allocatable-to-work-item");
          else if (versions.some((o, i) => i > 0
            && o.payload.cost!.amount < versions[i - 1]!.payload.cost!.amount)) {
            local.push("cost-counter-rollback");
          } else if (new Set(versions.map(o => JSON.stringify(o.payload.cost!.basis))).size > 1) {
            local.push("cost-basis-changed");
          } else {
            const baseline = versions[0]!.payload.cost!.amount;
            if (baseline !== 0) local.push("nonzero-session-baseline");
            if (baseline === 0 || versions.length > 1) value = cost.amount - baseline;
          }
        } else {
          const requests = new Map<string, RuntimeObservation[]>();
          for (const o of versions) {
            const id = o.payload.activityId!;
            requests.set(id, [...(requests.get(id) ?? []), o]);
          }
          const selected: RuntimeObservation[] = [];
          for (const request of requests.values()) {
            if (!request.some(inScope)) continue;
            if (new Set(request.map(o => o.payload.cost!.source)).size > 1) {
              local.push("cost-source-overlap");
            } else if (workItem && (!request.every(inScope)
              || new Set(request.map(o => o.fence.runId)).size !== 1)) {
              local.push("request-run-attribution-conflict");
            } else selected.push(request.at(-1)!);
          }
          // Preserve each price basis rather than attaching the latest basis to
          // a subtotal computed using a different model or price version.
          const bases = new Map<string, RuntimeObservation[]>();
          for (const o of selected) {
            const key = JSON.stringify([o.payload.cost!.source, o.payload.cost!.basis]);
            bases.set(key, [...(bases.get(key) ?? []), o]);
          }
          for (const group of bases.values()) {
            const representative = group.at(-1)!;
            const subtotal = group.reduce((sum, o) => sum + o.payload.cost!.amount, 0);
            evidence.push(detail(representative, safeAmount(subtotal),
              [...local, ...qualityReasons(group)]));
          }
          if (selected.length > 0) { reasons.push(...local); continue; }
          local.push("cost-unobserved");
        }
        evidence.push(detail(latest, value, [...local, ...qualityReasons(versions)]));
      }
    }
    if (evidence.length === 0) reasons.push(kind === "estimated" ? "price-unavailable" : "cost-unobserved");
    reasons.push(...evidence.flatMap(e => e.amount.reasons));
    const amounts = [...new Set(evidence.map(e => e.currency))].sort().flatMap(currency => {
      const known = evidence.filter(e => e.currency === currency && e.amount.value !== null);
      return known.length === 0 ? [] : [{
        ...metric(safeAmount(known.reduce((sum, e) => sum + e.amount.value!, 0)), reasons), currency
      }];
    });
    return {
      status: amounts.length === 0 ? "unknown" : reasons.length ? "partial" : "known",
      amounts, reasons: [...new Set(reasons)].sort(), evidence
    };
  };
  return { scope: "observed-sources-only", actual: project("actual"), estimated: project("estimated") };
}

function qualityReasons(observations: readonly RuntimeObservation[]): string[] {
  return [
    ...(observations.some(o => o.payload.observationQuality === "partial"
      || o.payload.observationQuality === "unavailable") ? ["source-coverage-partial"] : []),
    ...(observations.some(o => (o.payload.cost?.basis?.excluded.length ?? 0) > 0)
      ? ["estimate-exclusions"] : [])
  ];
}
function detail(o: RuntimeObservation, value: number | null, reasons: readonly string[]): CostEvidence {
  const cost = o.payload.cost!;
  return {
    nativeSessionId: o.fence.nativeSessionId!, roleName: o.fence.roleName,
    agentId: o.fence.agentId, driverId: o.fence.driverId,
    source: cost.source, currency: cost.currency, semantics: cost.semantics,
    ...(cost.basis === undefined ? {} : { basis: cost.basis }),
    amount: metric(value, reasons)
  };
}
function safeAmount(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}
function metric(value: number | null, reasons: readonly string[]): UsageMetric {
  return { value, status: value === null ? "unknown" : reasons.length ? "partial" : "known",
    reasons: [...new Set(reasons)].sort() };
}
