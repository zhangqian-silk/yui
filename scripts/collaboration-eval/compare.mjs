import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { readEvidence } from "./evidence.mjs";

const key = c => `${c.id}/${c.variant}/${c.mode}`;
const provenance = ["caseSet", "seed", "freezeSha256", "policySha256",
  "oracleSha256", "harnessSha256", "proxySha256"];
const environment = ["node", "platform", "architecture", "packageLockSha256"];

function indexed(evidence) {
  if (evidence.schemaVersion !== 1 || evidence.mode !== "offline"
    || !Array.isArray(evidence.conditions) || !Array.isArray(evidence.trace))
    throw new Error("Expected saved offline case evidence, not a calibration report");
  const index = new Map();
  for (const c of evidence.conditions) {
    if (![c.id, c.variant, c.mode].every(v => typeof v === "string" && v.length))
      throw new Error("Missing condition identity");
    if (index.has(key(c))) throw new Error(`Duplicate condition ${key(c)}`);
    index.set(key(c), c);
  }
  return index;
}

function costs(evidence, condition) {
  const r = condition.traceRange;
  if (!Array.isArray(r) || r.length !== 2 || !r.every(Number.isInteger)
    || r[0] < 0 || r[1] < r[0] || r[1] > evidence.trace.length
    || !Number.isFinite(condition.elapsedMs) || condition.elapsedMs < 0) return null;
  const queries = evidence.trace.slice(...r).filter(t => t.phase === "query");
  if (queries.some(t => ![t.stdoutBytes, t.stderrBytes]
    .every(n => Number.isFinite(n) && n >= 0))) return null;
  return { reads: queries.length,
    readBytes: queries.reduce((n, t) => n + t.stdoutBytes + t.stderrBytes, 0),
    elapsedMs: condition.elapsedMs };
}

function outcome(evidence, condition) {
  if (!condition) return null;
  return {
    status: condition.status ?? "unknown",
    businessStatus: condition.businessStatus ?? "unknown",
    stages: condition.stages ?? null, boundaries: condition.boundaries ?? null,
    score: condition.score ?? null, error: condition.error ?? null,
    cleanup: condition.cleanup ?? null, costs: costs(evidence, condition)
  };
}

// Only saved records are consumed. No runner, process execution, Home or retry path.
export function compareEvidence(a, b) {
  const left = indexed(a), right = indexed(b), mismatches = [];
  function match(label, x, y) {
    if (x === undefined || y === undefined || x === null || y === null
      || !isDeepStrictEqual(x, y)) mismatches.push(label);
  }
  for (const field of provenance) match(field, a[field], b[field]);
  for (const field of environment) match(`version.${field}`, a.version?.[field], b.version?.[field]);
  for (const [label, evidence] of [["a", a], ["b", b]]) {
    if (evidence.version?.worktreeStatus !== "") mismatches.push(`${label}: unclean/unknown source`);
    if (!evidence.version?.commit) mismatches.push(`${label}: unknown version`);
  }
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (!keys.length) mismatches.push("empty condition selection");
  for (const k of keys) {
    const x = left.get(k), y = right.get(k);
    if (!x || !y) { mismatches.push(`${k}: missing counterpart`); continue; }
    for (const field of ["category", "split", "budget"])
      match(`${k}: ${field}`, x[field], y[field]);
    // Native checkpoint digests contain real, run-specific identities. Compare
    // frozen source inputs, not those generated outputs.
    match(`${k}: source material`, x.manifest?.sourceHashes, y.manifest?.sourceHashes);
  }
  const comparable = mismatches.length === 0;
  const pairs = keys.map(k => {
    const x = left.get(k), y = right.get(k);
    const oa = outcome(a, x), ob = outcome(b, y);
    return { condition: k, category: x?.category ?? y.category,
      split: x?.split ?? y.split, a: oa, b: ob,
      costDelta: comparable && oa?.costs && ob?.costs
        ? Object.fromEntries(Object.keys(oa.costs).map(f => [f, ob.costs[f] - oa.costs[f]])) : null };
  });
  return {
    schemaVersion: 1, experiments: [a.experiment, b.experiment],
    versions: [a.version, b.version], comparable, mismatches,
    plannedPairs: keys.length, pairs, optimizationBenefit: "not-established",
    limitations: [
      "Negative cost deltas are descriptive, not correctness or optimization acceptance.",
      "Failure, missing, not-run, pending-human and partial-evidence outcomes remain visible.",
      "F/P and variants are separate pairs, not independent base samples.",
      "Elapsed time includes fixture overhead; bytes are not model tokens or monetary cost.",
      "Only the target version may differ; changed harnesses require a separate experiment.",
      "This reads saved evidence only and never retries or fills missing observations."
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4)
    throw new Error("Usage: node scripts/collaboration-eval/compare.mjs <record-A> <record-B>");
  console.log(JSON.stringify(compareEvidence(readEvidence(process.argv[2]),
    readEvidence(process.argv[3])), null, 2));
}
