import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, isAbsolute, dirname } from "node:path";
import { hash, now } from "../core/io.mjs";
export { hash, save, now, completeJsonLines } from "../core/io.mjs";
// Exact frozen-Run batch grammar only. This derives observation identity,
// never executes a command or grants a read from a pointer.
export function runBatchRead(argv = []) {
  const a = argv.filter(x => x !== "--json");
  if (a.slice(0, 4).join(" ") !== "task run context expand" || !a.includes("--context-ref")) return null;
  const target = /^([^/]+)\/([^/]+)$/u.exec(a[4] ?? "");
  if (!target) return null;
  const selectors = [], seen = new Set(), options = new Set();
  for (let i = 5; i < a.length; i += 2) {
    const value = a[i + 1];
    if (typeof value !== "string") return null;
    if (a[i] === "--context-ref") {
      const m = /^([^/]+)\/(.+)@([0-9a-f]{64})$/u.exec(value);
      const short = m ? null : /^([^/]+)\/(.+)$/u.exec(value);
      if (!m && !short) return null;
      const ref = m ? { store: m[1], refId: m[2], digest: m[3] } : { store: short[1], refId: short[2] };
      const key = JSON.stringify([ref.store, ref.refId]);
      if (seen.has(key)) return null;
      seen.add(key); selectors.push(ref);
    } else {
      if (!["--mode", "--cursor"].includes(a[i]) || options.has(a[i])
        || a[i] === "--mode" && value !== "full") return null;
      options.add(a[i]);
    }
  }
  if (!selectors.length || selectors.length > 8) return null;
  return { taskId: target[1], runId: target[2], selectors,
    source: `run:${a[4]}/context-batch:${hash(JSON.stringify(selectors))}` };
}
export function matchesRunBatch(value, selection) {
  return Boolean(selection && value?.taskId === selection.taskId && value.runId === selection.runId
    && Object.keys(value).sort().join(",") === "items,runId,taskId"
    && Array.isArray(value.items) && value.items.length === selection.selectors.length
    && value.items.every((item, i) => {
      const wanted = selection.selectors[i], ref = item?.ref;
      return ref?.store === wanted.store && ref.refId === wanted.refId && item.value !== undefined
        && (wanted.digest === undefined || ref.digest === wanted.digest)
        && ref.digest === hash(JSON.stringify(item.value))
        && item.digest === hash(JSON.stringify({ ref, value: item.value }));
    }));
}
// Current Task batches pin every mutable original by digest; unlike Run batches
// they have no entry hash and are not a cross-record frozen snapshot.
export function taskBatchRead(argv = []) {
  const a = argv.filter(x => x !== "--json");
  if (a.slice(0, 3).join(" ") !== "task context inspect"
    || !a.slice(4).some(x => x === "--context-ref" || x === "--refs")
    || !a[3] || a[3].includes("/")) return null;
  let refs = [], jsonForm = false, cursor = false;
  for (let i = 4; i < a.length; i += 2) {
    const v = a[i + 1];
    if (typeof v !== "string") return null;
    if (a[i] === "--context-ref") {
      const m = /^([^/]+)\/(.+)@([0-9a-f]{64})$/u.exec(v);
      if (jsonForm || !m) return null;
      refs.push({ store: m[1], refId: m[2], digest: m[3] });
    } else if (a[i] === "--refs") {
      if (refs.length || jsonForm) return null;
      try { refs = JSON.parse(v); } catch { return null; }
      if (!Array.isArray(refs)) return null;
      jsonForm = true;
    } else if (a[i] === "--cursor" && !cursor) cursor = true;
    else return null;
  }
  if (!refs.length || refs.length > 8 || refs.some(r => !r || Array.isArray(r)
    || Object.keys(r).some(k => !["store", "refId", "digest", "revision"].includes(k))
    || typeof r.store !== "string" || !r.store || typeof r.refId !== "string" || !r.refId
    || !/^[a-f0-9]{64}$/.test(r.digest ?? "")
    || r.revision !== undefined && typeof r.revision !== "string")) return null;
  const selectors = refs.map(({ store, refId, digest }) => ({ store, refId, digest }));
  if (new Set(selectors.map(r => JSON.stringify([r.store, r.refId]))).size !== selectors.length) return null;
  return { taskId: a[3], selectors, source: `task:${a[3]}/context-batch:${hash(JSON.stringify(selectors))}` };
}
export function matchesTaskBatch(value, selection) {
  return Boolean(selection && value?.taskId === selection.taskId
    && Object.keys(value).sort().join(",") === "items,taskId"
    && Array.isArray(value.items) && value.items.length === selection.selectors.length
    && value.items.every((item, i) => {
      const wanted = selection.selectors[i], ref = item?.ref;
      return ref?.store === wanted.store && ref.refId === wanted.refId && item.value !== undefined
        && ref.digest === wanted.digest && ref.digest === hash(JSON.stringify(item.value));
    }));
}
// Lossless CLI value views, not human-text/body extraction. Native attribution
// must additionally bind the command, source and owner; judges still compare
// the actual original bytes and original action deadline.
export function cliOutputData(envelope, argv = []) {
  if (envelope?.data || envelope?.ok !== undefined) return envelope.ok === false ? undefined : envelope.data;
  if (envelope?.contentPage) return envelope;
  if (argv.includes("--json")) return undefined;
  if (matchesRunBatch(envelope, runBatchRead(argv))) return envelope;
  if (matchesTaskBatch(envelope, taskBatchRead(argv))) return envelope;
  const a = argv;
  // The observed plain --view full planning pack, not arbitrary JSON with an
  // identity field. Preserve the complete document; source/Role binding below
  // the adapter and all action deadlines remain independently required.
  if (a.length === 6 && a.slice(0, 3).join(" ") === "task run context"
    && a[4] === "--view" && a[5] === "full"
    && Object.keys(envelope ?? {}).sort().join(",") ===
      "authority,completion,deltaRefs,digest,identity,input,inventory,liveTaskState,pointers,schemaVersion,skillCheckCommand,skillPackages,snapshot"
    && envelope.schemaVersion === 1 && /^[a-f0-9]{64}$/.test(envelope.digest ?? "")
    && envelope.identity?.taskId === a[3]?.split("/")[0] && envelope.identity.runId === a[3]?.split("/")[1]
    && envelope.identity.purpose === "planning" && envelope.identity.adapterId === "codex"
    && envelope.snapshot?.taskId === envelope.identity.taskId
    && /^[a-f0-9]{64}$/.test(envelope.snapshot?.digest ?? "")
    && envelope.input?.contextSnapshotRef?.id === envelope.snapshot.id
    && envelope.input.contextSnapshotRef.digest === envelope.snapshot.digest
    && envelope.completion?.exactRunRef === a[3] && Array.isArray(envelope.completion.allowedActions)
    && Array.isArray(envelope.pointers) && Array.isArray(envelope.deltaRefs) && Array.isArray(envelope.skillPackages)
    && envelope.inventory?.complete === true && envelope.inventory.refs === envelope.pointers.length
    && Number.isSafeInteger(envelope.inventory.frozenBytes) && envelope.inventory.frozenBytes >= 0) return envelope;
  if (a[0] === "task" && a[1] === "run" && a[2] === "context" && a[3] === "expand"
    && Object.keys(envelope ?? {}).sort().join(",") === "digest,ref,value"
    && /^[a-f0-9]{64}$/.test(envelope.digest ?? "") && envelope.ref && envelope.value
    && envelope.ref.refId === a[5] && envelope.ref.store === a[a.indexOf("--store") + 1]
    && envelope.value.id === a[5] && envelope.value.taskId === a[4]?.split("/")[0]) return envelope;
  if (a.length === 2 && a[0] === "session" && a[1] === "skills"
    && Object.keys(envelope ?? {}).sort().join(",") === "historicalPackagesAreAuditOnly,roleProfileRef,rule,skills"
    && Array.isArray(envelope.skills) && envelope.skills.length
    && envelope.skills.every(s => ["id", "path", "version", "versionPath"].every(k => typeof s[k] === "string"))
    && typeof envelope.roleProfileRef?.path === "string"
    && /^[a-f0-9]{64}$/.test(envelope.roleProfileRef?.digest ?? "")
    && typeof envelope.rule === "string" && envelope.historicalPackagesAreAuditOnly === true) return envelope;
  return undefined;
}
export const chainStages = scenario => ["normal-warm", "business-warm"].includes(scenario) ? 4 : 3;
export const isBusinessScenario = scenario => ["business-route", "business-conflict", "business-recovery", "business-warm"].includes(scenario);
export const routesStage = (scenario, stage) => ["business-route", "business-warm"].includes(scenario) || stage === 2 || scenario === "normal-warm" && stage > 2;
export const executionLimits = mode => mode === "real"
  ? { stageWaitMs: 300000, idleWaitMs: 90000, cliBudgetMs: 1500000 }
  : { stageWaitMs: 45000, idleWaitMs: 45000, cliBudgetMs: 120000 };
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const fixtureCliScript = (cli, node, bin, receipt) =>
  `#!/bin/sh\nexport PATH=${shellQuote(`${dirname(node)}:${bin}:/usr/bin:/bin`)}\nexec ${
    receipt ? `${shellQuote(node)} ${shellQuote(receipt.module)} ${shellQuote(JSON.stringify({
      cli, node, entry: join(bin, "yui"), audit: receipt.audit, product: receipt.product
    }))}` : shellQuote(cli)} "$@"\n`;
