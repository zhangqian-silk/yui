// Evidence adapter, not a command executor. Only native completed tool items
// with trusted Host binding and exact output bytes can prove a read.
import { basename, isAbsolute, join, resolve } from "node:path";
import { hash, cliOutputData } from "./common.mjs";
export { completeJsonLines } from "./common.mjs";
import { isDeepStrictEqual } from "node:util";
import { attributeNativeEvents } from "./native-ownership.mjs";
import { originalPageEvidence } from "./original-evidence.mjs";
export function words(text) {
  if (typeof text !== "string") return null;
  const out = []; let word = "", quote, started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = undefined; else word += c; continue; }
    if (c === quote) { quote = undefined; continue; }
    if (c === "\\" && quote !== "'") { if (++i === text.length) return null; word += text[i]; started = true; continue; }
    if (c === "'" && !quote || c === '"' && !quote) { quote = c; started = true; continue; }
    if ("$`".includes(c) || !quote && ";&|<>()\n".includes(c)) return null;
    if (!quote && /\s/.test(c)) { if (started) out.push(word); word = ""; started = false; }
    else { word += c; started = true; }
  }
  if (quote) return null;
  if (started) out.push(word);
  return out;
}
function shellWords(command) {
  let argv = words(command);
  if (!argv) return null;
  if (["zsh", "bash", "sh"].includes(basename(argv[0] ?? "")) && ["-lc", "-c"].includes(argv[1]) && argv.length === 3)
    argv = words(argv[2]);
  return argv;
}
// A deliberately bounded, non-executing grammar. Actions are attribution hints,
// not authority: native actions sometimes put a trailing separator in the path.
function staticCommands(command, literal = false) {
  if (typeof command !== "string") return null;
  const outer = words(command);
  if (outer && ["zsh", "bash", "sh"].includes(basename(outer[0] ?? ""))
    && ["-c", "-lc"].includes(outer[1]) && outer.length === 3) command = outer[2];
  const parts = []; parts.separators = []; let quote, start = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "\\") return null;
    if (quote) { if (c === quote) quote = undefined; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if ("$`|<>()\n#".includes(c)) return null;
    if (c === ";" || c === "&") {
      if (c === ";" && !literal) return null;
      if (c === "&" && command[i + 1] !== "&") return null;
      const part = command.slice(start, i).trim();
      if (!part) return null;
      parts.push(part);
      parts.separators.push(c === ";" ? ";" : "&&");
      if (c === "&") i++;
      start = i + 1;
    }
  }
  if (quote) return null;
  if (command.slice(start).trim()) parts.push(command.slice(start).trim());
  else if (!literal || !command.trimEnd().endsWith(";")) return null;
  return parts;
}
function literalReads(command, commandCwd, files) {
  const parts = staticCommands(command, true);
  if (!parts) return null;
  // A Thread's startup cwd is not a command's cwd: native exec can override it.
  const cwd = typeof commandCwd === "string" && isAbsolute(commandCwd) ? commandCwd : undefined;
  const reads = [];
  for (const part of parts) {
    const argv = words(part), cmd = argv?.[0];
    let paths, range;
    if (["cat", "/bin/cat", "/usr/bin/cat"].includes(cmd) && argv.length > 1) paths = argv.slice(1);
    else if (["sed", "/bin/sed", "/usr/bin/sed"].includes(cmd) && argv.length === 4
      && argv[1] === "-n" && /^([1-9]\d*),([1-9]\d*)p$/.test(argv[2])) {
      range = argv[2].slice(0, -1).split(",").map(Number);
      if (range.some(n => !Number.isSafeInteger(n)) || range[1] < range[0]) return null;
      paths = [argv[3]];
    } else if (["jq", "/bin/jq", "/usr/bin/jq"].includes(cmd)
      && argv.length === 3 && argv[1] === ".") paths = [argv[2]];
    else return null;
    for (let path of paths) {
      if (!isAbsolute(path)) { if (!cwd) return null; path = resolve(cwd, path); }
      const exact = files.find(f => f.path === path);
      const prefix = !range && cmd.endsWith("cat") && path.endsWith("/*.md") ? path.slice(0, -4) : undefined;
      const matches = exact ? [exact] : prefix && !/[*?[\]]/.test(prefix)
        ? files.filter(f => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes("/")
          && f.path.endsWith(".md")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) : [];
      if (!matches.length) return null;
      for (const file of matches) {
        if (typeof file.body !== "string") return null; // Inventory names are not body bytes.
        if (hash(file.body) !== file.sha256) return null;
        if (cmd.endsWith("jq")) {
          try {
            // Only byte-identical identity formatting is supported. Projections
            // or alternative formatting are not reconstructed from the command.
            if (JSON.stringify(JSON.parse(file.body), null, 2) + "\n" !== file.body) return null;
          } catch { return null; }
        }
        const lines = file.body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const start = range ? Buffer.byteLength(lines.slice(0, range[0] - 1).join("")) : 0;
        const end = range ? Buffer.byteLength(lines.slice(0, range[1]).join("")) : Buffer.byteLength(file.body);
        reads.push({ file, start, end, body: Buffer.from(file.body).subarray(start, end).toString() });
      }
    }
  }
  return reads;
}
export function commandArguments(command, binding, commandCwd) {
  const argv = shellWords(command);
  if (!argv) return null;
  return boundArguments(argv, binding, commandCwd);
}
function boundArguments(argv, binding, commandCwd) {
  if (argv[0]?.startsWith("YUI_HOME=")) {
    if (argv.shift() !== `YUI_HOME=${binding.home}`) return null;
  }
  const relativeEntry = typeof commandCwd === "string" && isAbsolute(commandCwd)
    && argv[0]?.includes("/") && !isAbsolute(argv[0]) && resolve(commandCwd, argv[0]) === binding.cli;
  if (argv[0] === "yui" || argv[0] === binding.cli || relativeEntry) argv.shift();
  else if (["node", binding.node].includes(argv[0]) && argv[1] === join(binding.product ?? "", "dist/cli.js")) argv.splice(0, 2);
  else return null;
  return argv;
}
function commandSequence(command, binding, cwd, exactEntry = false) {
  // Preserve the existing single-command grammar, including shell-quoted
  // literal JSON payloads. Compound parsing must not narrow that normal path.
  const single = !exactEntry && commandArguments(command, binding, cwd);
  if (single) return [single];
  const parts = staticCommands(command);
  if (!parts) return null;
  if (exactEntry && (typeof cwd !== "string" || !isAbsolute(cwd) || parts.some(part => {
    const argv = words(part);
    if (argv?.[0]?.startsWith("YUI_HOME=")) argv.shift();
    return !argv || argv[0] === "yui" || argv[0] === "node";
  }))) return null;
  const sequence = parts.map(part => commandArguments(part, binding, cwd));
  return sequence.every(Boolean) ? sequence : null;
}
const readPrefixes = [["task", "context"], ["task", "run", "context"], ["task", "wake", "show"],
  ["inbox", "show"], ["inbox", "list"], ["role", "message", "show"], ["task", "message", "show"],
  ["task", "decision", "show"], ["task", "decision", "list"], ["session", "skills"], ["session", "context"], ["version"]];
