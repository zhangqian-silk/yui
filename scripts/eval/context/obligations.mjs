// Evaluator-only carriers for explicitly reviewed frozen products.
// A removed file never removes its semantic obligation. Unknown carriers fail closed.
import { hash, currentPlanningContract } from "./common.mjs";
import { gradeLoads } from "./judge.mjs";
const main = "yui-runtime/SKILL.md", separate = "yui-runtime/references/reporting.md";
export function reportingCarrier(inventory) {
  const contract = currentPlanningContract(inventory);
  if (contract) return { status: "observed", kind: "reviewed-inline-action-core",
    path: main, sha256: inventory[main].sha256, contract };
  if (inventory["yui-runtime/VERSION"]?.sha256 === hash("22\n")
    && inventory[main]?.sha256 === "edc7752aca413ae3b3937f004d35a3ca5bb0b174d823c246eb06947f7b3c81b9"
    && inventory[separate]?.sha256 === "a70bf140464d883a58208018d7f743455fe9ea1ea2569ebf4b9bcf5cb73fb8f4")
    return { status: "observed", kind: "separate-reference",
    path: separate, sha256: inventory[separate].sha256 };
  if (!inventory[separate] && inventory["yui-runtime/VERSION"]?.sha256 === hash("23\n")
    && inventory[main]?.sha256 === "0a40049f834fccf7ebd08150500379a0032ff1ff2ee203746cb78e33db4b1bcf")
    return { status: "observed", kind: "reviewed-inline-runtime23", path: main, sha256: inventory[main].sha256 };
  // Runtime24 changes only pagination guidance; the entire reporting section
  // is byte-identical to Runtime23. Still require its reviewed full-body hash.
  if (!inventory[separate] && inventory["yui-runtime/VERSION"]?.sha256 === hash("24\n")
    && inventory[main]?.sha256 === "1dbac0c50b767ec8b374d138ce2fe63b1e8e4ac353dcf2cfc9993ea21518c35a")
    return { status: "observed", kind: "reviewed-inline-runtime24", path: main, sha256: inventory[main].sha256 };
  // Exact reviewed inline bodies, including run133 B's Runtime29 action core:
  // "Use the exact authority and originals" retains current Task-fact duties;
  // its final paragraphs retain truthful managed reporting. Action manuals
  // remain separate applicable references; mapping this core does not waive them.
  // This maps the carrier only; full actual bytes and action deadlines remain.
  for (const [version, digest] of [
    ["20", "ce8967bb8d0cbfabf42204ffa93889989c13834eec75d17199ba0e08e615379a"],
    ["25", "b963043bd70639164437203e544dd7614548782fdf48643c596adbe3c3e91c26"],
    ["26", "7cf7eb698a9152bab012fe1f6904e0ffcd28f333918471135156db68da9bdd0b"],
    ["29", "35689259fc083b3c79f24a27385aef5722ea9ec433008b20aedf810d5a24a2e5"],
  ]) if (!inventory[separate] && inventory["yui-runtime/VERSION"]?.sha256 === hash(version + "\n")
    && inventory[main]?.sha256 === digest)
    return { status: "observed", kind: `reviewed-inline-runtime${version}`, path: main, sha256: digest };
  return { status: "unknown", reason: "No declared exact reporting carrier for this frozen product" };
}
export function taskFactsCarrier(inventory) {
  const path = "yui-runtime/references/task-context.md";
  if (inventory[path]) return { status: "observed", path, sha256: inventory[path].sha256 };
  const inline = reportingCarrier(inventory);
  return ["reviewed-inline-action-core", "reviewed-inline-runtime20", "reviewed-inline-runtime25", "reviewed-inline-runtime26", "reviewed-inline-runtime29"].includes(inline.kind) ? inline
    : { status: "unknown", reason: "No reviewed exact Task-context carrier" };
}
// Only captured, owned, accepted Host inputs; never a model's asserted receipt.
// A warm notice must descend from accepted pointers on the SAME connection and
// Thread. Metadata does not enter gradeLoads or manufacture source/body bytes.
export function gradeHostSkillCheck(events, expected, scope, sources = []) {
  const line = "Yui Host checked current Skills; no Agent version-check call is needed for this input.";
  const shortLine = "Yui Host checked current Skills; no Agent check needed.";
  const reminder = "On compaction or missing/uncertain instructions, reload required instructions; unchanged versions do not prove memory.";
  const accepted = events.filter(e => e.direction === "host" && e.message?.method === "turn/start"
    && e.binding?.taskId === scope.taskId && e.binding?.roleName === scope.roleName
    && e.message.params?.threadId === scope.threadId && e.sourceConnection
    && Date.parse(e.at) < Date.parse(scope.beforeAt)).flatMap(q => {
      const responses = events.filter(r => r.sourceConnection === q.sourceConnection && r.direction === "native"
        && r.message?.id === q.message.id && !r.message.method && !r.message.error
        && typeof r.message.result?.turn?.id === "string"
        && Date.parse(r.at) >= Date.parse(q.at) && Date.parse(r.at) < Date.parse(scope.beforeAt));
      return responses.length === 1 ? [{ q, turnId: responses[0].message.result.turn.id }] : [];
    });
  const current = accepted.filter(p => p.turnId === scope.turnId);
  if (current.length !== 1) return { status: "unknown", reason: "No unique timely accepted Host input" };
  // Independent captured source, not a path asserted by the notice or model.
  // Checking these bytes binds metadata only; it never credits an Agent read.
  const profileFor = q => {
    const b = q.binding, files = sources.filter(f => f.path === b.manifestPath);
    if (!b.home || !b.manifestPath?.startsWith(`${b.home}/runtime/session-manifests/`)
      || files.length !== 1 || typeof files[0].body !== "string"
      || hash(files[0].body) !== files[0].sha256) return undefined;
    try {
      const m = JSON.parse(files[0].body), p = m.roleProfileRef;
      if (m.owner?.scope !== (scope.taskId ? "task" : "global") || m.owner.taskId !== scope.taskId
        || m.roleKind !== scope.roleName || !/^[a-f0-9]{64}$/.test(p?.digest ?? "")
        || p.path !== `${b.home}/runtime/role-profiles/${p.digest}.json`
        || !Array.isArray(m.skills) || m.skills.length !== expected.length
        || new Set(m.skills.map(s => s.id)).size !== expected.length
        || !expected.every(w => m.skills.some(s => ["id", "path", "version", "versionPath"]
          .every(k => s[k] === w[k])))) return undefined;
      return p.path;
    } catch { return undefined; }
  };
  if (!profileFor(current[0].q)) return { status: "unknown", reason: "Missing/wrong owned Manifest source" };
  let pointers;
  for (const { q, turnId } of accepted.filter(p => p.q.sourceConnection === current[0].q.sourceConnection
    && Date.parse(p.q.at) <= Date.parse(current[0].q.at)).sort((a, b) => Date.parse(a.q.at) - Date.parse(b.q.at))) {
    const profile = profileFor(q);
    if (!profile || q.binding.home !== current[0].q.binding.home
      || q.binding.manifestPath !== current[0].q.binding.manifestPath) { pointers = undefined; continue; }
    const text = q.message.params.input?.[0]?.text;
    if (typeof text !== "string" || ![line, shortLine].some(l => text.startsWith(l + "\n"))) {
      pointers = undefined; continue;
    }
    const end = text.indexOf("\n\n");
    if (end < 0) { pointers = undefined; continue; }
    const prefix = text.slice(0, end);
    const lines = prefix.split("\n");
    const workingSetNotice = lines[0] === shortLine;
    const cold = lines.includes("First input or recovered attachment: read its Role profile and fully load the current applicable instructions.")
      || lines.includes(`First input or recovered attachment: before any Task/context read, read the exact Role profile at ${profile}, then the full current Runtime, Role and applicable references. A Task role-profile projection is not this profile.`)
      || workingSetNotice && lines.includes(`First input or recovered attachment: read the exact Role profile at ${profile} and the full current listed Skill entry points. Follow references only for the action you are taking, not to restore every previously used procedure. A Task role-profile projection is not this profile.`);
    const changed = lines.includes("Skill metadata changed: load affected entries and applicable references; retain other complete instructions.");
    const pointer = lines.find(l => l.startsWith("Current Skill pointers: "));
    if (cold) pointers = undefined;
    if (pointer && (cold || changed) && lines.includes(`Yui Session Manifest: ${q.binding.manifestPath}`)) {
      try {
        const actual = JSON.parse(pointer.slice("Current Skill pointers: ".length));
        if (!Array.isArray(actual) || new Set(actual.map(s => s.id)).size !== actual.length) throw Error("Ambiguous pointers");
        pointers = new Map([...(pointers ?? []), ...actual.map(s => [s.id, s])]);
      } catch { pointers = undefined; }
    } else if (prefix !== (workingSetNotice ? shortLine : `${line}\n${reminder}`)) pointers = undefined;
    if (turnId !== scope.turnId) continue;
    const match = (workingSetNotice || lines.at(-1) === reminder) && pointers?.size === expected.length
      && expected.every(w => ["id", "path", "version"].every(k => pointers.get(w.id)?.[k] === w[k]));
    return { status: match ? "pass" : "unknown", mode: cold ? "cold-or-recovery" : changed ? "changed" : "unchanged",
      prefixUtf8: Buffer.byteLength(text.slice(0, end + 2)), prefixSha256: hash(text.slice(0, end + 2)),
      connection: q.sourceConnection, requestId: q.message.id, at: q.at, turnId,
      scope: "Owned accepted Host metadata only; no body load, memory, authority or compaction inference" };
  }
  return { status: "unknown", reason: "Host metadata continuity unavailable" };
}
function cliAction(bundles, events, scope, predicate, kind) {
  const traces = bundles.filter(b => ["taskId", "roleName", "threadId", "turnId", "epoch"]
    .every(k => b.scope[k] === scope[k])).flatMap(b => b.trace).filter(t => {
    const a = t.args.filter(x => x !== "--json");
    return predicate(a);
  });
  if (!traces.length) return { status: "not-observed",
    limit: `No recognized ${kind} in current Turn; unsupported/hidden actions remain unknown, not universally unnecessary` };
  const actions = traces.map(t => {
    const id = t.compound?.nativeItemId ?? t.nativeItemId;
    const starts = events.filter(e => e.message?.method === "item/started"
      && e.message.params?.threadId === scope.threadId && e.message.params.turnId === scope.turnId
      && e.message.params.item?.id === id);
    return { status: starts.length === 1 ? "observed" : "unknown",
      at: starts.length === 1 ? starts[0].at : undefined, nativeItemId: id, args: t.args,
      kind, boundary: "enclosing-native-command-start" };
  });
  if (actions.some(a => a.status !== "observed")) return { status: "unknown", actions,
    reason: `${kind} observed but exact command start unavailable` };
  return { ...actions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0], actions };
}
export function taskFactsAction(bundles, events, scope) {
  return cliAction(bundles, events, scope, a => a[0] === "task" && (a[1] === "context"
    || a[1] === "run" && a[2] === "context"
    || ["message", "decision", "brief", "input"].includes(a[1]) && ["show", "list"].includes(a[2])), "task-facts-read");
}
// The current core triggers this manual on expansion, not every warm Turn or
// ordinary complete original read. These are recognized CLI paths only; this
// is not universal semantic applicability inference.
export function contextExpansionAction(bundles, events, scope) {
  return cliAction(bundles, events, scope, a =>
    a[0] === "task" && (
      a[1] === "context" && ["list", "inspect"].includes(a[2])
      || a[1] === "wake" && a[2] === "show"
      || a[1] === "run" && (a[2] === "show"
        || a[2] === "context" && (a[3] === "expand" || a.includes("--view") || a.includes("--cursor"))))
    || ["task", "inbox", "role", "session"].includes(a[0]) && a.includes("--cursor"),
  "context-expansion");
}
export function gradeInstructionObligations(bundles, files, scope, carrier) {
  const base = gradeLoads(bundles, files, scope);
  const file = carrier?.status === "observed"
    && files.find(f => f.path.endsWith(`/skills/${carrier.path}`) && f.sha256 === carrier.sha256);
  const reportingScope = scope.loadActions ? { ...scope,
    loadActions: { business: scope.loadActions.reporting, reporting: scope.loadActions.reporting } } : scope;
  // An inline carrier may also carry an earlier Task-fact obligation. Check
  // Reporting independently; that file-level action must not override it.
  const reportingFile = file && scope.loadActions ? { ...file, action: scope.loadActions.reporting } : file;
  const reporting = file ? gradeLoads(bundles, [reportingFile], reportingScope)
    : { status: "unknown", reason: "Missing/wrong reporting carrier; obligation not waived" };
  const checks = [base, reporting, ...(scope.taskContextObservation ? [scope.taskContextObservation] : [])];
  return { ...base, status: checks.some(g => g.status === "fail") ? "fail"
    : checks.every(g => g.status === "pass") ? "pass" : "unknown",
    reportingObligation: { ...reporting, carrier },
    ...(scope.taskContextObservation ? { taskContextObligation: scope.taskContextObservation } : {}),
    limit: `${base.limit} Reporting is checked at its action through the declared exact carrier, including inline Runtime.` };
}
