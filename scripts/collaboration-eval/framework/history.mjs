// Historical index -> supplemental measurement -> independent review handoff.
// No Provider/runner/Home imports and no automatic model calls.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "./common.mjs";
import { openEvidence, readSavedInvocation, ANALYSIS_VERSION } from "./saved-evidence.mjs";
import { frozenSources, quantifyInvocation } from "./quantify.mjs";
import { exportReviewCase, exportReadableReview, validateReview, diagnoseReview, compareReviews, REVIEW_VERSION } from "./semantic-review.mjs";
import { readReviewPage } from "./readable-review.mjs";
const json = file => JSON.parse(readFileSync(file, "utf8"));
const put = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
function walk(root) {
  return readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(e => e.isDirectory() ? walk(join(root, e.name)) : e.isFile() ? [join(root, e.name)] : []);
}
function comparisonKey(saved) {
  const p = saved.plan, pre = saved.preflight;
  const fields = { mode: p.mode, product: pre.commit, input: p.inputIdentity, harness: p.harnessIdentity,
    configuration: p.configurationIdentity, provider: pre.providerIdentity?.sha256 ?? "unknown",
    scenarios: p.scenarios, source: hash(JSON.stringify(pre.actualSource ?? null)),
    skills: hash(JSON.stringify(pre.skills ?? null)), node: pre.node, platform: pre.platform,
    permission: p.permissionMode ?? "unknown", model: "unknown-until-native-config-checked" };
  return { fields, key: hash(JSON.stringify(fields)), limitation: "Exact recorded condition grouping only; equal keys do not establish successful quality, complete evidence, or causal savings. Missing model/configuration remains unknown." };
}
export function indexHistory(root) {
  const archives = walk(resolve(root)).filter(p => /raw[^/]*\.tar(?:\.gz)?$/.test(basename(p)));
  const entries = [], releases = [], seen = new Map();
  for (const archive of archives) {
    // Retired OS/security diagnostics are listed, not reopened as evaluation.
    if (/run(?:49|51|52|53)-isolation/.test(archive)) {
      entries.push({ archive, archiveSha256: hash(readFileSync(archive)), status: "excluded-retired-security-scope" }); continue;
    }
    let store;
    try {
      store = openEvidence(archive);
      const prefixes = store.list().filter(p => p === "seal.json" || p.endsWith("/seal.json"))
        .map(p => p === "seal.json" ? "" : p.slice(0, -10));
      if (!prefixes.length) entries.push({ archive, archiveSha256: store.archiveSha256, status: "unsealed-archive",
        members: store.list().length, limitation: "No inferred grade or replay; original evidence preserved" });
      for (const prefix of prefixes) {
        try {
          const saved = readSavedInvocation(store, prefix), duplicateOf = seen.get(saved.identity);
          if (!duplicateOf) seen.set(saved.identity, { archive, prefix });
          entries.push({ archive, archiveSha256: store.archiveSha256, prefix, identity: saved.identity, duplicateOf,
            status: "verified", mode: saved.plan.mode, conditions: comparisonKey(saved),
            originalResults: saved.ledger.results?.map(r => ({ scenario: r.scenario, status: r.status,
              error: r.error, completedStages: r.completedStages, plannedStages: r.plannedStages })) });
        } catch (e) { entries.push({ archive, prefix, status: "invalid-saved-evidence", error: String(e) }); }
      }
    } catch (e) { entries.push({ archive, status: "unreadable-archive", error: String(e) }); }
    finally { if (store) { store.close(); releases.push({ archive, released: store.released }); } }
  }
  return { version: ANALYSIS_VERSION, root: resolve(root), archives: archives.length, entries, releases,
    uniqueInvocations: seen.size, originalEvidenceModified: false,
    selection: "Inventory includes failures, fake runs, invalid/unsealed archives and duplicates; no historical Subject is rerun." };
}
export function analyzeHistory(index, destination, selection) {
  if (existsSync(destination)) throw Error("Analysis output exists; choose a new output, never overwrite");
  mkdirSync(destination, { recursive: true });
  mkdirSync(join(destination, "cases"));
  const reports = [], mapping = [], releases = [], errors = [];
  const selected = index.entries.filter(e => e.status === "verified" && !e.duplicateOf && (!selection || selection(e)));
  for (const entry of selected) {
    let store; const products = [];
    try {
      if (hash(readFileSync(entry.archive)) !== entry.archiveSha256) throw Error("Archive changed since index");
      store = openEvidence(entry.archive);
      const saved = readSavedInvocation(store, entry.prefix);
      if (saved.identity !== entry.identity) throw Error("Invocation identity changed since index");
      const parent = dirname(entry.archive);
      for (const name of ["product-sources.tar.gz", "source-A.tar", "source-B.tar"]) {
        if (existsSync(join(parent, name))) {
          try { products.push(openEvidence(join(parent, name))); }
          catch (e) { errors.push({ source: join(parent, name), error: String(e) }); }
        }
      }
      const sources = frozenSources(saved, products), measured = quantifyInvocation(saved, sources);
      const label = `case-${String(reports.length + 1).padStart(3, "0")}-${hash(saved.identity).slice(0, 8)}`;
      const review = exportReviewCase(saved, sources, join(destination, "cases", label), label);
      put(join(destination, `${label}-quant.json`), measured);
      // Original grades are NOT in the first-pass case; mapping stays outside it.
      put(join(destination, `${label}-program-checks.json`), { identity: saved.identity,
        originalLedger: saved.ledger, unchanged: true, reveal: "after sealed independent first-pass judgment" });
      mapping.push({ ...entry, caseId: label, ...review.privateMapping });
      const { privateMapping, ...publicReview } = review;
      reports.push({ caseId: label, identity: saved.identity, conditions: entry.conditions,
        originalResults: measured.run.originalResults, totals: measured.totals,
        rows: measured.rows.map(r => ({ role: r.role, stage: r.stage, phase: r.phase, threadId: r.threadId,
          turnId: r.turnId, toolCount: r.toolCount, failedToolCount: r.failedToolCount,
          outputUtf8: r.toolOutputUtf8, bodies: r.recognizedBodies, tokens: r.tokens, wallMs: r.wallMs,
          usageObservations: {
            uniqueUpdates: r.usageObservations.uniqueUpdates, duplicateUpdates: r.usageObservations.duplicateUpdates,
            observedLastInputRange: r.usageObservations.observedLastInputRange,
            requestCount: r.usageObservations.requestCount, detail: `${label}-quant.json`,
          } })),
        review: publicReview, semanticReview: "not-run" });
    } catch (e) { errors.push({ archive: entry.archive, prefix: entry.prefix, error: String(e) }); }
    finally {
      for (const s of [...products, store].filter(Boolean)) { s.close(); releases.push({ source: s.source, released: s.released }); }
    }
  }
  const groups = new Map();
  for (const report of reports) {
    const group = groups.get(report.conditions.key) ?? [];
    group.push(report.caseId); groups.set(report.conditions.key, group);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const implementation = Object.fromEntries(["saved-evidence.mjs", "quantify.mjs", "native-evidence.mjs",
    "native-ownership.mjs", "judge.mjs", "history.mjs", "semantic-review.mjs", "readable-review.mjs"].map(p => [p, hash(readFileSync(join(here, p)))]));
  const summary = { analysisVersion: ANALYSIS_VERSION, reviewVersion: REVIEW_VERSION, implementation,
    selectedInvocations: selected.length, analyzedInvocations: reports.length, reports, errors, releases,
    comparisonGroups: [...groups].map(([key, cases]) => ({ key, cases, crossCaseComparable: cases.length > 1 ? "recorded-conditions-only" : false })),
    limitations: ["Different product/input/harness conditions are listed separately, not pooled into an optimization claim.",
      "Cold/warm is observed input order per owned Role/Thread, not memory availability.",
      "Historical Subject runs, original grades and seals remain unchanged. Semantic review has NOT run.",
      "Interface unknown does not veto future evidence-supported semantic judgments; authority/data integrity/unknown effects remain hard boundaries."],
    reviewCosts: { status: "not-run", tokens: "unknown", wallMs: "unknown", billedCost: "unknown" } };
  put(join(destination, "private-mapping.json"), mapping);
  put(join(destination, "summary.json"), summary);
  return summary;
}
const main = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (main) {
  const [command, input, output, option, receipts] = process.argv.slice(2);
  if (command === "index" && input && output) put(output, indexHistory(input));
  else if (command === "analyze" && input && output) {
    const batches = option?.split(",");
    const result = analyzeHistory(json(input), output, e => !batches || batches.some(b => e.archive.includes(`/${b}/`)));
    console.log(JSON.stringify({ analyzed: result.analyzedInvocations, errors: result.errors, output }, null, 2));
    if (result.errors.length) process.exitCode = 1;
  } else if (command === "view" && input && output) {
    console.log(JSON.stringify(exportReadableReview(input, output), null, 2));
  } else if (command === "read" && input && output) {
    const [offset = 0, limit = 12000] = option ? option.split(",").map(Number) : [];
    const { text, ...page } = readReviewPage(input, output, offset, limit);
    // Metadata header followed by literal decoded text, not another escaped
    // JSON string envelope that would recreate the citation mismatch.
    process.stdout.write(JSON.stringify(page) + "\n" + text);
  } else if (command === "diagnose" && input && output) {
    const result = diagnoseReview(input, json(output), [process.env.CODEX_THREAD_ID].filter(Boolean),
      option ? { ...json(option), reviewFile: resolve(output) } : undefined);
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "rejected") process.exitCode = 1;
  } else if (command === "import" && input && output && option) {
    const checked = validateReview(input, json(output), [process.env.CODEX_THREAD_ID].filter(Boolean),
      receipts ? { ...json(receipts), reviewFile: resolve(output) } : undefined);
    checked.sourceReviewFileSha256 = hash(readFileSync(output));
    put(option, checked); console.log(JSON.stringify({ status: checked.status, executionIndependence: checked.executionIndependence }));
  } else if (command === "compare" && input && output && option) put(option, compareReviews(json(input), json(output)));
  else throw Error("Usage: history.mjs index <evidence-root> <NEW-index.json> | analyze <index> <NEW-out> [batch,batch] | view <sealed-case> <NEW-case> | read <case> <V-id> [offset,limit] | diagnose <case> <review.json> [receipt-paths.json] | import <case> <review.json> <NEW-checked.json> [receipt-paths.json] | compare <checked-A> <checked-B> <NEW-comparison.json>");
}
