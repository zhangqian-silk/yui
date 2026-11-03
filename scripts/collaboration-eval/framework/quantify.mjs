// Supplemental measurements only. Original program grades and seals stay intact.
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { hash, completeJsonLines } from "./common.mjs";
import { attributeNativeEvents } from "./native-ownership.mjs";
import { nativeEvidence } from "./native-evidence.mjs";
import { instructionLoadCosts, tokenTotals } from "./judge.mjs";
import { ANALYSIS_VERSION } from "./saved-evidence.mjs";
export function ownedHistory(invocation) {
  const errors = [], raw = [];
  for (const path of invocation.files.filter(p => /(^|\/)transport-[^/]+\.jsonl$/.test(p))) {
    try {
      const { records, tail } = completeJsonLines(invocation.bytes(path).toString("utf8"));
      raw.push(...records.map(e => ({ ...e, sourceConnection: path })));
      if (tail) errors.push({ file: path, reason: "incomplete-jsonl-tail", tail });
    } catch (e) { errors.push({ file: path, reason: String(e) }); }
  }
  const attributed = attributeNativeEvents(raw);
  return { ...attributed, errors, raw,
    limit: "Only request/response-owned bodies. Detached/unproven/foreign content is not borrowed or exported as Subject evidence." };
}
export function frozenSources(invocation, productStores = []) {
  const files = [], missing = [], origins = [];
  for (const [name, expected] of Object.entries(invocation.preflight.skills ?? {})) {
    if (!name.endsWith(".md") && !name.endsWith("/VERSION")) continue;
    const suffix = `skills/${name}`;
    let found;
    for (const store of productStores) {
      for (const path of store.list().filter(p => p === suffix || p.endsWith(`/${suffix}`))) {
        const body = store.bytes(path);
        if (hash(body) === expected.sha256) { found = { store, path, body }; break; }
      }
      if (found) break;
    }
    if (!found) { missing.push({ kind: "skill", path: name, sha256: expected.sha256 }); continue; }
    const path = join(invocation.preflight.product ?? invocation.plan.product, "skills", name);
    files.push({ path, body: found.body.toString("utf8"), bytes: found.body.length, sha256: expected.sha256,
      kind: name.endsWith("/SKILL.md") ? "core" : name.endsWith(".md") ? "topic" : "inventory-only" });
    origins.push({ path, source: found.store.source, member: found.path, sha256: expected.sha256 });
  }
  // A profile's exact hash/path is in the frozen load coverage and native binding.
  const profiles = new Map();
  const readOwned = path => {
    const suffix = path.match(/\/runtime\/(session-manifests|role-profiles)\/([a-f0-9]+\.json)$/);
    if (!suffix) return;
    for (const owned of invocation.files.filter(p => p.endsWith("/owned-home.tar.gz"))) {
      try {
        const member = `./state/runtime/${suffix[1]}/${suffix[2]}`;
        const body = execFileSync("tar", ["-xOzf", "-", member],
          { input: invocation.bytes(owned), maxBuffer: 1024 * 1024, stdio: ["pipe", "pipe", "ignore"] });
        return { body, member: `${owned}::${member}` };
      } catch { /* Exact historical member only; no present-day fallback. */ }
    }
  };
  const attempted = new Set();
  for (const binding of ownedHistory(invocation).events.map(e => e.binding).filter(Boolean)) {
    if (attempted.has(binding.manifestPath)) continue;
    attempted.add(binding.manifestPath);
    const found = readOwned(binding.manifestPath ?? "");
    if (!found) continue;
    try {
      const manifest = JSON.parse(found.body);
      if (!manifest.roleProfileRef?.path || !manifest.roleProfileRef?.digest) continue;
      profiles.set(manifest.roleProfileRef.path, manifest.roleProfileRef.digest);
      files.push({ path: binding.manifestPath, body: found.body.toString("utf8"), bytes: found.body.length,
        sha256: hash(found.body), kind: "manifest" });
      origins.push({ path: binding.manifestPath, source: invocation.store.source, member: found.member, sha256: hash(found.body) });
    } catch { missing.push({ kind: "manifest", path: binding.manifestPath, reason: "invalid historical manifest" }); }
  }
  for (const result of invocation.ledger.results ?? []) {
    for (const row of [...(result.stages ?? []), ...(result.routes ?? [])]) {
      for (const c of row.loads?.coverage ?? [])
        if (c.path?.includes("/runtime/role-profiles/")) profiles.set(c.path, c.sha256);
    }
  }
  for (const [path, expected] of profiles) {
    const found = readOwned(path);
    const body = found && hash(found.body) === expected ? found.body : undefined, member = found?.member;
    if (!body) { missing.push({ kind: "profile", path, sha256: expected }); continue; }
    files.push({ path, body: body.toString("utf8"), bytes: body.length, sha256: expected, kind: "profile" });
    origins.push({ path, source: invocation.store.source, member, sha256: expected });
  }
  return { files, missing, origins };
}
const numBytes = s => Buffer.byteLength(typeof s === "string" ? s : JSON.stringify(s ?? null));
const knownSum = (values, key) => values.reduce((n, x) => n + (Number.isFinite(x?.[key]) ? x[key] : 0), 0);
// Wrapper observations only: one native command can launch several CLI
// processes, while a direct node entry can bypass this wrapper entirely.
// Never use these supplemental counts as read/authority/quality evidence.
export function instrumentedCliCosts(receipts, owners, launcherSha256) {
  const groups = new Map(), threads = new Map();
  let unmatchedRecords = 0, ambiguousIds = 0;
  for (const r of receipts) {
    if (!r || typeof r !== "object") { unmatchedRecords++; continue; }
    const owner = owners.find(o => r.entry === o.cli && r.product === o.product
      && r.home === o.home && r.node === o.node && r.threadId === o.threadId
      && r.cli === join(o.product, "output/dev/bin/yui"));
    if (!owner || r.launcherSha256 !== launcherSha256 || !r.id
      || !["started", "completed"].includes(r.phase) || !Number.isFinite(Date.parse(r.at))
      || !Array.isArray(r.args) || r.args.some(a => typeof a !== "string")) { unmatchedRecords++; continue; }
    if (!groups.has(r.id)) groups.set(r.id, { owner, records: new Map() });
    groups.get(r.id).records.set(JSON.stringify(r), r);
  }
  for (const { owner, records } of groups.values()) {
    const starts = [...records.values()].filter(r => r.phase === "started");
    const ends = [...records.values()].filter(r => r.phase === "completed");
    if (starts.length !== 1) { ambiguousIds++; continue; }
    const start = starts[0], id = JSON.stringify([owner.roleName, owner.threadId]);
    if (!threads.has(id)) threads.set(id, { role: owner.roleName, threadId: owner.threadId,
      started: 0, completed: 0, failed: 0, unclosed: 0 });
    const row = threads.get(id); row.started++;
    const end = ends[0];
    if (ends.length !== 1 || ["entry", "cli", "product", "home", "threadId", "cwd", "launcherSha256", "node"]
      .some(k => start[k] !== end[k]) || JSON.stringify(start.args) !== JSON.stringify(end.args)
      || start.at !== end.startedAt || Date.parse(end.at) < Date.parse(start.at)
      || !(Number.isInteger(end.code) || end.code === null && (end.signal || end.error))) {
      row.unclosed++; if (ends.length) ambiguousIds++; continue;
    }
    row.completed++;
    if (end.code !== 0 || end.signal || end.error) row.failed++;
  }
  return { status: "partial", threads: [...threads.values()], unmatchedRecords, ambiguousIds,
    limit: "Distinct matching wrapper process receipts by observed owned Thread, including failures. Not native tool/request counts, all CLI activity, per-Turn attribution, stdout visible to the model, source-reading or execution authority. Missing/bypassed receipts remain unmeasured." };
}
// Usage notifications are observations, not one-to-one provider request receipts.
// Preserve gaps/resets and keep this supplemental projection bounded.
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
export function quantifyEvents(events, stageRows = [], sources = []) {
  const key = (thread, turn) => `${thread}/${turn}`;
  const stages = new Map(stageRows.filter(s => s.terminal).map(s => [key(s.terminal.threadId, s.terminal.turnId), s]));
  const rows = new Map(), duplicates = [], seen = new Map();
  const get = (e, thread, turn) => {
    const id = key(thread, turn);
    if (!rows.has(id)) {
      const stage = stages.get(id);
      rows.set(id, { role: e.binding.roleName, threadId: thread, turnId: turn,
        stage: stage?.stage ?? "unknown", phase: "unknown", inputOrdinal: "unknown",
        hostInputUtf8: 0, tools: [], startedAt: undefined, completedAt: undefined,
        originalChecks: stage ? { business: stage.business, handling: stage.protocol ?? stage.grade,
          legal: stage.legal, fidelity: stage.input, reads: stage.reads, loads: stage.loads } : "unknown" });
    }
    return rows.get(id);
  };
  for (const e of events) {
    if (!e.binding) continue;
    const m = e.message, p = m?.params;
    if (e.direction === "host" && m?.method === "turn/start") {
      const response = events.find(r => r.sourceConnection === e.sourceConnection && r.direction === "native"
        && r.message?.id === m.id && r.message?.result?.turn?.id);
      if (response) get(e, p.threadId, response.message.result.turn.id).hostInputUtf8 += numBytes(p.input);
    }
    if (e.direction !== "native" || !p) continue;
    const turn = p.turnId ?? p.turn?.id;
    if (!p.threadId || !turn) continue;
    const row = get(e, p.threadId, turn);
    if (m.method === "turn/started") row.startedAt ??= e.at;
    if (m.method === "turn/completed") { row.completedAt = e.at; row.terminalStatus = p.turn?.status; }
    if (m.method === "item/completed" && p.item?.type === "commandExecution") {
      const item = p.item, id = `${p.threadId}/${turn}/${item.id}`;
      const fingerprint = hash(JSON.stringify(item));
      if (seen.has(id)) { duplicates.push({ id, identical: seen.get(id) === fingerprint }); continue; }
      seen.set(id, fingerprint);
      row.tools.push({ id: item.id, at: e.at, command: item.command, cwd: item.cwd, status: item.status,
        exitCode: item.exitCode ?? "unknown", durationMs: item.durationMs ?? "unknown",
        outputUtf8: typeof item.aggregatedOutput === "string" ? numBytes(item.aggregatedOutput) : "unknown",
        failed: item.status === "failed" || Number.isInteger(item.exitCode) && item.exitCode !== 0,
        outputHash: typeof item.aggregatedOutput === "string" ? hash(item.aggregatedOutput) : "unknown" });
    }
  }
  const participants = nativeEvidence(events, sources);
  const instructionParticipants = participants.map(p => ({ ...p,
    loads: (p.loads ?? []).filter(l => l.kind !== "inventory-only") }));
  const groups = new Map();
  const priorBodies = [];
  const priorTokens = new Map();
  const fresh = new Set(events.filter(e => e.direction === "host" && e.message?.method === "thread/start")
    .flatMap(e => events.filter(r => r.direction === "native" && r.sourceConnection === e.sourceConnection
      && r.message?.id === e.message.id && r.message?.result?.thread?.id).map(r => r.message.result.thread.id)));
  for (const row of [...rows.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))) {
    const group = `${row.role}/${row.threadId}`, ordinal = (groups.get(group) ?? 0) + 1;
    groups.set(group, ordinal); row.inputOrdinal = row.startedAt ? ordinal : "unknown";
    row.phase = row.startedAt ? ordinal === 1 ? "cold" : "warm" : "unknown";
    const own = participants.filter(p => p.scope.threadId === row.threadId && p.scope.turnId === row.turnId);
    const before = instructionLoadCosts(priorBodies);
    priorBodies.push(...instructionParticipants.filter(p => p.scope.threadId === row.threadId && p.scope.turnId === row.turnId));
    const after = instructionLoadCosts(priorBodies);
    row.recognizedBodies = { repeatedFullBodyUtf8: after.repeatedFullBodyUtf8 - before.repeatedFullBodyUtf8,
      fullBodyContexts: Object.fromEntries(Object.keys(after.fullBodyContexts)
        .map(k => [k, after.fullBodyContexts[k] - before.fullBodyContexts[k]])) };
    row.bodyOutputUtf8 = own.flatMap(p => p.loads ?? []).filter(l => l.kind !== "inventory-only")
      .reduce((n, l) => n + l.bytes, 0);
    const classified = own.flatMap(p => [
      ...(p.loads ?? []).map(l => ({ category: l.kind, bytes: l.bytes, evidence: l.nativeItemId, path: l.path })),
      ...["help", "inventories", "manifests", "projections", "trace"].flatMap(category =>
        (p[category] ?? []).map(l => ({ category: category === "trace" ? "cli-json" : category,
          bytes: numBytes(l.stdout ?? l.body ?? ""), evidence: l.nativeItemId, path: l.path }))),
    ]);
    row.sources = classified;
    row.toolOutputUtf8 = row.tools.every(t => typeof t.outputUtf8 === "number") ? knownSum(row.tools, "outputUtf8") : "unknown";
    row.observedToolOutputLowerBoundUtf8 = knownSum(row.tools, "outputUtf8");
    row.toolCount = row.tools.length; row.failedToolCount = row.tools.filter(t => t.failed).length;
    row.wallMs = row.startedAt && row.completedAt ? Date.parse(row.completedAt) - Date.parse(row.startedAt) : "unknown";
    row.outputClassifications = {
      bySource: Object.fromEntries([...new Set(classified.map(c => c.category))].map(category => [category,
        { bytes: classified.filter(c => c.category === category).reduce((n, c) => n + c.bytes, 0),
          denominator: row.toolOutputUtf8, denominatorKind: "captured completed command outputs, including failures; categories can overlap" }])),
      body: { bytes: row.bodyOutputUtf8, denominator: row.toolOutputUtf8, denominatorKind: "observed completed command outputs only; categories overlap" },
      hostInput: { bytes: row.hostInputUtf8, denominator: row.hostInputUtf8, denominatorKind: "captured turn/start input JSON only, not full context" },
      metadataHelpManifestOriginalOther: "Unclassified remainder stays unknown; command text alone is not output provenance",
    };
    row.totalContextUtf8 = "unknown"; row.billedCost = "unknown";
    const usageEvents = events.filter(e => e.binding && e.direction === "native" && e.message?.method === "thread/tokenUsage/updated"
      && e.message.params?.threadId === row.threadId && e.message.params?.turnId === row.turnId);
    const usage = usageEvents.at(-1)?.message.params.tokenUsage;
    row.lastRequestTokens = usage?.last ?? "unknown";
    const baseline = priorTokens.has(row.threadId) ? priorTokens.get(row.threadId)
      : fresh.has(row.threadId) && ordinal === 1 ? {} : undefined;
    row.usageObservations = usageObservations(usageEvents,
      baseline && fresh.has(row.threadId) && ordinal === 1 ? { inputTokens: 0, ...baseline } : baseline);
    row.tokens = usage?.total && baseline ? Object.fromEntries(Object.entries(usage.total).map(([k, value]) => {
      const previous = baseline[k] ?? (fresh.has(row.threadId) && ordinal === 1 ? 0 : undefined);
      return [k, Number.isFinite(value) && Number.isFinite(previous) && value >= previous ? value - previous : "unknown"];
    })) : "unknown";
    priorTokens.set(row.threadId, usage?.total);
    row.tokenAttribution = "Difference of consecutive captured cumulative Thread totals; first baseline zero only with owned fresh thread/start. lastRequestTokens is NOT Turn total. Hidden requests/billing unknown.";
    row.retryInterpretation = "All observed failed tools retained. A repeated command alone is not a proven retry/waste; native internal request retries unknown.";
  }
  return { rows: [...rows.values()], duplicates,
    totals: { observedTools: [...rows.values()].reduce((n, r) => n + r.toolCount, 0),
      observedFailedTools: [...rows.values()].reduce((n, r) => n + r.failedToolCount, 0),
      observedToolOutputLowerBoundUtf8: [...rows.values()].reduce((n, r) => n + r.observedToolOutputLowerBoundUtf8, 0),
      recognizedBodies: instructionLoadCosts(instructionParticipants), tokens: tokenTotals(events),
      totalContextUtf8: "unknown", hiddenUsage: "unknown", billedCost: "unknown" },
    limitations: ["Recognized Skill counts are output facts, not unnecessary-load judgments.",
      "Tool-output and Host-input denominators differ; overlapping categories must not be added.",
      "All observed failures/extra Turns remain; no missing inventory is interpreted as zero."] };
}
export function quantifyInvocation(invocation, sources) {
  const native = ownedHistory(invocation);
  const processReceipts = [], receiptErrors = [];
  for (const path of invocation.files.filter(p => p.endsWith("/cli-process-receipts.jsonl"))) {
    try {
      const { records, tail } = completeJsonLines(invocation.bytes(path).toString("utf8"));
      processReceipts.push(...records);
      if (tail) receiptErrors.push({ file: path, reason: "incomplete-jsonl-tail" });
    } catch (e) { receiptErrors.push({ file: path, reason: String(e) }); }
  }
  const owners = native.events.filter(e => e.binding && e.message?.params?.threadId)
    .map(e => ({ ...e.binding, threadId: e.message.params.threadId }));
  const stageRows = (invocation.ledger.results ?? []).flatMap(r => [
    ...(r.stages ?? []), ...(r.routes ?? [])]);
  return { identity: invocation.identity, versions: invocation.versions, analysisVersion: ANALYSIS_VERSION,
    run: { mode: invocation.plan.mode, product: invocation.preflight.commit, input: invocation.plan.inputIdentity,
      harness: invocation.plan.harnessIdentity, configuration: invocation.plan.configurationIdentity,
      originalResults: invocation.ledger.results?.map(r => ({ scenario: r.scenario, status: r.status,
        completedStages: r.completedStages, error: r.error, originalCost: r.cost, originalTokens: r.tokens,
        originalAccount: r.account, cleanup: r.cleanup?.status })) },
    ...quantifyEvents(native.events, stageRows, sources.files),
    instrumentedCli: { ...instrumentedCliCosts(processReceipts, owners, invocation.preflight.launcher),
      errors: receiptErrors },
    sourceMissing: sources.missing, inventory: { errors: native.errors, rejected: native.rejected,
      scope: native.limit, totalEventInventory: "unknown" } };
}
