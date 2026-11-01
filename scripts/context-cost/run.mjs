import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scanHeaders, planChain, measure } from "./measure.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || !process.argv[i + 1]) throw new Error("Expected --name value");
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
for (const name of ["sessions-root", "task-workspaces", "leader-first", "leader-last", "operator-id",
  "operator-tail", "operator-tail-bytes", "cutoff", "output"]) {
  if (!args[name]) throw new Error(`Missing --${name}`);
}
const cutoff = args.cutoff;
if (!Number.isFinite(Date.parse(cutoff))) throw new Error("Invalid cutoff");
const first = Number(args["leader-first"]), last = Number(args["leader-last"]);
const tailBytes = Number(args["operator-tail-bytes"]);
if (![first, last, tailBytes].every(Number.isSafeInteger) || first > last || first < 1 || tailBytes <= 0) throw new Error("Invalid bounds");
const output = resolve(args.output);
const headers = await scanHeaders(resolve(args["sessions-root"]));
const eligible = headers.filter(h => Date.parse(h.timestamp) <= Date.parse(cutoff));
const operatorTail = eligible.find(h => h.path === resolve(args["operator-tail"]));
if (!operatorTail || operatorTail.id !== args["operator-id"]) throw new Error("Operator tail root mismatch");
const operatorPlan = planChain(eligible, operatorTail, tailBytes);
const operator = await measure(operatorPlan, { cutoff });
const leaders = [], missing = [], excludedChildren = [];
const workspaceRoot = resolve(args["task-workspaces"]);
for (let n = first; n <= last; n++) {
  const taskId = `task-${n}`, main = join(workspaceRoot, taskId, "main");
  const matches = eligible.filter(h => resolve(h.cwd ?? "/") === main);
  const roots = matches.filter(h => h.root);
  for (const h of matches.filter(h => !h.root)) excludedChildren.push({ taskId, path: h.path, id: h.id, parent: h.parent, fork: h.fork });
  const rootIds = [...new Set(roots.map(h => h.id))];
  if (rootIds.length !== 1) { missing.push({ taskId, reason: rootIds.length ? "ambiguous roots" : "no root metadata", rootCount: rootIds.length }); continue; }
  const tail = roots.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1);
  const plan = planChain(eligible, tail);
  leaders.push({ taskId, rootId: tail.id, measurement: await measure(plan, { cutoff }) });
}

function aggregate(measurements) {
  const result = { sessions: measurements.length, visible: { added: { chars: 0, bytes: 0 },
    duplicate: { chars: 0, bytes: 0 }, categories: {}, compactionReplacement: { chars: 0, bytes: 0 },
    resetWindowSkillReads: { chars: 0, bytes: 0 }, resetWindowSkillReadsByCause: {} },
    usage: { exact: { requests: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
      snapshotOnlyUnidentifiedTransitions: 0, duplicateRecords: 0 },
    turns: 0, compactions: 0, opaqueReasoningRecords: 0 };
  function sum(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "number") target[key] = (target[key] ?? 0) + value;
      else if (value && typeof value === "object") sum(target[key] ??= {}, value);
    }
  }
  for (const m of measurements) {
    for (const name of ["added", "duplicate", "categories", "compactionReplacement", "resetWindowSkillReads", "resetWindowSkillReadsByCause"]) sum(result.visible[name], m.visible[name]);
    sum(result.usage.exact, m.usage.exact);
    result.usage.snapshotOnlyUnidentifiedTransitions += m.usage.snapshotOnlyUnidentifiedTransitions;
    result.usage.duplicateRecords += m.usage.duplicateRecords;
    result.turns += m.turns; result.compactions += m.compactions; result.opaqueReasoningRecords += m.opaqueReasoningRecords;
  }
  // Residence snapshots from independent sessions are NOT summed as one retained context.
  return result;
}
const rootIds = new Set(leaders.map(l => l.rootId));
const linkedChildren = eligible.filter(h => !h.root && (rootIds.has(h.parent) || rootIds.has(h.sessionId)));
const workItemHeaders = eligible.filter(h => {
  const rel = relative(workspaceRoot, h.cwd ?? "/");
  const match = /^task-(\d+)\/(?:work-items|reviews)\//.exec(rel);
  return match && Number(match[1]) >= first && Number(match[1]) <= last;
});
const code = {};
for (const file of ["measure.mjs", "run.mjs", "check.mjs"]) {
  code[file] = createHash("sha256").update(await readFile(new URL(file, import.meta.url))).digest("hex");
}
const report = {
  schemaVersion: 1, study: "historical-exploration-not-B0",
  cutoff, command: [process.execPath, ...process.argv.slice(1)], code,
  checkoutCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: fileURLToPath(new URL("../..", import.meta.url)), encoding: "utf8" }).trim(),
  codeIdentity: "Source SHA-256s above bind this run even when checkoutCommit predates the script commit.",
  node: process.version,
  coverage: {
    leaderExpected: last - first + 1, leaderRootsMeasured: leaders.length, missing,
    operatorSegments: operatorPlan.length, excludedSameCwdChildren: excludedChildren,
    metadataLinkedChildSegmentsNotMeasured: linkedChildren.length,
    workItemOrReviewSegmentsNotMeasured: workItemHeaders.length,
    executionTree: "Main-root bodies ONLY. Child/Worker/Reviewer/retry body costs not measured; metadata counts are not a complete execution tree. No overall-cost or delegation-savings conclusion.",
    operatorDispositions: "Semantic legal disposition count is unknown from rollout events; no per-disposition efficiency claim."
  },
  totals: { operator: aggregate([operator]), leader: aggregate(leaders.map(l => l.measurement)) },
  operator, leaders
};
await mkdir(output, { recursive: true });
await writeFile(join(output, "aggregate.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ output: join(output, "aggregate.json"), coverage: {
  ...report.coverage, excludedSameCwdChildren: excludedChildren.length
}, totals: report.totals }, null, 2));