export const environmentInstructions = (cli, product, entryMode = "absolute") =>
  `Evaluation environment: ${entryMode === "owned-relative"
    ? `use the short owned CLI entry ./bin/yui only when the command's actual cwd is ${JSON.stringify(dirname(dirname(cli)))}; from its state/runtime/task-runtimes/planning/<task-id> cwd use ../../../../../bin/yui. After any other cwd change use the exact absolute entry ${JSON.stringify(cli)}. All these paths must resolve to that same owned entry`
    : `use the exact absolute CLI entry ${JSON.stringify(cli)}`} for EVERY Yui command, including any needed Skill metadata checks and context loading. On first entry or fresh-Session recovery, run that exact owned entry with --json version to observe the actual product version in this Thread. Never invoke bare yui or an installed/global CLI: login shells can reset PATH. Preserve the inherited YUI_HOME and managed identity. Current Skill paths must belong to the frozen product ${JSON.stringify(product)}; if they do not, stop and report the mismatch without loading global Skills or changing installation/account configuration. The normal account authentication entry is unchanged.`;
export const subjectInstructions = (instructions, cli, product, entryMode) =>
  `${instructions}\n${environmentInstructions(cli, product, entryMode)}`;
// Evaluator-only applicability for this fixed planning scenario, not guidance
// added to the subject. Conditional recovery/delivery references remain outside
// this normal chain and are never declared universally unnecessary.
// Exact reviewed 9236798e Skill trees. Do not infer a changed action contract
// from a VERSION number, a missing file, or a future unreviewed body.
// Reviewed action contract (4b63ab62 and its optional batch-read documentation),
// shared by reference selection
// and semantic carriers. Bind the complete three-Skill tree, including manuals
// and VERSIONs; a same-version edit must not silently inherit this judgment.
export function currentPlanningContract(inventory) {
  const paths = Object.keys(inventory).filter(p => /^yui-(runtime|leader|operator)\//.test(p)).sort();
  const digest = hash(JSON.stringify(paths.map(p => [p, inventory[p].sha256])));
  // Leader15 moves the unchanged Decision rule into its required core. Only
  // Brief/Milestone/Knowledge updates need task-progress; this planning fixture
  // forbids those writes. Bind the full reviewed tree, never VERSION alone.
  // Runtime40 documents bounded full originals in focused wake output. It
  // changes the read carrier, not required sources/actions or Decision duties.
  // Operator17 distinguishes routing originals from the receiving Leader's
  // business sources. The Operator still reads its exact request and routing
  // authority; the Leader's complete source/Decision obligations are unchanged.
  // Operator18 permits a saved-body checksum for transport comparison only;
  // it grants no source-reading, load or handling credit in this contract.
  // Operator19 keeps the same duties and captures the first receipt while
  // retaining exact local paths; shell lifecycle advice grants no read credit.
  // Operator20 packages the same local transport comparison as a read-only
  // helper. Executing it does not establish original reads, loading or ACK.
  // Runtime41 reuses that focused original in own inbox show. The verified
  // body/ref must still be observed; the carrier grants no loading/ACK credit.
  // Runtime42 documents existing focused/recursive help in the same optional
  // discovery manual. Required actions, source reads and load evidence do not change.
  // Operator21 captures the first source response for later safe transport.
  // Local files grant no original-reading, freshness, authority or ACK credit.
  // Operator22 restores one-shell transport after reading/claim, reusing an
  // existing matching file or quietly capturing it. The same duties remain.
  // Runtime43 permits exact current Global originals in context. This changes
  // only their carrier; complete output, native ownership and handling still apply.
  // Operator23 aligns its repeated inbox description with Runtime's optional
  // original carrier; no source, claim, disposition or ACK obligation changes.
  if (["e15d1fc9fa0a194e4235b04c6202256c8dd021804edd39c4c58cb1db6bb26d1f",
    "ec5949fff3811e0f86b071f98b4ba8fcb5241d4ea4aa331868fa46019d4109a6",
    "e38ecc88c13abeb4d8ac3e3453be4f08026e81ffd7401f8ab8ae7c6d86251004",
    "3fb416851f1dc11d2659d02d0efd86c297d62ecdf1a174779c3d51e2b008cca4",
    "ae3fda99f9f07154e484bc93d2cbde354a55b85736e92703eaab9c3ea7c1cdb5",
    "8abd2726d9d4b373a03b4ba5c029975c20bafd1d45c2219f21252f4ac75772cc",
    "554ebdd5035f4f0a58a952c5f936ff1dda2fcb8fe33aebf3e11bbefb299ff96d",
    "5c428f4e51c2e3fa749c6ca2c058b2134a7bf4ac2a44936ccbc8cd4754da20cd",
    "c8af32fa0311ee18ee285ffcb23097d5356b60770b118b7229dada1bed915efa",
    "4fb4ed3001f2f4e457796f7f5a7c714856a47c577d7029d6d0f706249462d546",
    "89e2b25afabb22ace01d04a328cd4c98555c9a968ca92c7c71f2f6a37c119094",
    "d71546814796abdb5252a9e8281142f7ab93480ce856f035ffc7a8039df858af"].includes(digest))
    return { id: "action-working-set-2026-11-01", digest, decisionInCore: true };
  return [
    "58a6c7257a537406146f71c91a1a1c4e83ea6288226cad353512c587229d4c78",
    "4dd7de249ca1facfc6eb34087ed5013f24451c2705dd454ddd514e4998a6b07f",
    "2246b1b5af1d7559f57bf74676e74e6bdc527c706bff0c8f2ade1eeb332604fc",
    "8a5feb5d468dc177ad739884d1fc9f218be3ae7115017502f6d5b928a06d98da",
    // Runtime35 clarifies alternative complete-result reads and batch forms;
    // the applicable actions and required bodies are unchanged.
    "24e10caac1c4c18e5707fe31989e681183e7e536bc4bff17cf65aa1986ff8ab8",
    // Runtime36 adds an optional same-Snapshot batch expansion spelling;
    // source, action, original and full-reading obligations are unchanged.
    "897eb6fe639526072d145f4d79363bb26134a61591873f04a2c60e737bfa0601",
    // Runtime37 makes the redundant caller digest optional only for frozen Runs;
    // the same complete originals, authority and snapshot obligations remain.
    "1812924e53908616c2e41daaadf3353b28dc45834db67544a0cfe9e19b417458",
    // Runtime38 names the complete original-result view as an alternative;
    // required originals, action prerequisites and full-page obligations remain.
    "b9fbfdd9b3701201ab63d7607afa97a11580e2dae80a46e0eb6b331ff0665bcb",
    // Runtime39 clarifies discovery views as alternatives. The reviewed delta
    // changes only dispatched-run navigation plus VERSION, not any required
    // original, action prerequisite, reporting or full-byte load obligation.
    "b2c423dca86505d5b239130a4ec78f4d5783d5602dfb59b7f6211ce1ae964843"
  ].includes(digest)
    ? { id: "action-working-set-2026-11-01", digest } : undefined;
}
export const lifecycleWorkingSet = inventory => !!currentPlanningContract(inventory) || [
  ["yui-runtime", "29", "35689259fc083b3c79f24a27385aef5722ea9ec433008b20aedf810d5a24a2e5"],
  ["yui-leader", "13", "01b26d6524e1915e630e1ee9d59a65651ed66c376edabd125398588a4adbaf21"],
  ["yui-operator", "15", "accb629840f94acafa9f8a99404c647d7bba4c6af80c1cb292cc76839bf4f466"],
].every(([role, version, digest]) => inventory[`${role}/VERSION`]?.sha256 === hash(version + "\n")
  && inventory[`${role}/SKILL.md`]?.sha256 === digest);
export const planningReferences = (role, inventory = {}, contextOrdering = false,
  { inspectExisting = false, businessStage } = {}) => [
  ...(role === "leader"
    ? ["yui-leader/references/planning.md", "yui-runtime/references/dispatched-run.md"] : []),
  // A new Turn is not itself intent conflict, stage handoff or maintenance.
  // Explicit Session-recovery handoff is supplied by its caller, not inferred
  // from stage number. Plain normal planning/routing injects none of these.
  // These frozen business scenarios introduce a changed requirement/fact only
  // after stage 1. Operator forwards it; Leader reconciles it. This is not a
  // rule that any second model Turn needs temporal-context instructions.
  ...(contextOrdering || role === "leader" && businessStage > 1
    ? ["yui-runtime/references/context-ordering.md"] : []),
  // Runtime21 extracts existing obligations into route/stage references.
  // Leader authors a managed report; Operator creates a durable routed Message.
  // Those actual actions, not turn number, make reporting applicable here.
  ...(lifecycleWorkingSet(inventory)
    ? role === "operator" ? ["yui-operator/references/submission.md", "yui-operator/references/body-transport.md"]
      : inspectExisting || currentPlanningContract(inventory)?.decisionInCore ? []
        : ["yui-leader/references/task-progress.md"]
    : [role === "leader" ? "task-context" : "global-context", "reporting"]
      .map(name => `yui-runtime/references/${name}.md`).filter(path => path in inventory)),
];
export const isSessionRecovery = scenario => ["session-recovery", "session-recovery-stop-unknown", "business-recovery"].includes(scenario);
// Subject-visible recovery procedure, not an answer or a scripted Provider
// fault. Only this scenario changes stage 2; normal's input identity stays put.
export const recoveryContract = "This is the scheduled Session-replacement checkpoint. In the predecessor Session, read/claim the exact input, inspect effects, record its one Decision if absent, then end this Turn WITHOUT ACKing that input. Do not replace yourself or start further work. After the evaluator legally stops and replaces that Session, the fresh successor must reload current full Skills/profile and recovery references, inspect the retained exact original/claim and existing Decision through current context, then ACK the retained original with its concrete disposition. Never claim it again, rewrite or repeat the existing Decision, replay input, or borrow predecessor read/load evidence. This is Session replacement, not native compaction.";
export function redactTransport(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactTransport);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
    /^(access_?token|refresh_?token|id_?token|secret|password|api_?key|authorization|cookie)$/i.test(key) ? "[redacted]"
      : /^(email|.*accountId)$/i.test(key) ? child ? `sha256:${hash(String(child))}` : child
        : redactTransport(child)]));
}
export class Failure extends Error {
  constructor(kind, message, scope = "condition") { super(message); this.kind = kind; this.scope = scope; }
}
export function groupStopFor(result) {
  if (result.cleanup?.status !== "released")
    return { kind: "unknown-lifecycle", scope: "group", at: now(), root: result.cleanup?.root,
      cause: result.stop ?? { kind: result.status }, reason: "Owned cleanup not confirmed; stop independent launches/peers" };
  return result.stop?.scope === "group" ? result.stop : undefined;
}
export class Client {
  constructor(cli, environment, trace = [], deadline = Date.now() + 120000) {
    Object.assign(this, { cli, environment, trace, deadline });
  }
  call(args, phase = "read", { json = true, input, allowFailure = false } = {}) {
    const started = Date.now();
    const argv = [...(json ? ["--json"] : []), ...args];
    if (started >= this.deadline) {
      this.trace.push({ startedAt: new Date(started).toISOString(), at: now(), phase,
        args: argv, disposition: "not-started", reason: "phase-deadline-exhausted", elapsedMs: 0 });
      throw new Failure("infrastructure-failed", `CLI phase deadline exhausted before invocation: ${args.join(" ")}`);
    }
    const observationId = this.onStart?.(argv);
    const r = spawnSync(this.cli, argv, { env: this.environment, input, encoding: "utf8",
      timeout: Math.max(1, Math.min(20000, this.deadline - started)), maxBuffer: 16 * 1024 * 1024 });
    const entry = { startedAt: new Date(started).toISOString(), at: now(), phase, args: argv, code: r.status, signal: r.signal,
      stdout: r.stdout ?? "", stderr: r.stderr ?? "", elapsedMs: Date.now() - started,
      ...(observationId ? { observationId } : {}) };
    this.trace.push(entry);
    this.onCall?.(entry);
    if (r.error || r.status !== 0) {
      if (allowFailure) return { rejected: true, entry };
      throw new Failure("infrastructure-failed", `CLI ${args.join(" ")}: ${r.error?.message ?? entry.stderr ?? entry.stdout}`);
    }
    if (!json) return entry.stdout;
    const envelope = JSON.parse(entry.stdout);
    if (envelope.ok === false) throw new Failure("infrastructure-failed", JSON.stringify(envelope));
    return envelope.data ?? envelope;
  }
  detail(args) {
    let value = this.call(args), text = "", identity;
    while (value.contentPage) {
      const p = value.contentPage;
      identity ??= [p.source, p.digest];
      if (p.source !== identity[0] || p.digest !== identity[1] || p.offset !== text.length
        || p.encoding !== "json" || !p.text) throw new Failure("framework-invalid", "Incomplete/changed original");
      text += p.text;
      if (p.complete) {
        if (text.length !== p.totalCharacters || hash(text) !== p.digest)
          throw new Failure("framework-invalid", "Original digest/length mismatch");
        return JSON.parse(text);
      }
      if (!p.nextCursor) throw new Failure("framework-invalid", "Missing original continuation");
      value = this.call([...args, "--cursor", p.nextCursor]);
    }
    return value;
  }
}
export function pidIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(")").slice(1).join(")").trim().split(" ");
      return { pid, start: f[19], state: f[0] };
    }
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim();
    return start ? { pid, start } : null;
  } catch { return null; }
}
export const alive = p => { const v = pidIdentity(p.pid); return v?.start === p.start && v.state !== "Z"; };
export function ownedProcesses(root, tmux) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }).split("\n")
    .flatMap(s => { const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(s); return m ? [{ pid: +m[1], ppid: +m[2], command: m[3] }] : []; });
  const ids = new Set(rows.filter(r => r.command.includes(root) || r.command.startsWith(`tmux -L ${tmux} `)).map(r => r.pid));
  for (let n = 0; n < rows.length; n++) {
    const size = ids.size; for (const r of rows) if (ids.has(r.ppid)) ids.add(r.pid);
    if (size === ids.size) break;
  }
  return rows.filter(r => ids.has(r.pid) && r.pid !== process.pid).map(r => ({ ...r, ...pidIdentity(r.pid) })).filter(r => r.start);
}
export function treeHashes(root, prefix = "") {
  return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(e => {
    const path = join(prefix, e.name);
    return e.isDirectory() ? Object.entries(treeHashes(root, path))
      : e.isFile() ? [[path, { bytes: statSync(join(root, path)).size, sha256: hash(readFileSync(join(root, path))) }]] : [];
  }));
}
export function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--") || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("Expected --name value");
    const key = args[i].slice(2);
    if (key in options) throw Error(`Duplicate option ${key}`);
    options[key] = args[++i];
  }
  const allowed = ["mode", "product", "out", "scenarios", "concurrency", "provider-bin", "authorization", "preflight", "permission-mode", "cli-entry-mode", "source-contract", "original-tool"];
  if (Object.keys(options).some(k => !allowed.includes(k))) throw Error("Unknown option");
  if (!["fake", "offline", "real"].includes(options.mode) || !options.product || !options.out)
    throw Error("Required: --mode fake|offline|real --product <checkout> --out <NEW directory>");
  options.mode = options.mode === "offline" ? "fake" : options.mode;
  options["permission-mode"] ??= "workspace-write";
  options["cli-entry-mode"] ??= "absolute";
  options["source-contract"] ??= "original";
  options["original-tool"] ??= "absent";
  if (!["absent", "available"].includes(options["original-tool"])) throw Error("Unknown original-tool");
  if (!["original", "conditional-reuse"].includes(options["source-contract"])) throw Error("Unknown source-contract");
  if (!["absolute", "owned-relative"].includes(options["cli-entry-mode"])) throw Error("Unknown cli-entry-mode");
  if (!["workspace-write", "session-only"].includes(options["permission-mode"])) throw Error("Unknown permission-mode");
  if (options.preflight !== undefined && !["true", "false"].includes(options.preflight))
    throw Error("preflight must be true|false");
  options.concurrency = Number(options.concurrency ?? 2);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4)
    throw Error("Concurrency must be 1..4");
  options.scenarios = (options.scenarios ?? "normal").split(",");
  const scenarios = ["normal", "normal-warm", "native-normal", "missing-ack", "cross-task", "unauthorized-write", "partial-load",
    "quality-fail", "recovery", "session-recovery", "session-recovery-stop-unknown",
    "collector-fail", "unknown-lifecycle", "partial-setup", "business-route", "business-conflict", "business-recovery", "business-warm"];
  if (options.scenarios.some(s => !scenarios.includes(s)) || new Set(options.scenarios).size !== options.scenarios.length)
    throw Error("Unknown/duplicate scenario");
  if (options.mode === "real" && (options.scenarios.some(s => !["normal", "normal-warm", "session-recovery"].includes(s) && !isBusinessScenario(s)) || !options["provider-bin"] || !options.authorization))
    throw Error("Real requires explicit provider-bin and authorization reference; fake injections forbidden");
  if (options.mode === "real" && !isAbsolute(options["provider-bin"])) throw Error("Real provider-bin must be absolute");
  return options;
}
