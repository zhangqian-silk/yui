import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cases, getCase } from "./cases.mjs";
import { verifyCases } from "./verify.mjs";

export const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} requires nonempty text`);
  return value;
};
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} requires a positive integer`);
  return value;
};
const ratio = (a, b) => b === 0 ? null : a / b;

// Explicit projection only: never recursively copy the scorer tree or history.
export function participantFiles(id, materials) {
  const c = getCase(id);
  if (!["basic", "indexed"].includes(materials)) throw new Error("materials must be basic or indexed");
  return {
    ...c.files,
    "REQUIREMENTS.md": `${c.contract}\n\nReview the complete supplied source. Report confirmed defects with triggers, `
      + "violated expectations and evidence; separate gaps and suggestions. No findings is a valid result.\n",
    ...(materials === "indexed" ? { "INDEX.md": `${c.index}\n\nCandidate: the supplied source snapshot. `
      + "Verification: no previous execution results are claimed. This index is not a scope limit.\n" } : {})
  };
}

export async function exportParticipant(id, materials, destination) {
  const files = participantFiles(id, materials);
  // Refuse existing destinations, including symlinks; do not overwrite user data.
  await mkdir(destination);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(resolve(destination, name), content, { flag: "wx" });
  }
  return { caseId: id, materials, digest: digest(files), files: Object.keys(files),
    isolation: "export-only; not an OS sandbox or an unknown holdout" };
}

// The protocol embeds exact supplied Skill bundles (relative path -> UTF-8
// contents, including required references/VERSION), not mutable global paths.
// The execution harness must later record what it actually loaded.
export function makePlan(protocol) {
  for (const key of ["model", "effort", "tools", "environment", "budget", "seed"]) text(protocol[key], key);
  integer(protocol.repeats, "repeats");
  if (protocol.repeats > 100) throw new Error("This small protocol supports at most 100 repeats");
  for (const key of ["baseline", "improved"]) {
    const bundle = protocol[key];
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) || !Object.keys(bundle).length) {
      throw new Error(`${key} must contain the exact Skill bundle`);
    }
    for (const [name, content] of Object.entries(bundle)) {
      if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(name)
        || name.split("/").some(part => part === "." || part === "..")) throw new Error("Unsafe Skill path");
      text(content, `${key}/${name}`);
    }
  }
  const conditions = [
    ["A", "baseline", "basic"], ["B", "improved", "basic"],
    ["C", "baseline", "indexed"], ["D", "improved", "indexed"]
  ];
  const configDigest = digest(Object.fromEntries(
    ["model", "effort", "tools", "environment", "budget"].map(key => [key, protocol[key]])
  ));
  const blocks = cases.flatMap(c => Array.from({ length: protocol.repeats }, (_, repeat) => ({ c, repeat })))
    .sort((a, b) => digest([protocol.seed, a.c.id, a.repeat]).localeCompare(digest([protocol.seed, b.c.id, b.repeat])));
  const runs = blocks.flatMap(({ c, repeat }, i) => {
    // Latin rotation balances position (within one across all blocks).
    return Array.from({ length: 4 }, (_, offset) => {
      const [group, skill, materials] = conditions[(i + offset) % 4];
      return { id: `${c.id}-${group}-${repeat + 1}`, caseId: c.id, group, repeat: repeat + 1,
        configDigest,
        candidateDigest: digest(c.files), materialDigest: digest(participantFiles(c.id, materials)),
        skillDigest: digest(protocol[skill]) };
    });
  });
  const body = { schemaVersion: 1, kind: "development-2x2", protocol,
    corpusDigest: digest(cases), runs };
  return { ...body, digest: digest(body) };
}

function validatePlan(plan) {
  // Reject a changed corpus/config/order instead of silently combining trials.
  const expected = makePlan(plan.protocol);
  if (JSON.stringify(expected) !== JSON.stringify(plan)) throw new Error("Plan drift: preserve the exact frozen plan");
}

