// Local, read-only rollout measurements. Never serialize source text or tool arguments.
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { createZstdDecompress } from "node:zlib";

const hash = text => createHash("sha256").update(text).digest("hex");
const size = text => ({ chars: [...text].length, bytes: Buffer.byteLength(text) });
const zero = () => ({ chars: 0, bytes: 0 });
const add = (a, b) => { a.chars += b.chars; a.bytes += b.bytes; };
const tokenFields = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"];
const emptyUsage = () => Object.fromEntries(tokenFields.map(k => [k, 0]));

// Offsets are always UNCOMPRESSED bytes, including LF. Do not use readline's
// normalized line length to implement history_base.end_byte_offset.
async function* lines(path, endByte) {
  const input = createReadStream(path, { highWaterMark: 64 * 1024 });
  const stream = path.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
  const forward = error => stream.destroy(error);
  if (stream !== input) input.on("error", forward);
  let pending = Buffer.alloc(0), offset = 0;
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, chunk]);
      let lf;
      while ((lf = pending.indexOf(10)) !== -1) {
        const raw = pending.subarray(0, lf + 1);
        if (endByte !== undefined && offset + raw.length > endByte) {
          throw new Error(`Non-line byte boundary: ${path}:${endByte}`);
        }
        offset += raw.length;
        yield { raw, end: offset, value: JSON.parse(raw.toString("utf8")) };
        pending = pending.subarray(lf + 1);
        if (offset === endByte) return;
      }
    }
    if (pending.length || (endByte !== undefined && offset !== endByte)) {
      throw new Error(`Incomplete JSONL byte boundary: ${path}:${offset}`);
    }
  } finally {
    stream.destroy();
    input.destroy();
  }
}

export async function readHeader(path) {
  for await (const { value: x } of lines(path)) {
    if (x.type !== "session_meta") throw new Error(`Missing session_meta: ${path}`);
    const p = x.payload;
    const sourceChild = p.source === "subagent" ||
      (typeof p.source === "object" && p.source !== null && "subagent" in p.source);
    return {
      path, id: p.id, sessionId: p.session_id, cwd: p.cwd,
      timestamp: x.timestamp, ordinal: x.ordinal, historyBase: p.history_base,
      parent: p.parent_thread_id ?? p.source?.subagent?.thread_spawn?.parent_thread_id,
      fork: p.forked_from_id,
      root: !p.parent_thread_id && !p.forked_from_id && !sourceChild && (!p.session_id || p.session_id === p.id),
      segment: basename(path).replace(/\.jsonl(?:\.zst)?$/, "").split("_").at(-1).match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      )?.[0] ?? basename(path).replace(/^rollout-/, "").replace(/\.jsonl(?:\.zst)?$/, "").split("_").at(-1)
    };
  }
  throw new Error(`Empty metadata: ${path}`);
}

export async function scanHeaders(directory) {
  const result = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.jsonl(?:\.zst)?$/.test(entry.name)) result.push(await readHeader(path));
    }
  }
  await walk(directory);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export function planChain(headers, tail, tailByte) {
  const chain = [], seen = new Set();
  let current = tail, endByte = tailByte, endOrdinal;
  while (current) {
    if (!current.root || current.id !== tail.id) throw new Error("Not the same root identity");
    if (seen.has(current.path)) throw new Error("Continuation cycle");
    seen.add(current.path);
    chain.unshift({ ...current, ...(endByte === undefined ? {} : { endByte }),
      ...(endOrdinal === undefined ? {} : { endOrdinal }) });
    const base = current.historyBase;
    if (!base) break;
    if (!Number.isSafeInteger(base.end_byte_offset) || base.end_byte_offset <= 0 ||
        !Number.isSafeInteger(base.end_ordinal_exclusive) ||
        base.end_ordinal_exclusive !== current.ordinal) throw new Error("Invalid history_base bounds");
    const candidates = headers.filter(h => h.id === tail.id && h.segment === base.thread_id);
    if (candidates.length !== 1) throw new Error(`Missing/ambiguous predecessor ${base.thread_id}`);
    current = candidates[0];
    endByte = base.end_byte_offset;
    endOrdinal = base.end_ordinal_exclusive;
  }
  return chain;
}

function commandText(p) {
  // Nested parallel wrappers are deliberately classified as mixed if necessary.
  try {
    const arg = JSON.parse(p.arguments);
    const commands = [];
    function visit(value) {
      if (!value || typeof value !== "object") return;
      for (const [key, val] of Object.entries(value)) {
        if (["cmd", "command", "path", "file_path"].includes(key) && typeof val === "string") commands.push(val);
        else if (typeof val === "object") visit(val);
      }
    }
    visit(arg);
    return commands.join("\n");
  } catch { return ""; }
}