const readArgs = args => args && readPrefixes.some(p => p.every((v, i) => args.filter(x => x !== "--json")[i] === v));
function cliDocumentMatches(envelope, argv, binding, threadId, turnId) {
  const args = argv.filter(a => a !== "--json"), data = envelope?.data;
  if (envelope?.ok !== true || !data || typeof data !== "object") return false;
  if (args[0] === "version") return args.length === 1 && typeof data.version === "string";
  if (args[0] === "session" && args[1] === "skills") return Array.isArray(data.skills) && data.skills.length > 0
    && data.skills.every(s => ["id", "path", "version", "versionPath"].every(k => typeof s[k] === "string"));
  if (args[0] === "session" && args[1] === "context") {
    const id = data.identity;
    return args[2] === binding.roleName && data.protocol === "yui-managed-context/v1"
      && id?.roleName === binding.roleName && id.taskId === binding.taskId
      && id.scope === (binding.taskId ? "task" : "global") && id.nativeSessionId === threadId
      && data.nativeTurn?.nativeTurnId === turnId && id.workspace === resolve(binding.home, "..")
      && Boolean(binding.manifestPath) && data.sessionManifestPath === binding.manifestPath;
  }
  const d = data.context ?? data.wake ?? data;
  const option = name => args[args.indexOf(name) + 1];
  const page = d.contentPage;
  let source, expectedId, observedId;
  if (args[0] === "task") {
    const contextAction = args[1] === "context" && ["inspect", "list"].includes(args[2]);
    const target = args[1] === "context" ? args[contextAction ? 3 : 2]
      : args[1] === "run" && args[2] === "context" && args[3] === "expand" ? args[4] : args[3];
    if (binding.taskId && target?.split("/")[0] !== binding.taskId) return false;
    const observedTask = d.taskId ?? d.identity?.taskId ?? d.value?.taskId;
    if (observedTask && observedTask !== target?.split("/")[0]) return false;
    if (args[1] === "run" && args[2] === "context") {
      if (args[3] === "expand") {
        expectedId = args[5]; observedId = d.ref?.refId;
        source = `run:${target}/${option("--store")}/${expectedId}`;
        if (!page && d.ref?.store !== option("--store")) return false;
      } else {
        if (option("--view") === "refs") return typeof d.source === "string"
          && d.source.startsWith(`run:${target}/refs/`)
          && /^[a-f0-9]{64}$/.test(d.source.slice(`run:${target}/refs/`.length))
          && /^[a-f0-9]{64}$/.test(d.digest ?? "") && Array.isArray(d.items)
          && Number.isSafeInteger(d.total) && d.total >= d.items.length
          && typeof d.complete === "boolean"
          && (d.complete ? d.nextCursor === null : typeof d.nextCursor === "string");
        return d.identity?.taskId === target?.split("/")[0] && d.identity.runId === target?.split("/")[1];
      }
    } else if (args[1] === "message" && args[2] === "show") {
      expectedId = target?.split("/")[1]; observedId = d.id;
      source = `task:${target?.split("/")[0]}/message/${expectedId}`;
    } else if (args[1] === "wake" && args[2] === "show") {
      if (!page && !data.wake) return false;
      expectedId = args[4]; observedId = d.id; source = `task:${target}/wake/${expectedId}`;
    } else if (args[1] === "decision" && args[2] === "show") {
      expectedId = args[4]; observedId = d.decision?.id;
    } else if (args[1] === "context" && args[2] === "inspect") {
      expectedId = option("--ref"); observedId = d.ref?.refId;
      source = `task:${target}/${option("--store")}/${expectedId}`;
    }
  }
  if (args[0] === "inbox" && args[1] === "list" && data.identity) {
    const id = data.identity;
    if (id.taskId !== binding.taskId || id.roleName !== binding.roleName || id.nativeSessionId !== threadId) return false;
  }
  // These used to accept every object without a requested ID, making a real
  // context -> wake -> inbox sequence spuriously ambiguous (and reorderable).
  if (args[0] === "inbox" && args[1] === "list")
    return Boolean(data.identity && Array.isArray(data.items)
      && typeof data.source === "string" && data.source.startsWith("inbox:"));
  if (args[0] === "task" && args[1] === "context"
    && !["inspect", "list", "delta"].includes(args[2]))
    return d.taskId === args[2] && typeof d.coreCursor === "string" && Array.isArray(d.collections);
  if (args[0] === "inbox" && args[1] === "show") { expectedId = args[2]; observedId = data.id; }
  if (args[0] === "role" && args[1] === "message" && args[2] === "show") {
    if (args[3] !== binding.roleName) return false;
    expectedId = args[4]; observedId = d.id;
  }
  if (page) return typeof source === "string" && page.source === source
    && page.encoding === "json" && typeof page.text === "string" && typeof page.digest === "string";
  return expectedId === undefined || expectedId === observedId;
}
// Parse one JSON object from the current offset, never search for one.
function jsonPrefix(output, offset) {
  const start = offset;
  while (offset < output.length && /\s/.test(output[offset])) offset++;
  if (output[offset] !== "{") return null;
  let depth = 0, quote = false, escaped = false;
  for (; offset < output.length; offset++) {
    const c = output[offset];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if ("{[".includes(c)) depth++;
    else if ("}]".includes(c) && --depth === 0) {
      offset++;
      while (offset < output.length && /\s/.test(output[offset])) offset++;
      const stdout = output.slice(start, offset);
      try { return { stdout, value: JSON.parse(stdout), end: offset }; } catch { return null; }
    }
  }
  return null;
}
// The non--json CLI page is exactly {contentPage}, not arbitrary human text.
// Its cursor carries the same source/digest/next UTF-16 offset as the page.
function plainPageEnvelope(value, args, binding, threadId, turnId) {
  if (args.includes("--json") || !value || Object.keys(value).length !== 1 || !value.contentPage) return null;
  const p = value.contentPage;
  if (p.encoding !== "json" || typeof p.text !== "string" || !/^[a-f0-9]{64}$/.test(p.digest ?? "")
    || !Number.isSafeInteger(p.offset) || p.offset < 0 || !Number.isSafeInteger(p.totalCharacters)
    || p.totalCharacters < p.offset + p.text.length || typeof p.complete !== "boolean") return null;
  if (p.totalBytes !== undefined && (!Number.isSafeInteger(p.totalBytes)
    || p.totalBytes < Buffer.byteLength(p.text)
    || p.offset === 0 && p.complete && p.totalBytes !== Buffer.byteLength(p.text))) return null;
  const cursor = text => {
    try { return JSON.parse(Buffer.from(text, "base64url").toString("utf8")); } catch { return null; }
  };
  const at = args.indexOf("--cursor"), requested = at >= 0 && cursor(args[at + 1]);
  if (at < 0 ? p.offset !== 0 : !requested || requested.source !== p.source
    || requested.digest !== p.digest || requested.offset !== p.offset) return null;
  if (p.complete) {
    if (p.nextCursor !== null || p.offset + p.text.length !== p.totalCharacters) return null;
    if (p.offset === 0 && hash(p.text) !== p.digest) return null;
  } else {
    const next = typeof p.nextCursor === "string" && cursor(p.nextCursor);
    if (!p.text.length || p.offset + p.text.length >= p.totalCharacters || !next
      || next.source !== p.source || next.digest !== p.digest || next.offset !== p.offset + p.text.length) return null;
  }
  const envelope = { ok: true, data: value };
  return cliDocumentMatches(envelope, args, binding, threadId, turnId) ? envelope : null;
}
function plainValueEnvelope(value, args, binding, threadId, turnId) {
  const data = cliOutputData(value, args);
  if (!data || data.contentPage) return plainPageEnvelope(value, args, binding, threadId, turnId);
  if (args.slice(0, 3).join(" ") === "task run context" && args[3] !== "expand"
    && (data.identity?.roleName !== binding.roleName || data.identity.taskId !== binding.taskId
      || data.identity.workspace !== join(binding.home, "runtime/task-runtimes/planning", binding.taskId ?? "")))
    return null;
  const envelope = { ok: true, data };
  return cliDocumentMatches(envelope, args, binding, threadId, turnId) ? envelope : null;
}
// Only the observed literal inventory of the two frozen applicable Skill roots.
// Order is not deterministic under rg traversal; exact unique membership is.
// Names consume stdout, but never establish any listed file's body was loaded.
function frozenInventory(command, stdout, binding, files) {
  const a = words(command);
  if (!["rg", "/usr/bin/rg", "/bin/rg"].includes(a?.[0]) || a.length !== 4 || a[1] !== "--files"
    || !isAbsolute(binding.product ?? "") || !["leader", "operator"].includes(binding.roleName)) return null;
  const roots = ["yui-runtime", `yui-${binding.roleName}`].map(s => join(binding.product, "skills", s));
  if (!isDeepStrictEqual(a.slice(2), roots) || !stdout.endsWith("\n")) return null;
  const expected = files.filter(f => roots.some(r => f.path.startsWith(r + "/")));
  if (!roots.every(r => expected.some(f => f.path === join(r, "SKILL.md")))
    || expected.some(f => f.path !== resolve(f.path) || /[\r\n]/.test(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256 ?? "")))
    return null;
  const paths = stdout.slice(0, -1).split("\n"), names = expected.map(f => f.path);
  if (new Set(paths).size !== paths.length || new Set(names).size !== names.length
    || !isDeepStrictEqual([...paths].sort(), [...names].sort())) return null;
  return { kind: "inventory", command, stdout, roots, paths, credit: "none" };
}
// Help is an uncredited stdout boundary, never an original or metadata call.
// Only literal bound CLI help argv and its complete ordinary text layout are
// accepted. Consume from the current offset, with no JSON/body substring search.
function helpPrefix(output, offset, args) {
  let path;
  if (args[0] === "help" && args.length > 1) path = args.slice(1);
  else if (args.at(-1) === "--help") path = args.slice(0, -1);
  if (!path?.length || !path.every(v => /^[a-z][a-z-]*$/.test(v))) return null;
  const header = `Yui ${path.join(" ")}\n\n`;
  if (!output.startsWith(header, offset)) return null;
  const rest = output.slice(offset + header.length);
  // Examples are the final section. No braces/JSON, control bytes or blank
  // arbitrary suffix is swallowed; the next atom must consume all remaining.
  const match = /^([^\n{}]+\n)+\nUsage:\n(?:  [^\n{}]+\n)+(?:\n(?:Commands|Options):\n(?:  [^\n{}]+\n)+)*\nExamples:\n(?:  [^\n{}]+\n)+/.exec(rest);
  if (!match) return null;
  const end = offset + header.length + match[0].length;
  return { kind: "help", args, stdout: output.slice(offset, end), end };
}
function failedReadSuffix(command, output, item, binding) {
  const argv = words(command);
  // Only the observed GNU sed missing-path diagnostic is supported. No search
  // for body substrings, no arbitrary stderr, no inferred per-atom exit status.
  if (item.exitCode === 2 && ["sed", "/bin/sed", "/usr/bin/sed"].includes(argv?.[0])
    && argv.length === 4 && argv[1] === "-n" && /^[1-9]\d*,[1-9]\d*p$/.test(argv[2])
    && !/[*?[\]\n]/.test(argv[3])
    && output === `sed: can't read ${argv[3]}: No such file or directory\n`)
    return { kind: "failed-suffix", command, stdout: output, reason: "exact sed missing-path diagnostic" };
  const args = commandSequence(command, binding, item.cwd, true)?.[0];
  if (!readArgs(args) || !args.includes("--json")) return null;
  let e; try { e = JSON.parse(output); } catch { return null; }
  const d = e?.details?.diagnostic;
  if (e.ok !== false || typeof e.code !== "string" || typeof e.message !== "string"
    || d?.home !== binding.home || d.cli !== join(binding.product ?? "", "dist/cli.js")
    || d.operation !== `yui ${args.slice(0, 3).join(" ")}`) return null;
  return { kind: "failed-suffix", command, stdout: output, reason: "exact bound CLI read error envelope; no data credit" };
}
function cliReadFailure(envelope, args, binding) {
  const d = envelope?.details?.diagnostic;
  return readArgs(args) && args.includes("--json") && envelope?.ok === false
    && typeof envelope.code === "string" && typeof envelope.message === "string"
    && d?.home === binding.home && d.cli === join(binding.product ?? "", "dist/cli.js")
    && d.operation === `yui ${args.slice(0, 3).join(" ")}`;
}
export function staticReadSequence(item, binding, files = [], threadId, turnId) {
  const unknown = reason => ({ status: "unsupported", reason });
  if (!["completed", "failed"].includes(item.status) || !Number.isInteger(item.exitCode)
    || item.status === "failed" && item.exitCode === 0 || typeof item.aggregatedOutput !== "string")
    return unknown("incomplete native command or unavailable exit/output");
  const parts = staticCommands(item.command, true);
  if (!parts?.length || parts.length > 16 || !isAbsolute(item.cwd ?? ""))
    return unknown("unsupported dynamic shell/separators/cwd or sequence exceeds 16 atoms");
  const segments = [], jsonValues = [], cliDocuments = [];
  let offset = 0;
  for (const [commandIndex, command] of parts.entries()) {
    const argv = words(command), exact = commandSequence(command, binding, item.cwd, true)?.[0];
    let segment;
    if (item.exitCode === 0 && commandIndex === parts.length - 1
      && segments.filter(s => s.kind !== "cwd").length === 1
      && segments.every(s => s.kind === "cwd" || s.kind === "file")
      && segments.find(s => s.kind === "file")?.reads.length === 1
      && segments.find(s => s.kind === "file")?.reads[0].file.kind === "profile") {
      const inventory = frozenInventory(command, item.aggregatedOutput.slice(offset), binding, files);
      if (inventory) { segments.push(inventory); offset = item.aggregatedOutput.length; continue; }
    }
    // A claim can sit between actual reads. Consume its exact bound receipt
    // only to partition stdout; never credit the claim as an action or read.
    // Keep this to one claim with an all-read suffix, not arbitrary mutations.
    if (item.exitCode === 0 && commandIndex < parts.length - 1
      && segments.every(s => s.kind === "cli") && exact?.length === 6
      && exact[0] === "inbox" && exact[1] === "claim" && exact[3] === "--request-id"
      && exact[5] === "--json" && parts.slice(commandIndex + 1).every(part =>
        readArgs(commandSequence(part, binding, item.cwd, true)?.[0]))) {
      const doc = jsonPrefix(item.aggregatedOutput, offset);
      const claim = doc?.value?.data?.inbox?.claim, actor = claim?.actor;
      if (doc?.value?.ok !== true || doc.value.data.id !== exact[2] || claim?.requestId !== exact[4]
        || actor?.roleName !== binding.roleName || actor.taskId !== binding.taskId
        || actor.nativeSessionId !== threadId || actor.scope !== (binding.taskId ? "task" : "global")
        || !Number.isFinite(Date.parse(claim.at))) return unknown("claim boundary lacks exact bound output identity");
      segments.push({ kind: "uncredited-suffix", command, stdout: doc.stdout,
        reason: "Bound claim output partition only; no write/read success or intra-command ordering credit" });
      offset = doc.end; continue;
    }
    // A single observed static claim tail may follow frozen file reads.
    // Authenticate only its output boundary, never turn it into an action,
    // successful write, authorization receipt, or per-atom timing evidence.
    if (commandIndex === parts.length - 1 && segments.length
      && segments.every(s => s.kind === "file") && exact?.length === 6
      && exact[0] === "inbox" && exact[1] === "claim" && exact[3] === "--request-id"
      && exact[5] === "--json") {
      const stdout = item.aggregatedOutput.slice(offset);
      let envelope; try { envelope = JSON.parse(stdout); } catch { return unknown("unpartitioned claim tail"); }
      const claim = envelope?.data?.inbox?.claim, actor = claim?.actor;
      const diagnostic = envelope?.details?.diagnostic;
      const receipt = envelope?.ok === true && envelope.data?.id === exact[2]
        && claim?.requestId === exact[4] && actor?.roleName === binding.roleName
        && actor.taskId === binding.taskId && actor.nativeSessionId === threadId
        && actor.scope === (binding.taskId ? "task" : "global")
        && Number.isFinite(Date.parse(claim.at));
      const failure = item.exitCode !== 0 && envelope?.ok === false
        && typeof envelope.code === "string" && typeof envelope.message === "string"
        && diagnostic?.home === binding.home && diagnostic.cli === join(binding.product ?? "", "dist/cli.js")
        && diagnostic.operation === "yui inbox claim";
      if (!receipt && !failure) return unknown("claim tail lacks exact bound output identity");
      segments.push({ kind: "uncredited-suffix", command, stdout,
        reason: "Output boundary only; no write success, authority or intra-command timing credit" });
      offset = item.aggregatedOutput.length; continue;
    }
    if (item.exitCode !== 0 && commandIndex === parts.length - 1 && segments.length
      && segments.every(s => s.kind === "file")) {
      const failed = failedReadSuffix(command, item.aggregatedOutput.slice(offset), item, binding);
      if (failed) { segments.push(failed); offset = item.aggregatedOutput.length; continue; }
    }
    const help = exact && item.exitCode === 0 && helpPrefix(item.aggregatedOutput, offset, exact);
    if (help) {
      segment = { ...help, command }; offset = help.end;
    } else if (exact && readArgs(exact)) {
      const doc = jsonPrefix(item.aggregatedOutput, offset);
      const envelope = doc && (exact.includes("--json") ? doc.value
        : plainValueEnvelope(doc.value, exact, binding, threadId, turnId));
      if (cliReadFailure(envelope, exact, binding)) {
        // Semicolons may continue after an error; && may not. Consume only
        // this exact diagnostic object, never search a noisy/truncated output.
        if (commandIndex < parts.length - 1 ? parts.separators[commandIndex] !== ";" : item.exitCode === 0)
          return unknown("failed read incompatible with separator or parent exit");
        segments.push({ kind: "failed-suffix", command, stdout: doc.stdout,
          reason: "exact bound failed read output; no read/effect credit" });
        offset = doc.end; continue;
      }
      if (!envelope || !cliDocumentMatches(envelope, exact, binding, threadId, turnId))
        return unknown("CLI document incomplete, failed, out of order or wrong native/source identity");
      if (jsonValues.some(v => isDeepStrictEqual(v, envelope))) return unknown("repeated indistinguishable JSON documents");
      jsonValues.push(envelope);
      cliDocuments.push({ args: exact, value: envelope });
      segment = { kind: "cli", command, args: exact, stdout: doc.stdout }; offset = doc.end;
    } else if (argv?.length === 1 && ["pwd", "/bin/pwd", "/usr/bin/pwd"].includes(argv[0])) {
      const stdout = item.cwd + "\n";
      if (!item.aggregatedOutput.startsWith(stdout, offset)) return unknown("cwd output mismatch");
      segment = { kind: "cwd", command, stdout }; offset += stdout.length;
    } else {
      const path = argv?.length === 3 ? resolve(item.cwd, argv[2]) : undefined;
      const manifest = path === binding.manifestPath && files.find(f => f.path === path && f.kind === "manifest");
      if (["jq", "/bin/jq", "/usr/bin/jq"].includes(argv?.[0]) && manifest && argv[1] !== ".") {
        if (hash(manifest.body) !== manifest.sha256) return unknown("Manifest source hash mismatch");
        const match = /^\{\s*([A-Za-z_]\w*(?:\s*:\s*\.[A-Za-z_]\w*)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*:\s*\.[A-Za-z_]\w*)?)*)\s*\}$/.exec(argv[1]);
        if (!match) return unknown("unsupported Manifest projection expression");
        let source; try { source = JSON.parse(manifest.body); } catch { return unknown("invalid frozen Manifest"); }
        const expected = {}, fields = [];
        for (const field of match[1].split(",")) {
          const [alias, selector] = field.trim().split(/\s*:\s*/);
          if (Object.hasOwn(expected, alias)) return unknown("ambiguous duplicate projection key");
          const name = selector?.slice(1) ?? alias;
          expected[alias] = source[name] ?? null; fields.push({ alias, field: name });
        }
        const doc = jsonPrefix(item.aggregatedOutput, offset);
        if (!doc || !isDeepStrictEqual(doc.value, expected)) return unknown("Manifest projection output/source mismatch");
        if (jsonValues.some(v => isDeepStrictEqual(v, doc.value))) return unknown("repeated indistinguishable JSON documents");
        jsonValues.push(doc.value);
        segment = { kind: "projection", command, stdout: doc.stdout,
          projection: { path, sourceSha256: manifest.sha256, fields, value: doc.value, bodyLoadCredit: false } };
        offset = doc.end;
      } else {
        const reads = literalReads(command, item.cwd, files);
        const stdout = reads?.map(r => r.body).join("");
        if (!reads?.length || !item.aggregatedOutput.startsWith(stdout, offset))
          return unknown("unsupported atom, unfrozen file, mixed write, or nonidentical file output");
        segment = { kind: "file", command, stdout, reads }; offset += stdout.length;
      }
    }
    segments.push(segment);
  }
  if (offset !== item.aggregatedOutput.length) return unknown("unconsumed output/noise/extra document");
  if (item.exitCode !== 0 && !["failed-suffix", "uncredited-suffix"].includes(segments.at(-1)?.kind))
    return unknown("Nonzero parent without an exactly consumed supported failure; no atom-success assumption");
  // The observed positional assignment is already valid. It is unique iff
  // its bipartite matching has no alternating cycle. Different JSON bytes
  // alone do not distinguish two reads of the same identity/view.
  const visited = new Set(), active = new Set();
  function ambiguous(i) {
    if (active.has(i)) return true;
    if (visited.has(i)) return false;
    active.add(i);
    for (let j = 0; j < cliDocuments.length; j++) if (i !== j
      && cliDocumentMatches(cliDocuments[i].value, cliDocuments[j].args, binding, threadId, turnId)
      && ambiguous(j)) return true;
    active.delete(i); visited.add(i); return false;
  }
  if (cliDocuments.some((_, i) => ambiguous(i))) return unknown("ambiguous command/document assignment");
  return { status: "recognized", segments };
}
function* sequenceEvents(events, files) {
  for (const e of events) {
    const item = e.message?.params?.item, p = e.message?.params;
    if (e.message?.method !== "item/completed" || item?.type !== "commandExecution") { yield e; continue; }
    const parsed = staticReadSequence(item, e.binding ?? {}, files, p.threadId, p.turnId);
    if (parsed.status !== "recognized" || parsed.segments.length === 1 && !["projection", "cwd", "help"].includes(parsed.segments[0].kind)) {
      yield e; continue;
    }
    for (const [commandIndex, segment] of parsed.segments.entries()) yield {
      ...e, staticSegment: segment, compound: { commandIndex, count: parsed.segments.length,
        nativeItemId: item.id, outputSha256: hash(item.aggregatedOutput),
        parentCommand: item.command, parentStatus: item.status,
        parentExitCode: item.exitCode, atomExitStatus: "not-observed",
        attribution: "unique full-output static sequence; output credit only, no execution/authority inference" },
      message: { ...e.message, params: { ...p, item: { ...item, id: `${item.id}/${commandIndex}`,
        command: segment.command, aggregatedOutput: segment.stdout,
        durationMs: commandIndex === 0 ? item.durationMs : undefined } } },
    };
  }
}
export function cliArguments(command, binding, commandCwd) {
  const argv = commandArguments(command, binding, commandCwd);
  if (!argv) return null;
  const args = argv.filter(x => x !== "--json");
  return readArgs(args) ? argv : null;
}
function projectedPageArguments(command, binding, commandCwd) {
  const outer = words(command);
  if (outer && ["zsh", "bash", "sh"].includes(basename(outer[0] ?? ""))
    && ["-lc", "-c"].includes(outer[1]) && outer.length === 3) command = outer[2];
  for (const [projection, suffix] of [
    ["page-fields", " | jq -r '.data.context.contentPage | {offset,totalCharacters,complete,nextCursor,text}'"],
    ["terminal-text", " | jq -r '.data.context.contentPage | {complete, nextCursor, text}'"],
  ]) if (command.endsWith(suffix)) {
    const prefix = command.slice(0, -suffix.length);
    const sequence = projection === "terminal-text" && commandSequence(prefix, binding, commandCwd, true);
    const args = projection === "terminal-text"
      ? sequence?.length === 1 && sequence[0] : cliArguments(prefix, binding, commandCwd);
    return args && readArgs(args) ? { args, projection } : null;
  }
  return null;
}
const pageReadIdentity = args => JSON.stringify(args.filter((arg, i) =>
  arg !== "--json" && arg !== "--cursor" && args[i - 1] !== "--cursor"));
