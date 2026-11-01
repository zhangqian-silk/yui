import { isDeepStrictEqual } from "node:util";
import { hash, cliOutputData } from "./common.mjs";
import { judgeInputHandling } from "../reuse-fixture/handling.mjs";
export const expectedAnswers = [
  { count: 2, total: 11, unknown: "unknown" },
  { count: 4, total: 29, unknown: "unknown" },
  { count: 4, total: 29, unknown: "unknown" },
  { count: 4, total: 29, unknown: "unknown" },
];
// Independent truth: participant sees only raw units, never this module.
export function gradeBusiness(decisions, key, stage, expected = expectedAnswers[stage - 1]) {
  const found = decisions.filter(d => d.title === key);
  if (found.length !== 1) return { status: "fail", reason: "missing-or-duplicate-effect", count: found.length };
  let actual; try { actual = JSON.parse(found[0].rationale); } catch { /* invalid format */ }
  return { status: expected !== undefined && isDeepStrictEqual(actual, expected) ? "pass" : "fail",
    actual, expected, effect: found[0].id };
}
export function gradeHandling(args) {
  if (!args.recovery) return judgeInputHandling(args);
  const { original, expected, wakes, effect, predecessor, successor } = args;
  const wake = wakes.find(w => w.id === expected.wakeId && w.taskId === expected.taskId);
  const claim = wake?.inbox?.claim, ack = wake?.inbox?.ack;
  const actor = (a, thread) => a?.scope === "task" && a.taskId === expected.taskId
    && a.roleName === "leader" && a.agentId === "codex" && a.nativeSessionId === thread;
  const exact = original.taskId === expected.taskId && original.id === expected.messageId
    && original.body === expected.body && original.submissionKey === expected.requestId
    && wake?.refs.some(r => r.type === "message" && r.taskId === expected.taskId && r.id === original.id)
    && claim?.requestId && ack?.requestId && ack?.reason
    && actor(claim.actor, predecessor) && actor(ack.actor, successor)
    && Date.parse(claim.at) <= Date.parse(effect.at) && Date.parse(effect.at) <= Date.parse(ack.at)
    && effect.status === "confirmed";
  return { status: exact ? "pass" : "fail", protocol: "successor-retained-original",
    failures: exact ? [] : ["recovery-exact-claim-effect-ack"], wakeReceiptApplicable: true };
}
// Read an actual in-flight mailbox observation, never reconstruct one from a
// completed Run. The caller retains it while a concurrent Operator finishes.
export function initialPlanningBinding(state, taskId, messageId) {
  const runs = (state.turns ?? []).map(r => JSON.parse(r.payload));
  const matches = (state.mailboxes ?? []).filter(m => m.processing).flatMap(m => {
    const dispatch = JSON.parse(m.processing), ref = dispatch.executionRef;
    if (ref?.type !== "run" || ref.taskId !== taskId
      || dispatch.owner !== `planning:${ref.id}` || dispatch.batchId !== `turn:${taskId}/${ref.id}`
      || !dispatch.batch?.refs?.some(r => r.type === "message" && r.taskId === taskId && r.id === messageId)) return [];
    return runs.filter(r => r.id === ref.id && r.taskId === taskId && r.roleName === "leader"
      && r.purpose === "planning" && r.effective?.agentId === "codex").map(run => ({ dispatch, run }));
  });
  return matches.length === 1 ? matches[0] : undefined;
}
export function gradeGlobal(original, expected) {
  const claim = original?.inbox?.claim, ack = original?.inbox?.ack;
  const actor = a => a?.scope === "global" && a.roleName === "operator"
    && a.agentId === "codex" && a.nativeSessionId === expected.threadId;
  const exact = original?.id === expected.id && original.body === expected.body
    && claim?.requestId && ack?.requestId && ack.reason && actor(claim.actor) && actor(ack.actor)
    && Date.parse(claim.at) <= Date.parse(expected.effectAt) && Date.parse(expected.effectAt) <= Date.parse(ack.at);
  return { status: exact ? "pass" : "fail", scope: "exact Global route handling, not downstream business acceptance" };
}
// Evaluation barriers only. The product CLI owns stop/replacement authority;
// an accepted `session new` request is never used as proof of native stop.
export function gradeRecoveryCheckpoint({ taskId, terminal, original, wake, effect }) {
  const claim = wake?.inbox?.claim, actor = claim?.actor;
  const exact = original?.taskId === taskId && wake?.taskId === taskId
    && wake.refs.some(r => r.type === "message" && r.taskId === taskId && r.id === original.id)
    && claim?.requestId && !wake.inbox.ack && actor?.scope === "task" && actor.taskId === taskId
    && actor.roleName === "leader" && actor.agentId === "codex" && actor.nativeSessionId === terminal.threadId
    && terminal.status === "completed" && Date.parse(terminal.startedAt) <= Date.parse(claim.at)
    && Date.parse(claim.at) <= Date.parse(effect?.createdAt) && Date.parse(effect.createdAt) <= Date.parse(terminal.at);
  return { status: exact ? "pass" : "fail",
    reason: "Exact predecessor claim → committed effect → completed Turn, intentionally retained without ACK; not normal handling success" };
}
export function gradeRecoveryStop({ taskId, terminal, stop, inspection }) {
  const exact = terminal?.status === "completed" && terminal.binding?.taskId === taskId
    && terminal.binding?.roleName === "leader" && typeof terminal.threadId === "string"
    && stop?.taskId === taskId && stop.roleName === "leader" && stop.stopped === true
    && inspection?.taskId === taskId && inspection.roleName === "leader"
    && inspection.session?.nativeSessionId === terminal.threadId && inspection.session.status === "ended";
  return { status: exact ? "pass" : "unknown",
    reason: exact ? "Exact completed predecessor plus synchronous CLI physical-stop result and ended Session readback"
      : "Predecessor stop not proven; no replacement or next business input permitted" };
}
export function gradeRecoverySuccessor({ taskId, predecessor, successor, after, proofs }) {
  const old = proofs.filter(p => p.taskId === taskId && p.role === "leader" && p.threadId === predecessor.threadId);
  const fresh = proofs.filter(p => p.taskId === taskId && p.role === "leader"
    && p.threadId === successor.threadId && p.method === "thread/start"
    && Date.parse(p.at) >= Date.parse(after)
    && !old.some(o => o.connection === p.connection));
  const exact = predecessor.threadId !== successor.threadId && fresh.length === 1
    && successor.status === "completed" && successor.binding?.taskId === taskId
    && successor.binding?.roleName === "leader" && Date.parse(successor.startedAt) >= Date.parse(after);
  return { status: exact ? "pass" : "unknown", freshProof: fresh,
    reason: exact ? "Fresh Thread/start established on a distinct connection after exact predecessor stop"
      : "Missing fresh successor ownership; predecessor identity/connection cannot substitute" };
}
export function gradeRecoveryPreservation({ before, after }) {
  const exact = before.original && before.claim && before.effect
    && ["original", "claim", "effect"].every(k => isDeepStrictEqual(before[k], after[k]));
  return { status: exact ? "pass" : "fail",
    reason: exact ? "Original, predecessor claim and committed Decision preserved byte/value-exact"
      : "Missing or changed original/claim/effect; no replay allowed" };
}
export function gradeRoutedInput(original, expected) {
  if (!original) return { status: "unknown", reason: "No saved routed original; missing delivery is not proof of changed values",
    classification: "missing-route", scope: "Stop and inspect exact native error/effect evidence; never replay unknown effects" };
  let input; try { input = JSON.parse(original?.body); } catch { /* not the routed JSON object */ }
  const exact = original?.taskId === expected.taskId && original.submissionKey === expected.requestId
    && original.intent === "discuss" && isDeepStrictEqual(input, expected.input);
  return { status: exact ? "pass" : "fail",
    reason: exact ? "exact JSON values and route target/key preserved" : "subject changed or omitted routed input/target/key",
    classification: exact ? undefined : "quality-fail",
    scope: "JSON object equality permits whitespace/key ordering, not string-content changes" };
}
// Reassemble *actual CLI outputs*, including full content pages, rather than
// trust a participant's read marker. This is fake instrumentation, not evidence
// that an autonomous real model chose a read or understood it.
function completeValues(trace) {
  const values = [], partial = new Map();
  const append = data => { if (data && typeof data === "object") values.push(data.context ?? data); };
  for (const e of trace) {
    if (e.code !== 0) continue;
    let envelope; try { envelope = JSON.parse(e.stdout); } catch { continue; }
    if (envelope?.ok === false) continue;
    if (e.pageObservation) {
      // Raw-output validation for the adapter's one exact terminal projection.
      // Source/body equality, full hash, scope and deadlines below are unchanged.
      const fields = e.pageObservation.projection === "terminal-text"
        ? ["complete", "nextCursor", "text"] : ["offset", "totalCharacters", "complete", "nextCursor", "text"];
      if (!envelope || Object.keys(envelope).length !== fields.length
        || !fields.every(k => Object.hasOwn(envelope, k) && envelope[k] === e.pageObservation.page?.[k])) continue;
      if (e.pageObservation.projection === "terminal-text"
        && (envelope.complete !== true || envelope.nextCursor !== null)) continue;
    }
    // The native adapter may establish a projected page's source from the
    // exact preceding returned cursor; its actual text is still hash-checked.
    let d = e.pageObservation ? { contentPage: e.pageObservation.page }
      : cliOutputData(envelope, e.args);
    if (!d) continue;
    d = d.context ?? d;
    if (!d?.contentPage) { append(d); continue; }
    const p = d.contentPage, key = `${p.source}/${p.digest}`, previous = partial.get(key), prior = previous?.text ?? "";
    if (typeof p.source !== "string" || typeof p.digest !== "string" || typeof p.text !== "string"
      || p.offset !== prior.length || p.encoding !== "json") { partial.delete(key); continue; }
    if (e.originalTool) {
      const ci = e.args.indexOf("--cursor"), cursor = ci < 0 ? undefined : e.args[ci + 1];
      const identity = JSON.stringify(ci < 0 ? e.args : e.args.slice(0, ci));
      if (previous ? previous.nextCursor !== cursor || previous.identity !== identity
        || previous.totalBytes !== p.totalBytes || previous.totalCharacters !== p.totalCharacters
        : cursor !== undefined || p.offset !== 0) { partial.delete(key); continue; }
    }
    const text = prior + p.text;
    const ci = e.args?.indexOf("--cursor") ?? -1;
    partial.set(key, { text, nextCursor: p.nextCursor, totalBytes: p.totalBytes,
      totalCharacters: p.totalCharacters, identity: JSON.stringify(ci < 0 ? e.args : e.args.slice(0, ci)) });
    if (p.complete === true && text.length === p.totalCharacters && hash(text) === p.digest
      && (!e.originalTool || Buffer.byteLength(text) === p.totalBytes && p.nextCursor === null)) {
      try { append(JSON.parse(text)); } catch { /* bad original */ }
      partial.delete(key);
    }
  }
  return values;
}
export function completeOriginals(trace) {
  return completeValues(trace).flatMap(d => {
    if (d.ref && d.value) return [d];
    if (d.taskId && d.decision?.taskId === d.taskId && typeof d.decision.id === "string")
      return [{ ref: { store: "task-decision", refId: d.decision.id }, value: d.decision }];
    if (typeof d.id === "string" && typeof d.body === "string")
      return [{ ref: { store: d.taskId === undefined ? "global-role-message" : "task-message", refId: d.id }, value: d }];
    return [];
  });
}
function eligible(traces, scope, sameTurn = false) {
  if (!scope) return [];
  return traces.filter(t => t.scope?.taskId === scope.taskId && t.scope?.roleName === scope.roleName
    && t.scope?.threadId === scope.threadId && t.scope?.epoch === scope.epoch
    && (!sameTurn || t.scope?.turnId === scope.turnId));
}
const timely = (entry, scope) => (entry.originalTool ? Date.parse(entry.at) < Date.parse(scope.beforeAt)
  : Date.parse(entry.at) <= Date.parse(scope.beforeAt))
  && (!scope.afterAt || Date.parse(entry.at) >= Date.parse(scope.afterAt));