const metricNames = ["wallMs", "agentCalls", "toolCalls", "inputTokens", "outputTokens", "contextBytes", "cost"];
const statuses = ["completed", "timeout", "infra-failed", "not-run"];

function evaluateRecord(run, record) {
  const c = getCase(run.caseId);
  const result = { ...run, status: record?.status ?? "not-run",
    hits: 0, known: c.gold.length, valid: 0, invalid: 0, duplicates: 0, pending: 0, novel: 0,
    coverage: [], metrics: {} };
  if (!statuses.includes(result.status)) throw new Error(`Invalid status: ${result.status}`);
  if (!record) return result;
  if (!statuses.includes(record.status)) throw new Error("Supplied records require an explicit execution status");
  for (const key of ["candidateDigest", "materialDigest", "skillDigest", "configDigest"]) {
    if (record[key] !== run[key]) throw new Error(`${run.id}: ${key} differs from plan`);
  }
  for (const key of metricNames) {
    const value = record.metrics?.[key];
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${run.id}: invalid ${key}`);
    }
    result.metrics[key] = value ?? null;
  }
  if (record.status !== "not-run") {
    text(record.evidenceRef, "execution evidenceRef");
    if (typeof record.rawOutput !== "string") throw new Error("Preserve rawOutput, including an empty failed output");
  }
  if (record.status !== "completed") {
    text(record.reason, "incomplete execution reason");
    // Partial output and any adjudication stay in the original file, never
    // mixed into full-first-round metrics.
    return result;
  }
  text(record.rawOutput, "completed rawOutput");
  if (!Array.isArray(record.findings)) throw new Error("Completed records require adjudicated findings (possibly [])");
  const roots = new Map();
  const known = new Set(c.gold.map(r => r.id));
  const findingIds = new Set();
  for (const finding of record.findings) {
    text(finding.id, "finding id");
    if (findingIds.has(finding.id)) throw new Error("Duplicate finding id");
    findingIds.add(finding.id);
    text(finding.claim, "original claim");
    if (!["valid", "invalid", "pending", "gap", "suggestion"].includes(finding.verdict)) {
      throw new Error("A semantic adjudication verdict is required");
    }
    if (finding.verdict === "pending") { result.pending++; continue; }
    if (["gap", "suggestion"].includes(finding.verdict)) continue;
    text(finding.reason, "adjudication reason");
    text(finding.evidence, "adjudication evidence");
    text(finding.root, "adjudicated root");
    if (finding.verdict === "valid" && !known.has(finding.root) && !finding.root.startsWith("novel:")) {
      throw new Error("Unknown gold: use a separately adjudicated novel: root, do not silently count a hit");
    }
    if (roots.has(finding.root)) {
      if (roots.get(finding.root) !== finding.verdict) throw new Error("Conflicting verdicts for one root");
      result.duplicates++;
      continue;
    }
    roots.set(finding.root, finding.verdict);
    result[finding.verdict]++;
    if (finding.verdict === "valid") {
      if (known.has(finding.root)) result.hits++;
      else result.novel++;
    }
  }
  for (const coverage of record.coverage ?? []) {
    if (!c.perspectives.includes(coverage.perspective)) throw new Error("Perspective is not in the case protocol");
    for (const key of ["scenario", "expected", "evidence"]) text(coverage[key], `coverage ${key}`);
    result.coverage.push(coverage);
  }
  return result;
}

export function summarize(plan, records) {
  validatePlan(plan);
  if (!Array.isArray(records)) throw new Error("Records must be an array; missing planned runs remain not-run");
  const byId = new Map();
  for (const record of records) {
    if (!plan.runs.some(run => run.id === record.id) || byId.has(record.id)) {
      throw new Error(`Unknown or duplicated run: ${record.id}`);
    }
    if (record.planDigest !== plan.digest) throw new Error("Record belongs to a different plan");
    byId.set(record.id, record);
  }
  const results = plan.runs.map(run => evaluateRecord(run, byId.get(run.id)));
  const groups = {};
  for (const group of ["A", "B", "C", "D"]) {
    const all = results.filter(r => r.group === group);
    const completed = all.filter(r => r.status === "completed");
    const sum = (items, key) => items.reduce((total, r) => total + r[key], 0);
    const perCase = cases.map(c => {
      const runs = completed.filter(r => r.caseId === c.id);
      return { caseId: c.id, family: c.family, completed: runs.length,
        recall: ratio(sum(runs, "hits"), sum(runs, "known")),
        recalls: runs.map(r => ratio(r.hits, r.known)),
        falsePositives: sum(runs, "invalid"),
        coverageClaims: runs.flatMap(r => r.coverage), applicablePerspectives: c.perspectives };
    });
    const recalls = perCase.map(c => c.recall).filter(v => v !== null);
    groups[group] = {
      planned: all.length, completed: completed.length, completionRate: ratio(completed.length, all.length),
      statuses: Object.fromEntries(statuses.map(s => [s, all.filter(r => r.status === s).length])),
      hits: sum(completed, "hits"), knownInCompleted: sum(completed, "known"),
      recall: ratio(sum(completed, "hits"), sum(completed, "known")),
      macroRecall: ratio(recalls.reduce((a, b) => a + b, 0), recalls.length),
      plannedDiscoveryYield: ratio(sum(completed, "hits"), sum(all, "known")),
      precision: ratio(sum(completed, "valid"), sum(completed, "valid") + sum(completed, "invalid")),
      falsePositives: sum(completed, "invalid"), duplicates: sum(completed, "duplicates"),
      pending: sum(completed, "pending"), novel: sum(completed, "novel"),
      correctControlFalsePositiveRate: ratio(completed.filter(r => r.known === 0 && r.invalid > 0).length,
        completed.filter(r => r.known === 0).length),
      metrics: Object.fromEntries(metricNames.map(key => {
        const available = all.map(r => r.metrics[key]).filter(v => v !== undefined && v !== null);
        return [key, { observedTotal: available.length ? available.reduce((a, b) => a + b, 0) : null,
          available: available.length, missing: all.length - available.length }];
      })),
      perCase
    };
  }
  const difference = (a, b) => a === null || b === null ? null : a - b;
  const { A, B, C, D } = groups;
  return { planDigest: plan.digest, recordsDigest: digest(records), groups, runs: results,
    recallContrasts: { skillBasic: difference(B.recall, A.recall), skillIndexed: difference(D.recall, C.recall),
      materialBaseline: difference(C.recall, A.recall), materialImproved: difference(D.recall, B.recall),
      interaction: difference(difference(D.recall, C.recall), difference(B.recall, A.recall)) },
    limitations: ["Completed-run contrasts may be selection-biased; inspect completion and per-case repeats.",
      "Coverage is an evidenced reviewer claim, not a mechanically verified guarantee.",
      "Semantic decisions come from supplied adjudications; this tool does not judge prose or prove Agent effectiveness.",
      "Public synthetic development corpus only; no unknown holdout or project generalization result."] };
}

async function cli(args) {
  const json = async path => JSON.parse(await readFile(path, "utf8"));
  const [command, ...rest] = args;
  if (command === "verify" && rest.length === 0) return verifyCases();
  if (command === "export" && rest.length === 3) return exportParticipant(...rest);
  if (command === "plan" && rest.length === 1) return makePlan(await json(rest[0]));
  if (command === "score" && rest.length === 2) return summarize(await json(rest[0]), await json(rest[1]));
  throw new Error("Usage: evaluate.mjs verify | export <E01..E08> <basic|indexed> <new-directory> | plan <protocol.json> | score <plan.json> <records.json>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli(process.argv.slice(2)).then(value => console.log(JSON.stringify(value, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