export function classifyCommand(command) {
  if (!command) return "unknown";
  const skill = /SKILL\.md|(?:\/|^)skills\/|skill-packages\//.test(command);
  // A pure label is intentionally narrow; unknown shell constructs stay mixed.
  if (skill) return !/[;&|`$]/.test(command) && /^(?:cat|sed -n '[^']+'|head(?: -n \d+)?)\s+\S*(?:SKILL\.md|skills\/\S+\.md)\s*$/.test(command)
    ? "skill-only-command" : "skill-mixed";
  if (/\byui\b.*(?:context|inbox|message|wake|skills)/.test(command)) return "yui-context-mixed-or-single";
  if (/\b(?:git|rg|cat|sed|head|tail|ls)\b/.test(command)) return "source-git-file-mixed-or-single";
  if (/\b(?:npm|make|node|test)\b/.test(command)) return "build-test-mixed-or-single";
  return "other-command";
}

function textOf(p) {
  if (p.type === "message") return (p.content ?? []).map(c => c.text ?? "").join("");
  if (["function_call", "custom_tool_call"].includes(p.type)) return p.arguments ?? p.input ?? "";
  if (["function_call_output", "custom_tool_call_output"].includes(p.type)) {
    return typeof p.output === "string" ? p.output
      : Array.isArray(p.output) ? p.output.map(c => c.text ?? "").join("") : p.output?.text ?? "";
  }
  if (p.type === "reasoning") return (p.summary ?? []).map(c => c.text ?? "").join("");
  return "";
}
const notification = text => /(?:^|\n)\s*(?:\[Yui updates\]|\[Yui (?:notification|Notification)\]|Yui (?:Task notification|Global Message|AgentRun input):?)/.test(text);

export async function measure(chain, { cutoff }) {
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("Invalid cutoff");
  const result = {
    sources: [], records: 0, afterCutoffRecords: 0, turns: 0, compactions: 0,
    opaqueReasoningRecords: 0, unmeasuredResponseTypes: {}, nonTextContentBlocks: {},
    visible: { added: zero(), duplicate: zero(), categories: {}, retained: zero(),
      retainedCategories: {}, compactionReplacement: zero(), metadataInstructionSnapshots: zero(),
      resetWindowSkillReads: zero(),
      resetWindowSkillReadsByCause: { initial: zero(), continuation: zero(), compaction: zero() },
      notifications: { count: 0, added: zero(), retained: zero(), retainedCount: 0 } },
    residence: {
      exactRequestBeforeVisible: null,
      requestBeforeProxy: { samples: 0, charsSum: 0, bytesSum: 0, charsMax: 0, bytesMax: 0 },
      completionBoundaryProxy: { samples: 0, charsSum: 0, bytesSum: 0, charsMax: 0, bytesMax: 0 }
    },
    usage: { exact: { requests: 0, ...emptyUsage() }, duplicateRecords: 0, unkeyedRecords: 0,
      exactMissingFieldRecords: Object.fromEntries(tokenFields.map(k => [k, 0])),
      snapshotEvents: 0, snapshotTransitions: 0, snapshotResets: 0,
      snapshotPositiveDeltasApproximate: emptyUsage(), firstExactRequest: null,
      snapshotOnlyUnidentifiedTransitions: 0, compactionRequestsWithoutUsage: 0,
      compactionExactSubset: { requests: 0, ...emptyUsage() } },
    limitations: [
      "No billed cost or exact tokenizer conversion; cached input is a subset of input; reasoning is a subset of output.",
      "Request-before residence is a stream reconstruction proxy: at a usage completion, subtract assistant items since previous keyed usage. Wire ordering, missing usage, fixed/tool prompts, truncation and opaque reasoning remain unknown.",
      "Snapshot deltas are separately approximate and NEVER added to keyed request usage. Repeated token_count and thread/turn cumulative counters are not summed.",
      "Compaction replacement is a retained snapshot, NOT new input; metadata instructions are separately observed snapshots, not repeated delivery.",
      "Reload evidence is skill-associated output between session/compaction reset and next task_complete; cause and exact delivered reload tokens are unknown.",
      "Tool attribution uses command provenance, not output semantics; mixed shell/parallel commands are not pure Skill output.",
      "Historical exploration is not current B0, holdout, quality evidence, or a causal savings estimate."
    ]
  };
  const calls = new Map(), seenText = new Set(), seenUsage = new Map(), compactionRequests = new Set();
  let retained = zero(), retainedCategories = {}, baseInstructions = zero(), pendingAssistant = zero();
  let retainedNotificationCount = 0;
  let resetWindow = true, resetCause = "initial", previousSnapshot = null, keyedSinceSnapshot = false;
  const retain = (category, n) => { add(retained, n); add(retainedCategories[category] ??= zero(), n); };
  function category(p, text) {
    if (p.type.endsWith("_output")) return `tool:${calls.get(p.call_id) ?? "unknown"}`;
    if (p.type === "message") return notification(text) && p.role === "user" ? "notification" : `message:${p.role}`;
    return p.type === "reasoning" ? "reasoning-visible-summary" : `call:${p.name ?? "unknown"}`;
  }
  function sample(target, n) {
    target.samples++;
    target.charsSum += n.chars; target.bytesSum += n.bytes;
    target.charsMax = Math.max(target.charsMax, n.chars);
    target.bytesMax = Math.max(target.bytesMax, n.bytes);
  }
  function recordUsage(p) {
    if (!p) return;
    if (!p.response_id || !p.usage) { result.usage.unkeyedRecords++; return; }
    const u = p.usage;
    for (const field of tokenFields) if (u[field] !== undefined && (!Number.isSafeInteger(u[field]) || u[field] < 0)) {
      throw new Error(`Invalid usage ${field}`);
    }
    if (!Number.isSafeInteger(u.input_tokens) || !Number.isSafeInteger(u.output_tokens) ||
        (u.cached_input_tokens ?? 0) > u.input_tokens || (u.reasoning_output_tokens ?? 0) > u.output_tokens) {
      throw new Error("Invalid usage subset");
    }
    const key = `${p.thread_id ?? chain[0].id}/${p.response_id}`;
    const value = JSON.stringify(Object.fromEntries(Object.entries(u).sort(([a], [b]) => a.localeCompare(b))));
    if (seenUsage.has(key)) {
      if (seenUsage.get(key) !== value) throw new Error("Conflicting request usage identity");
      result.usage.duplicateRecords++;
      return;
    }
    seenUsage.set(key, value);
    result.usage.exact.requests++;
    for (const field of tokenFields) {
      result.usage.exact[field] += u[field] ?? 0;
      if (u[field] === undefined) result.usage.exactMissingFieldRecords[field]++;
    }
    result.usage.firstExactRequest ??= Object.fromEntries(tokenFields.map(k => [k, u[k] ?? null]));
    keyedSinceSnapshot = true;
    const current = { chars: retained.chars + baseInstructions.chars, bytes: retained.bytes + baseInstructions.bytes };
    sample(result.residence.completionBoundaryProxy, current);
    sample(result.residence.requestBeforeProxy, {
      chars: Math.max(0, current.chars - pendingAssistant.chars),
      bytes: Math.max(0, current.bytes - pendingAssistant.bytes)
    });
    pendingAssistant = zero();
  }
  for (const source of chain) {
    const checksum = createHash("sha256");
    let count = 0, lastOrdinal, bytes = 0, previousOrdinal, stoppedAtCutoff = false;
    const sourceStat = await stat(source.path);
    for await (const { raw, end, value: x } of lines(source.path, source.endByte)) {
      if (!Number.isSafeInteger(x.ordinal)) throw new Error(`Missing ordinal: ${source.path}:${count}`);
      if (previousOrdinal !== undefined && x.ordinal <= previousOrdinal) throw new Error("Non-monotone ordinal");
      if (source.endOrdinal !== undefined && x.ordinal >= source.endOrdinal) throw new Error("Predecessor ordinal boundary exceeded");
      if (!Number.isFinite(Date.parse(x.timestamp))) throw new Error("Missing record timestamp");
      // Rollouts are append-ordered. Freeze a prefix at the first later timestamp,
      // so future appends cannot silently change the source fingerprint.
      if (Date.parse(x.timestamp) > Date.parse(cutoff)) {
        result.afterCutoffRecords++; stoppedAtCutoff = true; break;
      }
      checksum.update(raw); count++; bytes = end;
      previousOrdinal = lastOrdinal = x.ordinal;
      result.records++;
      const p = x.payload ?? {};
      if (x.type === "session_meta") {
        if (p.id !== source.id) throw new Error("Source root identity changed");
        const text = p.base_instructions?.text ?? "";
        baseInstructions = size(text);
        add(result.visible.metadataInstructionSnapshots, baseInstructions);
        resetWindow = true;
        resetCause = source.historyBase ? "continuation" : "initial";
      } else if (x.type === "response_item") {
        for (const block of p.content ?? []) if (block.text === undefined) {
          const kind = block.type ?? "unknown";
          result.nonTextContentBlocks[kind] = (result.nonTextContentBlocks[kind] ?? 0) + 1;
        }
        if (["function_call", "custom_tool_call"].includes(p.type)) calls.set(p.call_id, classifyCommand(commandText(p)));
        if (p.type === "reasoning" && p.encrypted_content) result.opaqueReasoningRecords++;
        const text = textOf(p);
        if (!text) {
          if (!["reasoning", "message"].includes(p.type)) result.unmeasuredResponseTypes[p.type] = (result.unmeasuredResponseTypes[p.type] ?? 0) + 1;
          continue;
        }
        const n = size(text), kind = category(p, text);
        add(result.visible.added, n);
        add(result.visible.categories[kind] ??= zero(), n);
        const digest = hash(`${p.type}\0${text}`);
        if (seenText.has(digest)) add(result.visible.duplicate, n);
        seenText.add(digest);
        retain(kind, n);
        if (p.role === "assistant" || ["reasoning", "function_call", "custom_tool_call"].includes(p.type)) add(pendingAssistant, n);
        if (kind === "notification") {
          result.visible.notifications.count++; retainedNotificationCount++;
          add(result.visible.notifications.added, n);
        }
        if (resetWindow && kind.startsWith("tool:skill")) {
          add(result.visible.resetWindowSkillReads, n);
          add(result.visible.resetWindowSkillReadsByCause[resetCause], n);
        }
      } else if (x.type === "token_usage_record") recordUsage(p);
      else if (x.type === "compacted") {
        // Count compaction request usage before replacing the history it consumed.
        if (p.compaction_response_id) compactionRequests.add(`${chain[0].id}/${p.compaction_response_id}`);
        if (p.latest_token_usage_record) recordUsage(p.latest_token_usage_record);
        result.compactions++;
        retained = zero(); retainedCategories = {}; pendingAssistant = zero(); retainedNotificationCount = 0;
        if (Array.isArray(p.replacement_history)) {
          for (const item of p.replacement_history) {
            const text = textOf(item), n = size(text);
            const kind = category(item, text);
            if (kind === "notification") retainedNotificationCount++;
            retain(kind, n); add(result.visible.compactionReplacement, n);
          }
        } else {
          result.unknownCompactionReplacement = (result.unknownCompactionReplacement ?? 0) + 1;
          const n = size(p.message ?? "");
          retain("compaction-summary", n); add(result.visible.compactionReplacement, n);
        }
        resetWindow = true;
        resetCause = "compaction";
      } else if (x.type === "event_msg") {
        if (p.type === "task_started") result.turns++;
        if (p.type === "task_complete") resetWindow = false;
        if (p.type === "token_count" && p.info?.total_token_usage) {
          const total = p.info.total_token_usage;
          result.usage.snapshotEvents++;
          if (JSON.stringify(total) !== JSON.stringify(previousSnapshot)) {
            result.usage.snapshotTransitions++;
            if (!keyedSinceSnapshot) result.usage.snapshotOnlyUnidentifiedTransitions++;
            let reset = false;
            for (const field of tokenFields) {
              const next = total[field] ?? 0, prev = previousSnapshot?.[field] ?? 0;
              if (next < prev) reset = true;
              result.usage.snapshotPositiveDeltasApproximate[field] += next >= prev ? next - prev : next;
            }
            if (reset) result.usage.snapshotResets++;
          }
          previousSnapshot = total; keyedSinceSnapshot = false;
        }
      }
    }
    if (source.endOrdinal !== undefined && lastOrdinal + 1 !== source.endOrdinal) throw new Error("Predecessor ordinal boundary incomplete");
    const after = await stat(source.path);
    if (after.size < sourceStat.size) throw new Error("Source shrank during read");
    result.sources.push({ path: source.path, rootId: source.id, segmentId: source.segment,
      startOrdinal: source.ordinal, lastOrdinal, endOrdinalExclusive: source.endOrdinal ?? null,
      readUncompressedBytes: bytes, storedBytesObserved: sourceStat.size, prefixSha256: checksum.digest("hex"),
      recordsRead: count, boundedBySuccessor: source.endOrdinal !== undefined, stoppedAtCutoff });
  }
  result.visible.retained = retained;
  result.visible.retainedCategories = retainedCategories;
  result.visible.notifications.retained = retainedCategories.notification ?? zero();
  result.visible.notifications.retainedCount = retainedNotificationCount;
  result.usage.compactionRequestsWithoutUsage = [...compactionRequests].filter(key => !seenUsage.has(key)).length;
  for (const key of compactionRequests) {
    const serialized = seenUsage.get(key);
    if (!serialized) continue;
    const usage = JSON.parse(serialized);
    result.usage.compactionExactSubset.requests++;
    for (const field of tokenFields) result.usage.compactionExactSubset[field] += usage[field] ?? 0;
  }
  return result;
}