function pageCursorMatches(cursor, page, offset) {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    return value.source === page.source && value.digest === page.digest && value.offset === offset;
  } catch { return false; }
}
export function epochAt(events, threadId, at) {
  return new Set(events.filter(e => e.direction === "native" && Date.parse(e.at) <= Date.parse(at)
    && e.message?.method === "item/completed" && e.message.params?.threadId === threadId
    && e.message.params?.item?.type === "contextCompaction").map(e => e.message.params.item.id)).size;
}
const sameOwner = (binding, target) => binding && binding.roleName === target.roleName
  && binding.taskId === target.taskId;
// A bounded file-backed routing shape, not a shell/JS evaluator. The literal
// submit target/entry and receipt must agree. Preparation and body-file bytes
// remain opaque: this grants no original-read, fidelity, load or script credit.
// The enclosing start precedes even hidden work in preparation; it never uses
// the receipt/save time as a deadline.
const fileRouteShape = new RegExp([
  String.raw`^umask 077; (?<dir>[A-Za-z_]\w*)=\$\(mktemp -d "\$\{TMPDIR%/\}/(?<template>[\w.-]+X{3,})"\) \|\| exit 1; `,
  String.raw`(?<source>[A-Za-z_]\w*)="\$\k<dir>/[\w.-]+"; (?<payload>[A-Za-z_]\w*)="\$\k<dir>/[\w.-]+"; `,
  String.raw`(?<read>[^$` + "`" + String.raw`|<>()\n;]+) > "\$\k<source>" && node -e '[^'\n]*' "\$\k<source>" > "\$\k<payload>" && `,
  String.raw`(?<submit>[^$` + "`" + String.raw`|<>()\n;]+) --body-file "\$\k<payload>"(?<options>[^$` + "`" + String.raw`|<>()\n;]+?)`,
  String.raw`(?<footer> && node -e 'process\.stdout\.write\(process\.argv\[1\]\)' "\$\k<dir>")?$`,
].join(""));
function fileBackedRoute(item, binding) {
  if (binding.roleName !== "operator" || binding.taskId || item.status !== "completed" || item.exitCode !== 0) return null;
  const outer = words(item.command);
  if (!outer || !["zsh", "bash", "sh"].includes(basename(outer[0] ?? ""))
    || !["-c", "-lc"].includes(outer[1]) || outer.length !== 3) return null;
  const m = fileRouteShape.exec(outer[2])?.groups;
  if (!m || new Set([m.dir, m.source, m.payload]).size !== 3) return null;
  const read = commandSequence(m.read, binding, item.cwd, true);
  const send = commandSequence(`${m.submit} --body-file /opaque-body${m.options}`, binding, item.cwd, true);
  const r = read?.length === 1 && read[0], s = send?.length === 1 && send[0];
  if (!r || r.length !== 6 || r.slice(0, 4).join(" ") !== "role message show operator"
    || !/^global-message-[1-9]\d*$/.test(r[4]) || r[5] !== "--json"
    || !s || s.length !== 11 || s.slice(0, 5).join(" ") !== "operator submit --body-file /opaque-body --task"
    || !/^task-[1-9]\d*$/.test(s[5]) || s[6] !== "--intent" || s[7] !== "discuss"
    || s[8] !== "--request-id" || !/^[\w.-]+$/.test(s[9]) || s[10] !== "--json") return null;
  const receipt = typeof item.aggregatedOutput === "string" && jsonPrefix(item.aggregatedOutput, 0);
  if (!receipt || receipt.value.ok !== true || typeof receipt.value.output !== "string"
    || !receipt.value.output.startsWith(`Saved message `)
    || !new RegExp(`^Saved message message-[1-9]\\d* to ${s[5]}\\.\\n`).test(receipt.value.output)) return null;
  const tail = item.aggregatedOutput.slice(receipt.end);
  const prefix = m.template.replace(/X+$/, "");
  const count = m.template.length - prefix.length;
  const expectedPrefix = join(resolve(binding.home, ".."), "tmp", prefix);
  if (m.footer ? !tail.startsWith(expectedPrefix)
    || !new RegExp(`^[A-Za-z0-9]{${count}}$`).test(tail.slice(expectedPrefix.length)) : tail !== "") return null;
  return { boundary: "enclosing-file-backed-route-start", taskId: s[5], requestId: s[9],
    receiptMessageId: /^Saved message (message-[1-9]\d*) /.exec(receipt.value.output)[1],
    bodyFile: "opaque; no read/fidelity/load credit" };
}
// The product persists the last nonempty agentMessage as its managed report.
// Its exact item/started observation is a conservative report-output boundary;
// turn/completed is never a substitute. Inputs must already be ownership-filtered.
export function reportingAction(events, terminal) {
  const unknown = reason => ({ status: "unknown", reason });
  const owned = events.filter(e => e.direction === "native" && sameOwner(e.binding, terminal.binding)
    && e.binding.home === terminal.binding.home
    && e.message?.params?.threadId === terminal.threadId
    && (e.message.params.turnId ?? e.message.params.turn?.id) === terminal.turnId
    && Date.parse(e.at) >= Date.parse(terminal.startedAt) && Date.parse(e.at) <= Date.parse(terminal.at));
  const actions = [];
  if (terminal.binding?.roleName === "leader") {
    const report = terminal.reportItemId ? { id: terminal.reportItemId }
      : terminal.turn?.items?.findLast(i => i.type === "agentMessage"
        && typeof i.text === "string" && i.text.trim());
    if (!report?.id) return unknown("No uniquely identified product-persisted managed report item");
    const starts = owned.filter(e => e.message.method === "item/started"
      && e.message.params.item?.type === "agentMessage" && e.message.params.item.id === report.id);
    if (starts.length !== 1) return unknown("Missing/ambiguous exact managed report item start; terminal time is not output start");
    actions.push({ kind: "managed-report", at: starts[0].at, nativeItemId: report.id,
      sourceConnection: starts[0].sourceConnection });
  }
  for (const e of owned.filter(e => e.message.method === "item/completed"
    && e.message.params.item?.type === "commandExecution")) {
    const item = e.message.params.item;
    const sequence = commandSequence(item.command, e.binding, item.cwd);
    const fileRoute = fileBackedRoute(item, e.binding);
    if (!fileRoute && !sequence?.some(argv => {
      const args = argv.filter(a => a !== "--json");
      return args[0] === "task" && args[1] === "message" && args[2] === "send"
        || args[0] === "role" && args[1] === "message" && ["queue", "steer"].includes(args[2]);
    })) continue;
    const starts = owned.filter(s => s.message.method === "item/started"
      && s.message.params.item?.type === "commandExecution" && s.message.params.item.id === item.id
      && s.sourceConnection === e.sourceConnection);
    // Even a failed/unknown send has drafted a durable Message. Do not ignore
    // it merely because its successful commit was not observed.
    if (starts.length !== 1 || !(Date.parse(starts[0].at) < Date.parse(e.at))
      || fileRoute && (!e.sourceConnection || starts[0].message.params.item.command !== item.command
        || starts[0].message.params.item.cwd !== item.cwd))
      return unknown("Missing/ambiguous durable Message command start");
    actions.push({ kind: "durable-message", at: starts[0].at, nativeItemId: item.id,
      sourceConnection: e.sourceConnection, ...(fileRoute ?? { boundary: sequence.length > 1
        ? "enclosing-static-command-start" : "exact-command-start" }) });
  }
  if (!actions.length) return unknown("No attributed reporting trigger");
  actions.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = actions[0];
  return { status: "observed", ...first, epoch: epochAt(events, terminal.threadId, first.at),
    threadId: terminal.threadId, turnId: terminal.turnId, actions,
    evidence: "Exact native item/started before product-persisted report or durable Message command, whichever is earlier" };
}
export function selectTerminal(events, target) {
  for (const e of events.filter(e => e.direction === "native" && Date.parse(e.at) >= Date.parse(target.since))) {
    const p = e.message?.params;
    if (e.message?.method !== "turn/completed" || !sameOwner(e.binding, target)) continue;
    const start = events.find(s => s.direction === "native" && Date.parse(s.at) >= Date.parse(target.since) && Date.parse(s.at) <= Date.parse(e.at)
      && sameOwner(s.binding, target) && s.message?.method === "turn/started"
      && s.message.params?.threadId === p.threadId && s.message.params?.turn?.id === p.turn.id);
    if (!start) continue;
    if (target.threadId && p.threadId !== target.threadId || target.turnId && p.turn.id !== target.turnId) continue;
    if (target.containsAt && !(Date.parse(start.at) <= Date.parse(target.containsAt) && Date.parse(target.containsAt) <= Date.parse(e.at))) continue;
    return { at: e.at, startedAt: start.at, threadId: p.threadId, turnId: p.turn.id,
      status: p.turn.status, turn: p.turn, binding: e.binding };
  }
  return null;
}
// A fresh Thread may initialize in one Turn and ACK retained handling in a
// later Turn. The old claim or first terminal cannot stand in for that receipt.
export function selectHandlingTerminal(events, { receipt, run, expectedThread, ...target }) {
  if (receipt) {
    const actor = receipt.actor;
    if (actor?.roleName !== target.roleName || actor.taskId !== target.taskId
      || actor.scope !== (target.taskId ? "task" : "global")
      || typeof actor.nativeSessionId !== "string" || !Number.isFinite(Date.parse(receipt.at))
      || expectedThread && actor.nativeSessionId !== expectedThread) return null;
    return selectTerminal(events, { ...target, threadId: actor.nativeSessionId, containsAt: receipt.at });
  }
  const provider = run?.result?.provider;
  if (expectedThread || !provider?.conversationId || !provider.nativeTurnId) return null;
  return selectTerminal(events, { ...target, threadId: provider.conversationId, turnId: provider.nativeTurnId });
}
export function nativeContinuationProof(raw, terminal) {
  const unknown = reason => ({ status: "unknown", reason });
  const { proofs, events } = attributeNativeEvents(raw);
  const own = events.filter(e => sameOwner(e.binding, terminal.binding)
    && e.message?.params?.threadId === terminal.threadId);
  const ends = own.filter(e => e.message?.method === "turn/completed"
    && e.message.params.turn?.id === terminal.turnId && e.message.params.turn.status === "completed"
    && e.at === terminal.at);
  if (terminal.status !== "completed" || ends.length !== 1) return unknown("Missing unique exact successful native terminal");
  const connection = ends[0].sourceConnection, rows = raw.filter(e => e.sourceConnection === connection);
  if (!proofs.some(p => p.connection === connection && p.threadId === terminal.threadId)
    || rows.some(e => e.invalidFrame || e.direction === "isolation-rejected"
      || e.binding && ["home", "cli", "product", "roleName", "taskId"].some(k => e.binding[k] !== terminal.binding[k])))
    return unknown("Native/source/transport identity not proven");
  const requests = rows.filter(e => e.direction === "host" && e.message?.id !== undefined && e.message.method);
  if (new Set(requests.map(e => JSON.stringify(e.message.id))).size !== requests.length
    || requests.some(q => rows.filter(r => r.direction === "native" && !r.message?.method
      && r.message?.id === q.message.id && !r.message.error && rows.indexOf(q) < rows.indexOf(r)).length !== 1))
    return unknown("Unresolved, failed or ambiguous native RPC");
  for (const q of rows.filter(e => e.direction === "host" && e.message?.method === "turn/start")) {
    const response = rows.find(r => r.direction === "native" && r.message?.id === q.message.id);
    const id = response?.message?.result?.turn?.id;
    if (!id || !own.some(e => e.message.method === "turn/completed" && e.message.params.turn.id === id
      && ["completed", "failed", "interrupted"].includes(e.message.params.turn.status)))
      return { ...unknown("An owned native Turn is still in flight"), pending: true };
  }
  const items = own.filter(e => (e.message.params.turnId ?? e.message.params.turn?.id) === terminal.turnId);
  for (const start of items.filter(e => e.message.method === "item/started")) {
    if (!items.some(e => e.message.method === "item/completed"
      && e.message.params.item?.id === start.message.params.item?.id
      && rows.indexOf(start) < rows.indexOf(e))) return unknown("An observed native tool/item has no endpoint");
  }
  if (items.some(e => e.message.method === "item/completed" && e.message.params.item?.type === "commandExecution"
    && !["completed", "failed", "declined"].includes(e.message.params.item.status)))
    return unknown("A native command remains in progress");
  return { status: "pass", connection, threadId: terminal.threadId, turnId: terminal.turnId,
    terminalAt: terminal.at, rpcCount: requests.length,
    limit: "Exact observed Turn/RPC/tool endpoints only; not OS background absence, model memory, read/load success or account settlement" };
}
export function nativeEvidence(events, files = [], originalOptions = {}) {
  const groups = new Map(), seen = new Set(), pages = new Map(), pageLinks = new Map();
  for (const e of sequenceEvents([...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), files)) {
    const p = e.message?.params, b = e.binding;
    if (e.direction !== "native" || !p?.threadId || !b?.roleName) continue;
    const turnId = p.turnId ?? p.turn?.id;
    if (!turnId) continue;
    const epoch = epochAt(events, p.threadId, e.at), key = `${b.taskId}/${b.roleName}/${p.threadId}/${turnId}/${epoch}`;
    let group = groups.get(key);
    if (!group) {
      group = { scope: { taskId: b.taskId, roleName: b.roleName, threadId: p.threadId, turnId,
        epoch }, trace: [], loads: [], complete: false,
      unsupported: [], evidence: "native-commandExecution" };
      groups.set(key, group);
    }
    if (e.message.method === "turn/completed") { group.complete = p.turn.status === "completed"; continue; }
    if (e.message.method !== "item/completed" || p.item?.type !== "commandExecution") continue;
    const item = p.item, id = `${key}/${item.id}`;
    if (seen.has(id)) continue; seen.add(id);
    if (e.staticSegment?.kind === "uncredited-suffix") {
      group.unsupported.push({ id: item.id, reason: e.staticSegment.reason, compound: e.compound }); continue;
    }
    if (e.staticSegment?.kind === "help") {
      (group.help ??= []).push({ at: e.at, nativeItemId: item.id, stdout: item.aggregatedOutput,
        args: e.staticSegment.args, compound: e.compound, credit: "none" }); continue;
    }
    if (e.staticSegment?.kind === "inventory") {
      (group.inventories ??= []).push({ at: e.at, nativeItemId: item.id, stdout: item.aggregatedOutput,
        roots: e.staticSegment.roots, paths: e.staticSegment.paths, compound: e.compound, credit: "none" }); continue;
    }
    const verifiedFileOutput = ["file", "cli"].includes(e.staticSegment?.kind)
      && ["completed", "failed"].includes(item.status) && Number.isInteger(item.exitCode);
    if ((!verifiedFileOutput && (item.status !== "completed" || item.exitCode !== 0)) || typeof item.command !== "string"
      || typeof item.aggregatedOutput !== "string"
      || item.commandActions != null && !Array.isArray(item.commandActions)) {
      group.unsupported.push({ id: item.id, reason: "tool not successfully complete or command/output unavailable" }); continue;
    }
    const starts = events.filter(s => s.direction === "native" && s.message?.method === "item/started"
      && s.message.params?.threadId === p.threadId && s.message.params?.turnId === turnId
      && s.message.params?.item?.id === item.id && sameOwner(s.binding, b));
    const originalPage = originalPageEvidence(item, b, p.threadId, starts.length === 1 ? starts[0].at : undefined,
      e.at, shellWords(item.command), originalOptions);
    const at = new Date(originalPage ? Date.parse(e.at) : p.completedAtMs ?? Date.parse(e.at)).toISOString();
    if (["projection", "cwd"].includes(e.staticSegment?.kind)) {
      (group.projections ??= []).push({ at, ...e.staticSegment.projection, kind: e.staticSegment.kind, nativeItemId: item.id,
        stdout: item.aggregatedOutput, compound: e.compound });
      continue;
    }
    // No marker extraction, output substring search or execution of shell text.
    // Single known CLI read, or bounded literal reads whose complete output
    // must equal the concatenated frozen source slices.
    const directArgs = originalPage?.args ?? cliArguments(item.command, b, item.cwd),
      projected = !directArgs && projectedPageArguments(item.command, b, item.cwd),
      args = directArgs ?? projected?.args;
    if (args) {
      let envelope;
      try { envelope = JSON.parse(item.aggregatedOutput); } catch {
        group.unsupported.push({ id: item.id, reason: "incomplete/unsupported CLI JSON output" }); continue;
      }
      if (directArgs && !cliOutputData(envelope, directArgs)) {
        group.unsupported.push({ id: item.id, reason: "unsupported plain CLI value or failed envelope" }); continue;
      }
      if (directArgs && !envelope?.data && !envelope?.contentPage
        && !plainValueEnvelope(envelope, directArgs, b, p.threadId, turnId)) {
        group.unsupported.push({ id: item.id, reason: "CLI value source/identity mismatch" }); continue;
      }
      if (directArgs && envelope?.contentPage && !directArgs.includes("--json")
        && !plainPageEnvelope(envelope, directArgs, b, p.threadId, turnId)) {
        group.unsupported.push({ id: item.id, reason: "plain CLI page lacks exact source/cursor/format metadata" }); continue;
      }
      // Without --json this CLI prints the same lossless contentPage object
      // without an RPC envelope. Preserve stdout and verify its page digest.
      let pageObservation;
      if (!directArgs) {
        const cursorIndex = args.indexOf("--cursor"), cursor = cursorIndex >= 0 ? args[cursorIndex + 1] : undefined;
        const link = cursor && pageLinks.get(`${key}/${cursor}`);
        const terminalText = projected.projection === "terminal-text";
        const fields = terminalText ? ["complete", "nextCursor", "text"]
          : ["offset", "totalCharacters", "complete", "nextCursor", "text"];
        let page = envelope;
        if (terminalText) {
          let requested; try { requested = JSON.parse(Buffer.from(cursor ?? "", "base64url").toString()); } catch { /* unknown */ }
          const previous = link && pages.get(`${key}/${link.page.source}/${link.page.digest}`);
          if (!link?.verifiedReadIdentity || !args.includes("--json") || envelope?.complete !== true
            || envelope.nextCursor !== null || typeof envelope.text !== "string"
            || requested?.source !== link.page.source || requested.digest !== link.page.digest
            || requested.offset !== link.nextOffset || typeof previous !== "string"
            || previous.length !== link.nextOffset
            || (previous + envelope.text).length !== link.page.totalCharacters
            || hash(previous + envelope.text) !== link.page.digest) {
            group.unsupported.push({ id: item.id, reason: "terminal projection lacks exact full cursor window/hash" }); continue;
          }
          page = { ...envelope, offset: link.nextOffset, totalCharacters: link.page.totalCharacters };
        }
        if (!link || link.identity !== pageReadIdentity(args) || !envelope
          || Object.keys(envelope).length !== fields.length || !fields.every(f => Object.hasOwn(envelope, f))
          || typeof envelope.text !== "string" || page.offset !== link.nextOffset
          || page.totalCharacters !== link.page.totalCharacters) {
          group.unsupported.push({ id: item.id, reason: "projection lacks exact preceding page/cursor/text" }); continue;
        }
        pageObservation = { page: { source: link.page.source, digest: link.page.digest,
          encoding: link.page.encoding, ...page }, precedingNativeItemId: link.nativeItemId,
        projection: projected.projection,
        attribution: "same owner/Turn/epoch, exact prior returned cursor and literal read identity; actual text still requires full digest" };
        pageLinks.delete(`${key}/${cursor}`);
      }
      const data = pageObservation ? { contentPage: pageObservation.page }
        : cliOutputData(envelope, directArgs);
      if (!data || envelope.ok === false) {
        group.unsupported.push({ id: item.id, reason: "missing successful CLI data" }); continue;
      }
      const page = data.contentPage ?? data.context?.contentPage;
      if (page) {
        const pageKey = `${key}/${page.source}/${page.digest}`, previous = pages.get(pageKey) ?? "";
        const cursorIndex = args.indexOf("--cursor"), cursor = cursorIndex >= 0 ? args[cursorIndex + 1] : undefined;
        const prior = cursor && pageLinks.get(`${key}/${cursor}`);
        const verifiedWindow = Boolean(directArgs && cliDocumentMatches(envelope, args, b, p.threadId, turnId)
          && (page.offset === 0 ? cursorIndex < 0 : prior?.verifiedReadIdentity
            && prior.identity === pageReadIdentity(args) && prior.nextOffset === page.offset
            && prior.page.totalCharacters === page.totalCharacters && pageCursorMatches(cursor, page, page.offset)));
        if (page.encoding !== "json" || page.offset !== previous.length || typeof page.text !== "string") {
          group.unsupported.push({ id: item.id, reason: "unsupported CLI page sequence" });
        } else {
          const text = previous + page.text;
          pages.set(pageKey, text);
          if (!page.complete && typeof page.nextCursor === "string")
            pageLinks.set(`${key}/${page.nextCursor}`, { page, nextOffset: text.length,
              identity: pageReadIdentity(args), nativeItemId: item.id,
              verifiedReadIdentity: verifiedWindow && pageCursorMatches(page.nextCursor, page, text.length) });
          if (page.complete && text.length === page.totalCharacters && hash(text) === page.digest)
            pages.delete(pageKey);
        }
      }
      group.trace.push({ at, args, code: 0, stdout: item.aggregatedOutput, stderr: "",
        nativeItemId: item.id, elapsedMs: item.durationMs, commandCwd: item.cwd,
        ...(originalPage ? { originalTool: originalPage } : {}),
        ...(e.compound ? { compound: e.compound, sourceConnection: e.sourceConnection } : {}),
        ...(pageObservation ? { pageObservation } : {}) });
      continue;
    }
    const reads = literalReads(item.command, item.cwd, files);
    if (!reads?.length || reads.map(f => f.body).join("") !== item.aggregatedOutput) {
      group.unsupported.push({ id: item.id, reason: "unsupported/segmented/truncated tool output" }); continue;
    }
    for (const { file, start, end, body } of reads) (file.kind === "manifest"
      ? (group.manifests ??= []) : group.loads).push({ path: file.path, kind: file.kind,
      body, at, bytes: end - start, sha256: hash(body), sourceSha256: file.sha256,
      sourceBytes: Buffer.byteLength(file.body), startByte: start, endByte: end,
      complete: start === 0 && end === Buffer.byteLength(file.body), nativeItemId: item.id,
      commandCwd: item.cwd, ...(e.compound ? { compound: e.compound } : {}) });
  }
  // A bad frame means the tool inventory might be incomplete, not a model miss.
  if (events.some(e => e.invalidFrame)) for (const g of groups.values()) g.unsupported.push({ reason: "transport frame unknown" });
  for (const [key, g] of groups) if ([...pages.keys()].some(p => p.startsWith(`${key}/`)))
    g.unsupported.push({ reason: "incomplete CLI content pages" });
  return [...groups.values()].map(g => ({ ...g, complete: g.complete && !g.unsupported.length }));
}
export function nativeCommandFailures(events, target) {
  return events.filter(e => e.direction === "native" && sameOwner(e.binding, target)
    && e.message?.method === "item/completed" && e.message.params?.threadId === target.threadId
    && e.message.params?.turnId === target.turnId
    && e.message.params?.item?.type === "commandExecution")
    .map(e => {
      const item = e.message.params.item;
      const missing = ["command", "aggregatedOutput"].filter(k => typeof item[k] !== "string");
      if (!Number.isInteger(item.exitCode)) missing.push("exitCode");
      const cli = commandArguments(item.command, e.binding, item.cwd) ? "observed" : "unknown";
      // Ownership can be established retrospectively, but omitted content cannot
      // be recovered. Keep the tool's failure facts even without CLI attribution.
      return { code: item.exitCode, stdout: item.aggregatedOutput,
        stderr: "", nativeItemId: item.id, nativeStatus: item.status,
        observation: { status: missing.length || cli === "unknown" ? "unknown" : "observed", missing, cli } };
    });
}
// Entry classification is separate from read attribution. Even failed writes,
// foreign CLI entries and unresolved bare lookups must remain visible here.
function cliInvocation(command, binding, cwd) {
  const argv = shellWords(command);
  if (!argv?.length) return null;
  let home;
  const assignments = new Set();
  while (/^(PATH|YUI_HOME)=/.test(argv[0] ?? "")) {
    const assignment = argv.shift(), key = assignment.slice(0, assignment.indexOf("="));
    if (assignments.has(key)) return null;
    assignments.add(key);
    if (key === "YUI_HOME") home = assignment.slice(9);
    // A literal PATH assignment does not change an explicit absolute entry.
    // It never resolves a bare executable, nor changes this process's PATH.
  }
  const entry = argv.shift();
  if (!entry) return null;
  const node = entry === "node" || basename(entry) === "node";
  const target = node ? argv.shift() : entry;
  if (node ? !/(^|\/)dist\/cli\.js$/.test(target ?? "") : basename(entry) !== "yui") return null;
  const expected = node ? join(binding.product ?? "", "dist/cli.js") : binding.cli;
  const actual = isAbsolute(target) ? target
    : target.includes("/") && isAbsolute(cwd ?? "") ? resolve(cwd, target) : undefined;
  const status = home !== undefined && home !== binding.home ? "fail"
    : actual && actual !== expected ? "fail"
      : !actual || node && (entry === "node" || entry !== binding.node) ? "unknown" : "pass";
  return { command, args: argv, entry, target, status,
    reason: status === "fail" ? "Observed foreign CLI entry or Home"
      : status === "unknown" ? "Unresolved executable lookup" : "Exact frozen owned entry" };
}
function cliEffectMatches(envelope, args, effect, scope) {
  if (!effect || envelope?.ok !== true) return false;
  args = args.filter(a => a !== "--json");
  const option = name => args[args.indexOf(name) + 1];
  if (effect.kind === "decision") return args.slice(0, 4).join(" ") === `task decision record ${effect.taskId}`
    && option("--title") === effect.title
    && envelope.output === `Recorded decision ${effect.id} for ${effect.taskId}`;
  if (effect.kind === "route") return (args.slice(0, 4).join(" ") === `task message send ${effect.taskId}`
      || args.slice(0, 2).join(" ") === "operator submit" && option("--task") === effect.taskId)
    && option("--request-id") === effect.requestId
    && envelope.data?.taskId === effect.taskId && envelope.data.message?.id === effect.id;
  const ack = envelope.data?.inbox?.ack;
  return effect.kind === "ack" && args.slice(0, 3).join(" ") === `inbox ack ${effect.id}`
    && envelope.data?.id === effect.id && ack?.at === effect.at
    && ack.actor?.taskId === scope.taskId && ack.actor.roleName === scope.roleName
    && ack.actor.nativeSessionId === scope.threadId;
}
// Version output proves only the probe. Stage identity additionally requires
// the actual effect command, and no observed wrong/ambiguous entry in the
// handling window. This bounded parser never executes captured shell text.
export function gradeCliExecution(events, binding, expectedOutput, scope, files = []) {
  const owned = events.filter(e => e.direction === "native" && sameOwner(e.binding, binding)
    && e.binding.home === binding.home && e.binding.cli === binding.cli && e.binding.product === binding.product
    && e.message?.params?.threadId === scope.threadId);
  const completed = owned.filter(e => e.message?.method === "item/completed"
    && epochAt(events, scope.threadId, e.at) === scope.epoch
    && Date.parse(e.at) <= Date.parse(scope.throughAt ?? scope.beforeAt)
    && e.message.params.item?.type === "commandExecution");
  const candidates = [], commands = [], effects = [], unsupported = [];
  for (const e of completed) {
      const item = e.message.params.item;
      const inWindow = !scope.afterAt || Date.parse(e.at) >= Date.parse(scope.afterAt);
      const parts = shellWords(item.command) ? [item.command] : staticCommands(item.command, true);
      const invocations = parts?.map(command => cliInvocation(command, binding, item.cwd));
      const successful = item.exitCode === 0 && item.status === "completed" && !item.error && !e.message.params.error
        && !item.truncated && !item.outputTruncated && !item.aggregatedOutputTruncated;
      // Entries are assessed even when output partitioning is unsupported.
      if (inWindow) {
        for (const c of invocations ?? []) if (c) commands.push({ ...c, nativeItemId: item.id,
          turnId: e.message.params.turnId, at: e.at });
        const read = staticReadSequence(item, binding, files, scope.threadId, e.message.params.turnId);
        const literal = successful && literalReads(item.command, item.cwd, files);
        const frozenRead = literal?.length && literal.map(r => r.body).join("") === item.aggregatedOutput;
        if (!parts?.length || invocations.some(c => !c) && read.status !== "recognized" && !frozenRead
          || !["completed", "failed"].includes(item.status) || !Number.isInteger(item.exitCode)
          || item.truncated || item.outputTruncated || item.aggregatedOutputTruncated)
          unsupported.push({ nativeItemId: item.id, reason: "Unsupported/incomplete command inventory or output" });
      }
      if (!successful || !parts?.length) continue;
      // Reuse exact read partitions (including frozen file bytes). Otherwise
      // support only an all-CLI JSON sequence with every document consumed.
      let segments;
      if (parts.length === 1) segments = [{ command: parts[0], stdout: item.aggregatedOutput }];
      else {
        const read = staticReadSequence(item, binding, files, scope.threadId, e.message.params.turnId);
        if (read.status === "recognized") segments = read.segments;
        else if (invocations.every(c => c?.args.includes("--json"))) {
          let offset = 0; const docs = [];
          for (const command of parts) {
            const doc = jsonPrefix(item.aggregatedOutput, offset);
            if (!doc) break;
            docs.push({ command, stdout: doc.stdout }); offset = doc.end;
          }
          if (docs.length === parts.length && offset === item.aggregatedOutput.length) segments = docs;
        }
      }
      for (const segment of segments ?? []) {
        const c = cliInvocation(segment.command, binding, item.cwd);
        if (c?.status !== "pass") continue;
        const args = c.args;
        if (args.length === 2 && args.includes("--json") && args.includes("version")
          && Date.parse(e.at) < Date.parse(scope.beforeAt)) candidates.push({
          at: e.at, nativeItemId: item.id, command: segment.command, parentCommand: item.command, cwd: item.cwd,
          outputSha256: hash(segment.stdout ?? ""), matches: typeof expectedOutput === "string" && segment.stdout === expectedOutput });
        let envelope; try { envelope = JSON.parse(segment.stdout); } catch { continue; }
        if (!inWindow || e.message.params.turnId !== scope.turnId
          || !cliEffectMatches(envelope, args, scope.effect, scope)) continue;
        const starts = owned.filter(s => s.message.method === "item/started"
          && s.message.params.turnId === scope.turnId && s.message.params.item?.id === item.id
          && s.sourceConnection === e.sourceConnection && s.message.params.item.command === item.command
          && s.message.params.item.cwd === item.cwd);
        const at = Date.parse(scope.effect.at);
        if (starts.length === 1 && Date.parse(starts[0].at) <= at && at <= Date.parse(e.at)
          && epochAt(events, scope.threadId, starts[0].at) === scope.epoch)
          effects.push({ nativeItemId: item.id, command: segment.command, parentCommand: item.command,
            startedAt: starts[0].at, completedAt: e.at, effect: scope.effect });
      }
  }
  if (events.some(e => e.invalidFrame)) unsupported.push({ reason: "Transport inventory incomplete" });
  const version = { status: candidates.some(c => !c.matches) ? "fail" : candidates.length ? "pass" : "unknown" };
  return { status: version.status === "fail" || commands.some(c => c.status === "fail") ? "fail"
      : version.status === "pass" && effects.length === 1 && !unsupported.length
        && !commands.some(c => c.status === "unknown") ? "pass" : "unknown",
    version, commands, effects, unsupported,
    proofs: candidates, expectedVersionSha256: typeof expectedOutput === "string" ? hash(expectedOutput) : "unknown",
    scope: { taskId: scope.taskId, roleName: scope.roleName, threadId: scope.threadId, epoch: scope.epoch },
    limit: "Observed probe plus exact effect receipt in its native command interval; only supported visible commands. Not OS isolation, daemon PATH inheritance, billing or hidden-command completeness." };
}