export function gradeRecoveryInspection(traces, { effect, wake }, scope) {
  const matching = eligible(traces, scope, true);
  const timelyTraces = matching.map(t => t.trace.filter(e => timely(e, scope)));
  const originals = timelyTraces.flatMap(completeOriginals);
  const effects = originals.filter(o => o.ref?.store === "task-decision" && o.ref.refId === effect?.id
    && o.value?.taskId === scope.taskId);
  const wakes = timelyTraces.flatMap(completeValues).map(d => d.wake ?? d)
    .filter(d => d.taskId === scope.taskId && d.taskId === wake?.taskId && d.id === wake?.id
      && Array.isArray(d.refs));
  const effectRead = effects.some(o => isDeepStrictEqual(o.value, effect));
  const claimRead = Boolean(wake?.inbox?.claim) && wakes.some(d => isDeepStrictEqual(d.inbox?.claim, wake.inbox.claim));
  const contradicted = effects.some(o => !isDeepStrictEqual(o.value, effect))
    || wakes.some(d => !isDeepStrictEqual(d.inbox?.claim, wake.inbox?.claim));
  return { status: contradicted ? "fail" : effectRead && claimRead ? "pass" : "unknown",
    effectRead, claimRead, scope,
    reason: "Exact existing Decision and retained claim require complete timely successor-Turn output before ACK; missing/unsupported evidence stays unknown, observed contradiction fails" };
}
export function gradeReads(traces, sources, scope, { reuse = false } = {}) {
  if (!traces.length) return { status: "unknown", reason: "No attributed native full-original read evidence" };
  const matching = eligible(traces, scope, !reuse);
  // Reassemble pages within their original Turn, never mix pages across Turns.
  const originals = matching.flatMap(t => completeOriginals(t.trace.filter(e =>
    timely(e, reuse ? { ...scope, afterAt: undefined } : scope))).map(o => ({ ...o, turnId: t.scope.turnId })));
  const reused = [];
  const complete = sources.every(s => {
    const candidates = originals.filter(o => o.ref?.store === (s.store ?? "task-message")
      && o.ref.refId === s.id && o.value?.id === s.id && o.value.taskId === s.taskId && o.value.body === s.body);
    const proof = candidates.find(o => o.turnId === scope.turnId) ?? candidates[0];
    if (proof && proof.turnId !== scope.turnId) reused.push({ id: s.id, sha256: hash(s.body), turnId: proof.turnId });
    return Boolean(proof);
  });
  return { status: complete ? "pass" : matching.some(t => t.complete) ? "fail" : "unknown",
    required: sources.length, completeOriginalEquality: complete, reused, scope,
    contextAvailability: reused.length ? "unknown" : "current-output",
    reason: complete ? "exact full original output before effect in the same owner/Thread/epoch"
      : "missing timely attributed original proof",
    limit: "Full actual output, not Skill loads or authority. Prior-Turn output is not present model memory; internal downloads/metadata/summaries cannot fill gaps" };
}
export function gradeSkillBinding(traces, expected, scope, hostCheck) {
  const checks = eligible(traces, scope).flatMap(t => t.trace).filter(e => timely(e, scope))
    .flatMap(e => {
      const args = e.args?.filter(a => a !== "--json");
      if (e.code !== 0 || args?.[0] !== "session" || args[1] !== "skills") return [];
      try { const d = cliOutputData(JSON.parse(e.stdout), e.args); return Array.isArray(d?.skills) ? [d.skills] : []; } catch { return []; }
    });
  if (!checks.length) return hostCheck?.status === "pass" ? hostCheck
    : { status: "unknown", reason: "No timely attributed CLI or accepted Host Skill source metadata", hostCheck };
  const mismatches = checks.filter(actual => actual.length !== expected.length
    || expected.some(want => !actual.some(got => ["id", "path", "version", "versionPath"].every(k => got[k] === want[k]))));
  return { status: mismatches.length ? "fail" : "pass", mismatches, hostCheck,
    scope: "actual CLI-returned frozen Skill paths/versions in this owner context, not a body-load receipt" };
}
export function gradeDecisionChanges({ before, after, journal, allowed, terminal }) {
  const key = d => `${d.taskId}/${d.id}`;
  const old = new Map(before.map(d => [key(d), d])), next = new Map(after.map(d => [key(d), d]));
  const changed = [...new Set([...old.keys(), ...next.keys()])]
    .filter(k => !isDeepStrictEqual(old.get(k), next.get(k)));
  const permitted = allowed && !old.has(key(allowed)) && isDeepStrictEqual(next.get(key(allowed)), allowed)
    ? key(allowed) : undefined;
  const unexpectedState = changed.filter(k => k !== permitted);
  const decisionEvents = journal.filter(e => e.type.startsWith("decision."));
  const matching = [], unexpectedEvents = [];
  for (const e of decisionEvents) {
    let v; try { v = JSON.parse(e.payload); } catch { unexpectedEvents.push(e); continue; }
    if (allowed && e.type === "decision.recorded" && v.taskId === allowed.taskId
      && v.payload?.decisionId === allowed.id && v.payload?.leaderNativeSessionId === terminal.threadId
      && Date.parse(v.createdAt) >= Date.parse(terminal.startedAt) && Date.parse(v.createdAt) <= Date.parse(terminal.at))
      matching.push(e);
    else unexpectedEvents.push(e);
  }
  const failed = unexpectedState.length || unexpectedEvents.length || matching.length > 1;
  return { status: failed ? "fail" : permitted && matching.length !== 1 ? "unknown" : "pass",
    unexpectedState, unexpectedEvents, allowedRecordEvents: matching.length,
    scope: "observed Decision state and event deltas; arbitrary unjournaled restore remains unknown" };
}
export function forbiddenFileChanges(before, after, isBusinessFile) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path =>
    isBusinessFile(path) && !isDeepStrictEqual(before[path], after[path]));
}
export function gradeLoads(traces, expectedFiles, scope) {
  const matching = eligible(traces, scope);
  const actual = matching.flatMap(t => (t.loads ?? []).map(e => ({ ...e, turnId: t.scope.turnId })))
    .filter(e => !scope.loadActions ? timely(e, { ...scope, afterAt: undefined }) : true);
  const coverage = expectedFiles.map(f => {
    const action = f.action ?? scope.loadActions?.[f.path.endsWith("/yui-runtime/references/reporting.md") ? "reporting" : "business"];
    const deadlineKnown = !scope.loadActions || action?.status === "observed"
      && Number.isFinite(Date.parse(action.at)) && (action.epoch === undefined || action.epoch === scope.epoch)
      && (action.threadId === undefined || action.threadId === scope.threadId)
      && (action.turnId === undefined || action.turnId === scope.turnId);
    const source = Buffer.from(f.body), candidates = actual.filter(a => {
      if (a.path !== f.path || f.sha256 !== hash(f.body)) return false;
      const start = a.startByte ?? 0, end = a.endByte ?? a.bytes;
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start
        && end <= f.bytes && a.bytes === end - start
        && (a.sourceSha256 ?? a.sha256) === f.sha256 && hash(a.body) === a.sha256
        && source.subarray(start, end).equals(Buffer.from(a.body));
    });
    const ambiguousOrder = scope.loadActions && deadlineKnown
      && candidates.some(a => Date.parse(a.at) === Date.parse(action.at));
    const pieces = candidates.filter(a => deadlineKnown
      && (!scope.loadActions || Date.parse(a.at) < Date.parse(action.at)));
    const ranges = pieces.map(a => [a.startByte ?? 0, a.endByte ?? a.bytes]).sort((a, b) => a[0] - b[0]);
    let coveredBytes = 0, end = 0;
    for (const [lo, hi] of ranges) { coveredBytes += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi); }
    const currentRanges = pieces.filter(a => a.turnId === scope.turnId)
      .map(a => [a.startByte ?? 0, a.endByte ?? a.bytes]).sort((a, b) => a[0] - b[0]);
    let currentBytes = 0, currentEnd = 0;
    for (const [lo, hi] of currentRanges) {
      currentBytes += Math.max(0, hi - Math.max(lo, currentEnd)); currentEnd = Math.max(currentEnd, hi);
    }
    return { path: f.path, sha256: f.sha256, requiredBytes: f.bytes, coveredBytes, currentTurnBytes: currentBytes,
      ...(scope.loadActions ? { action, deadlineKnown, ambiguousOrder: Boolean(ambiguousOrder) } : {}),
      reused: coveredBytes === f.bytes && currentBytes < f.bytes,
      observedFragmentBytes: pieces.reduce((n, a) => n + a.bytes, 0),
      proofs: pieces.map(a => ({ at: a.at, nativeItemId: a.nativeItemId, turnId: a.turnId,
        startByte: a.startByte ?? 0, endByte: a.endByte ?? a.bytes, commandCwd: a.commandCwd })) };
  });
  const missing = coverage.filter(f => f.coveredBytes !== f.requiredBytes);
  const definiteMissing = missing.filter(f => f.deadlineKnown !== false && !f.ambiguousOrder);
  return { status: !missing.length ? "pass" : definiteMissing.length && matching.some(t => t.complete) ? "fail" : "unknown",
    missing: missing.map(f => f.path), coverage,
    contextAvailability: coverage.some(f => f.reused) ? "unknown" : "current-output",
    fullBytes: actual.filter(a => a.complete).reduce((s, a) => s + a.bytes, 0),
    fragments: actual.filter(a => !a.complete).map(a => ({ path: a.path, bytes: a.bytes })),
    metadataIsNotLoad: true, scope, evidence: scope.loadActions
      ? "same Task/Role/Thread/context epoch; exact bytes strictly before each applicable action; missing action/equal-time order stays unknown"
      : "same Task/Role/Thread/context epoch and exact frozen source slices before effect",
    limit: "Observed full-byte coverage is not comprehension or proof of present model memory. Missing bytes/unsupported output stay unknown unless the attributed inventory is complete." };
}
export function stageVerdict(checks) {
  const failed = Object.entries(checks).filter(([, g]) => g?.status === "fail").map(([check, grade]) => ({ check, grade }));
  const unknown = Object.entries(checks).filter(([, g]) => !g || g.status === "unknown").map(([check]) => check);
  return { status: failed.length ? "quality-fail" : unknown.length ? "observation-unknown" : "pass",
    failed, unknown, classification: "Observed subject business/protocol/read/load/authority violations are quality failures, not harness invalidity" };
}
// Observation gaps are not passes, but do not prevent observing a later warm
// input when all known business/protocol/authority checks permit it.
export const stageAllowsContinuation = (verdict, safety) => safety?.status === "pass"
  && (verdict.status === "pass" || verdict.status === "observation-unknown"
    && verdict.unknown.every(check => ["reads", "inputReads", "loads", "operatorReads", "operatorLoads", "reuseAvailability",
      "binding", "operatorBinding", "predecessorReads", "predecessorInputReads", "predecessorLoads"].includes(check)));
