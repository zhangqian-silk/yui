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
      const latest = costs.at(-1)!;
      const cost = latest.payload.cost!;
      // Missing receipts can carry only a coverage boundary, with no cost.
      const local = qualityReasons(all.filter(o => inScope(o)
        && (o.payload.cost === undefined || o.payload.cost.kind === kind)));
      const semantics = new Set(costs.map(o => o.payload.cost!.semantics));
      if (overlap || semantics.size > 1) {
        evidence.push(detail(latest, null, [...local,
          overlap ? "native-session-role-overlap" : "cost-source-overlap"]));
        continue;
      }
      if (cost.semantics === "cumulative-session") {
        let value: number | null = null;
        if (new Set(costs.map(o => JSON.stringify([o.payload.cost!.source, o.payload.cost!.currency]))).size > 1) {
          local.push("cost-source-overlap");
        } else if (workItem) local.push("cumulative-not-allocatable-to-work-item");
        else if (costs.some((o, i) => i > 0
          && o.payload.cost!.amount < costs[i - 1]!.payload.cost!.amount)) {
          local.push("cost-counter-rollback");
        } else if (new Set(costs.map(o => JSON.stringify(o.payload.cost!.basis))).size > 1) {
          local.push("cost-basis-changed");
        } else {
          const baseline = costs[0]!.payload.cost!.amount;
          if (baseline !== 0) local.push("nonzero-session-baseline");
          if (baseline === 0 || costs.length > 1) value = cost.amount - baseline;
        }
        evidence.push(detail(latest, value, [...local, ...qualityReasons(costs)]));
        continue;
      }
      // Currency and price basis can change in a request revision. Resolve
      // identity and attribution over every version before monetary grouping.
      const requests = new Map<string, RuntimeObservation[]>();
      for (const o of costs) {
        const id = o.payload.activityId!;
        requests.set(id, [...(requests.get(id) ?? []), o]);
      }
      const bases = new Map<string, RuntimeObservation[]>();
      for (const request of requests.values()) {
        if (!request.some(inScope)) continue;
        const selected = request.at(-1)!;
        const conflict = new Set(request.map(o => o.payload.cost!.source)).size > 1
          ? "cost-source-overlap"
          : workItem && (!request.every(inScope) || new Set(request.map(o => o.fence.runId)).size !== 1)
            ? "request-run-attribution-conflict" : undefined;
        if (conflict !== undefined) {
          evidence.push(detail(selected, null, [...local, conflict]));
          continue;
        }
        const selectedCost = selected.payload.cost!;
        const key = JSON.stringify([selectedCost.currency, selectedCost.source, selectedCost.basis]);
        bases.set(key, [...(bases.get(key) ?? []), selected]);
      }
      for (const group of bases.values()) {
        const subtotal = group.reduce((sum, o) => sum + o.payload.cost!.amount, 0);
        evidence.push(detail(group.at(-1)!, safeAmount(subtotal), [...local, ...qualityReasons(group)]));
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
