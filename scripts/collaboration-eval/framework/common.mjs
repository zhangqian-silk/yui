import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, isAbsolute, dirname } from "node:path";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2), { flag: "wx" });
export const now = () => new Date().toISOString();
// Lossless CLI value views, not human-text/body extraction. Native attribution
// must additionally bind the command, source and owner; judges still compare
// the actual original bytes and original action deadline.
export function cliOutputData(envelope, argv = []) {
  if (envelope?.data || envelope?.ok !== undefined) return envelope.ok === false ? undefined : envelope.data;
  if (envelope?.contentPage) return envelope;
  if (argv.includes("--json")) return undefined;
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
export function completeJsonLines(text) {
  const end = text.lastIndexOf("\n") + 1, suffix = text.slice(end);
  return { records: text.slice(0, end).split("\n").filter(Boolean).map(s => JSON.parse(s)),
    tail: suffix ? { bytes: Buffer.byteLength(suffix), sha256: hash(suffix) } : undefined };
}
export const chainStages = scenario => scenario === "normal-warm" ? 4 : 3;
export const isBusinessScenario = scenario => ["business-route", "business-conflict", "business-recovery"].includes(scenario);
export const routesStage = (scenario, stage) => scenario === "business-route" || stage === 2 || scenario === "normal-warm" && stage > 2;
export const executionLimits = mode => mode === "real"
  ? { stageWaitMs: 300000, idleWaitMs: 90000, cliBudgetMs: 1500000 }
  : { stageWaitMs: 45000, idleWaitMs: 45000, cliBudgetMs: 120000 };
export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
export const fixtureCliScript = (cli, node, bin) =>
  `#!/bin/sh\nexport PATH=${shellQuote(`${dirname(node)}:${bin}:/usr/bin:/bin`)}\nexec ${shellQuote(cli)} "$@"\n`;
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
export const lifecycleWorkingSet = inventory => [
  ["yui-runtime", "29", "35689259fc083b3c79f24a27385aef5722ea9ec433008b20aedf810d5a24a2e5"],
  ["yui-leader", "13", "01b26d6524e1915e630e1ee9d59a65651ed66c376edabd125398588a4adbaf21"],
  ["yui-operator", "15", "accb629840f94acafa9f8a99404c647d7bba4c6af80c1cb292cc76839bf4f466"],
].every(([role, version, digest]) => inventory[`${role}/VERSION`]?.sha256 === hash(version + "\n")
  && inventory[`${role}/SKILL.md`]?.sha256 === digest);
export const planningReferences = (role, inventory = {}, contextOrdering = false, { inspectExisting = false } = {}) => [
  ...(role === "leader"
    ? ["yui-leader/references/planning.md", "yui-runtime/references/dispatched-run.md"] : []),
  // A new Turn is not itself intent conflict, stage handoff or maintenance.
  // Explicit Session-recovery handoff is supplied by its caller, not inferred
  // from stage number. Plain normal planning/routing injects none of these.
  ...(contextOrdering ? ["yui-runtime/references/context-ordering.md"] : []),
  // Runtime21 extracts existing obligations into route/stage references.
  // Leader authors a managed report; Operator creates a durable routed Message.
  // Those actual actions, not turn number, make reporting applicable here.
  ...(lifecycleWorkingSet(inventory)
    ? role === "operator" ? ["yui-operator/references/submission.md", "yui-operator/references/body-transport.md"]
      : inspectExisting ? [] : ["yui-leader/references/task-progress.md"]
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
    "collector-fail", "unknown-lifecycle", "partial-setup", "business-route", "business-conflict", "business-recovery"];
  if (options.scenarios.some(s => !scenarios.includes(s)) || new Set(options.scenarios).size !== options.scenarios.length)
    throw Error("Unknown/duplicate scenario");
  if (options.mode === "real" && (options.scenarios.some(s => !["normal", "normal-warm", "session-recovery"].includes(s) && !isBusinessScenario(s)) || !options["provider-bin"] || !options.authorization))
    throw Error("Real requires explicit provider-bin and authorization reference; fake injections forbidden");
  if (options.mode === "real" && !isAbsolute(options["provider-bin"])) throw Error("Real provider-bin must be absolute");
  return options;
}