export function controllerAccessFailure(commands) {
  for (const entry of commands.filter(c => Number.isInteger(c.code) && c.code !== 0
    && c.observation?.cli === "observed")) for (const output of [entry.stderr, entry.stdout]) {
    let envelope; try { envelope = JSON.parse(output); } catch { continue; }
    const diagnostic = envelope?.details?.diagnostic, controller = diagnostic?.controller;
    if (envelope?.ok === false && envelope.code === "RUNTIME_ERROR"
      && controller?.code === "CONTROLLER_ACCESS_DENIED" && controller.delivery === "not-sent")
      return { status: "infrastructure-failed", fact: "Exact owned CLI Controller access denied before request delivery",
        nativeItemId: entry.nativeItemId, code: envelope.code, diagnostic };
  }
}
export function subjectFailure(commands) {
  const prerequisite = controllerAccessFailure(commands);
  if (prerequisite) return prerequisite;
  const native = commands.filter(c => c.observation);
  const details = native.length ? {
    observation: { status: native.some(c => c.observation.status === "unknown") ? "unknown" : "observed",
      gaps: native.filter(c => c.observation.status === "unknown").map(c =>
        ({ nativeItemId: c.nativeItemId, ...c.observation })) },
    nativeFailures: native.filter(c => Number.isInteger(c.code) && c.code !== 0 || c.nativeStatus === "failed").map(c =>
      ({ nativeItemId: c.nativeItemId, code: c.code, status: c.nativeStatus })),
  } : {};
  for (const entry of commands.filter(c => c.code !== 0 && c.observation?.cli !== "unknown"))
    for (const output of [entry.stderr, entry.stdout]) {
    let envelope; try { envelope = JSON.parse(output); } catch { continue; }
    if (envelope?.ok === false && envelope.code === "USAGE_ERROR")
      return { status: "quality-fail", fact: "Observed subject CLI request rejected by product",
        code: envelope.code, message: envelope.message, nativeItemId: entry.nativeItemId, ...details };
  }
  return { status: "infrastructure-failed", fact: "Native failed without attributable subject contract rejection; cause not guessed", ...details };
}
export function protocolApplicable(original, expected) {
  return original?.taskId === expected.taskId && original.id === expected.messageId
    && original.body === expected.body && original.submissionKey === expected.requestId
    && ["enter-planning", "continue-planning"].includes(original.submissionReceipt?.routing?.kind);
}
export function instructionLoadCosts(traces) {
  const seen = new Set(), contexts = new Set();
  const loads = traces.flatMap(t => t.loads ?? []);
  const repeated = loads.filter(l => {
    const key = JSON.stringify([l.path, l.sha256]);
    const duplicate = seen.has(key); seen.add(key); return duplicate;
  });
  const fullBodyContexts = { firstObservedUtf8: 0, repeatedUtf8: 0, unattributedUtf8: 0, reads: 0,
    firstObservedReads: 0, repeatedReads: 0, unattributedReads: 0 };
  for (const { scope, loads = [] } of traces) for (const load of loads.filter(l => l.complete)) {
    fullBodyContexts.reads++;
    if (![scope?.taskId, scope?.roleName, scope?.threadId].every(v => typeof v === "string" && v.length)
      || !Number.isSafeInteger(scope?.epoch) || scope.epoch < 0) {
      fullBodyContexts.unattributedUtf8 += load.bytes;
      fullBodyContexts.unattributedReads++;
      continue;
    }
    // Turn changes alone do not reset reusable context. A new role, thread,
    // Task, epoch or source does; observed repeats are not proof of waste.
    const key = JSON.stringify([scope.taskId, scope.roleName, scope.threadId, scope.epoch,
      load.path, load.sha256]);
    fullBodyContexts[contexts.has(key) ? "repeatedUtf8" : "firstObservedUtf8"] += load.bytes;
    fullBodyContexts[contexts.has(key) ? "repeatedReads" : "firstObservedReads"]++;
    contexts.add(key);
  }
  return {
    repeatedFullBodyUtf8: repeated.filter(l => l.complete).reduce((s, l) => s + l.bytes, 0),
    fullBodyContexts,
  };
}
export function tokenTotals(events) {
  const last = new Map();
  for (const e of events) {
    const m = e.message, p = m?.params;
    if (m?.method !== "thread/tokenUsage/updated" || !p?.threadId) continue;
    // total is cumulative per Thread; never sum successive snapshots or add
    // cached/reasoning subset fields to their parent.
    if (p.tokenUsage?.total) last.set(p.threadId, p.tokenUsage.total);
  }
  if (!last.size) return { status: "unknown", reason: "No native cumulative token usage; fake bytes are not tokens" };
  const fields = ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];
  return { status: "observed", threads: [...last], ...Object.fromEntries(fields.map(k =>
    [k, [...last.values()].every(v => Number.isFinite(v[k])) ? [...last.values()].reduce((s, v) => s + v[k], 0) : "unknown"])),
  hidden: "unknown", subsets: ["cachedInputTokens ⊂ inputTokens", "reasoningOutputTokens ⊂ outputTokens"] };
}
export function outcome({ framework, quality, infrastructure, interrupted, observation }) {
  if (framework === "fail") return "framework-invalid";
  if (infrastructure === "failed") return "infrastructure-failed";
  if (interrupted) return "interrupted";
  if (quality === "fail") return "quality-fail";
  if (observation !== "complete") return "observation-unknown";
  return "valid-pass";
}
export function comparable(a, b) {
  const plannedA = a.plannedStages ?? 3, plannedB = b.plannedStages ?? 3;
  return a.status === "valid-pass" && b.status === "valid-pass"
    && Number.isSafeInteger(plannedA) && plannedA > 0 && plannedA === plannedB
    && a.completedStages === plannedA && b.completedStages === plannedB
    && a.inputIdentity === b.inputIdentity && a.harnessIdentity === b.harnessIdentity
    && a.configurationIdentity === b.configurationIdentity;
}
