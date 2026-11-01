import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createZstdCompress } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { measure, planChain, readHeader, scanHeaders } from "./measure.mjs";

const cutoff = "2026-10-22T07:29:52.562Z";
const row = (ordinal, type, payload, timestamp = "2026-10-20T00:00:00Z") =>
  JSON.stringify({ ordinal, type, payload, timestamp }) + "\n";
const meta = (id, extra = {}) => ({ id, session_id: id, cwd: "/fixture/tasks/task-122/main", source: "vscode", ...extra });
const msg = text => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const usage = (id, input = 10) => ({ response_id: id, usage: { input_tokens: input, cached_input_tokens: 3, output_tokens: 2 } });

test("continuation uses BOTH predecessor byte and ordinal bounds, not concatenated full files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-cost-"));
  try {
    const a = join(dir, "rollout-root.jsonl"), b = join(dir, "rollout-root_next.jsonl");
    const prefix = row(0, "session_meta", meta("root")) + row(1, "response_item", msg("中文🙂"));
    await writeFile(a, prefix + row(2, "response_item", msg("excluded predecessor tail")));
    await writeFile(b, row(2, "session_meta", meta("root", { history_base: {
      thread_id: "root", end_byte_offset: Buffer.byteLength(prefix), end_ordinal_exclusive: 2
    } })) + row(3, "response_item", msg("new")));
    const headers = await scanHeaders(dir);
    const chain = planChain(headers, headers.find(h => h.path === b));
    const result = await measure(chain, { cutoff });
    assert.equal(result.visible.added.chars, 6); // Unicode code points, NOT UTF-16.
    assert.equal(result.visible.added.bytes, 13);
    assert.equal(result.visible.duplicate.chars, 0);
    const bad = structuredClone(chain);
    bad[0].endOrdinal = 1;
    await assert.rejects(measure(bad, { cutoff }), /ordinal/);
    bad[0].endOrdinal = 2;
    bad[0].endByte--;
    await assert.rejects(measure(bad, { cutoff }), /boundary/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("request identity de-duplicates records/snapshots; compaction replaces residence, not added history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-cost-"));
  try {
    const path = join(dir, "rollout-root.jsonl");
    await writeFile(path, [
      row(0, "session_meta", meta("root")),
      row(1, "response_item", msg("hello")),
      row(2, "token_usage_record", usage("r1")),
      row(3, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } } }),
      row(4, "compacted", { replacement_history: [msg("hi")], latest_token_usage_record: usage("r1"), compaction_response_id: "r1" }),
      row(5, "token_usage_record", usage("r1")),
      row(6, "response_item", msg("hello")),
      row(7, "token_usage_record", usage("r2", 20)),
      row(8, "response_item", msg("after cutoff"), "2026-10-23T00:00:00Z")
    ].join(""));
    const result = await measure(planChain(await scanHeaders(dir), await readHeader(path)), { cutoff });
    assert.equal(result.usage.exact.requests, 2);
    assert.equal(result.usage.exact.input_tokens, 30);
    assert.equal(result.usage.exact.cached_input_tokens, 6); // Subset, never added to input.
    assert.equal(result.usage.duplicateRecords, 2);
    assert.equal(result.usage.compactionExactSubset.input_tokens, 10);
    assert.equal(result.visible.added.chars, 10);
    assert.equal(result.visible.duplicate.chars, 5);
    assert.equal(result.visible.retained.chars, 7);
    assert.equal(result.visible.compactionReplacement.chars, 2);
    assert.equal(result.residence.completionBoundaryProxy.charsSum, 12);
    assert.equal(result.afterCutoffRecords, 1);
    const conflict = join(dir, "rollout-conflict.jsonl");
    await writeFile(conflict, row(0, "session_meta", meta("conflict")) +
      row(1, "token_usage_record", usage("same", 10)) + row(2, "token_usage_record", usage("same", 20)));
    await assert.rejects(measure([await readHeader(conflict)], { cutoff }), /Conflicting request/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("root identity is not cwd; mixed commands stay mixed; encrypted and missing IDs stay unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-cost-"));
  try {
    const path = join(dir, "rollout-root.jsonl.zst");
    const text = [
      row(0, "session_meta", meta("root")),
      row(1, "response_item", { type: "function_call", call_id: "c", name: "exec_command",
        arguments: JSON.stringify({ cmd: "cat skills/yui-runtime/SKILL.md; git diff" }) }),
      row(2, "response_item", { type: "function_call_output", call_id: "c", output: "mixed output" }),
      row(3, "response_item", { type: "reasoning", summary: [], encrypted_content: "opaque" }),
      row(4, "token_usage_record", { usage: usage("ignored").usage }),
    ].join("");
    await pipeline(Readable.from([text]), createZstdCompress(), createWriteStream(path));
    const h = await readHeader(path);
    const result = await measure([h], { cutoff });
    assert.equal(result.visible.categories["tool:skill-mixed"].chars, 12);
    assert.equal(result.opaqueReasoningRecords, 1);
    assert.equal(result.usage.unkeyedRecords, 1);
    assert.equal(result.usage.exact.requests, 0);
    const child = join(dir, "rollout-child.jsonl");
    await writeFile(child, row(0, "session_meta", meta("child", { parent_thread_id: "root" })));
    assert.equal((await readHeader(child)).root, false);
    const fork = join(dir, "rollout-fork.jsonl");
    await writeFile(fork, row(0, "session_meta", meta("fork", { forked_from_id: "root" })));
    assert.equal((await readHeader(fork)).root, false);
    const nested = join(dir, "rollout-nested.jsonl");
    await writeFile(nested, row(0, "session_meta", meta("nested", { source: { subagent: { thread_spawn: {} } } })));
    assert.equal((await readHeader(nested)).root, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("manifest-prefixed notifications remain identifiable inside compaction residence; initial reads are not reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-cost-"));
  try {
    const path = join(dir, "rollout-root.jsonl");
    const notice = "Yui Session Manifest at /fixture/manifest.json\n\nYui Global Message: role=operator message=m1.";
    await writeFile(path, [
      row(0, "session_meta", meta("root")),
      row(1, "response_item", msg(notice)),
      row(2, "response_item", { type: "function_call", name: "exec_command", call_id: "c",
        arguments: JSON.stringify({ cmd: "cat skills/yui-runtime/SKILL.md" }) }),
      row(3, "response_item", { type: "function_call_output", call_id: "c", output: "rules" }),
      row(4, "compacted", { replacement_history: [msg(notice)] }),
      row(5, "token_usage_record", usage("r1"))
    ].join(""));
    const result = await measure([await readHeader(path)], { cutoff });
    assert.equal(result.visible.notifications.count, 1);
    assert.equal(result.visible.notifications.retainedCount, 1);
    assert.equal(result.visible.notifications.retained.chars, notice.length);
    assert.equal(result.visible.resetWindowSkillReadsByCause.initial.chars, 5);
    assert.equal(result.visible.resetWindowSkillReadsByCause.compaction.chars, 0);
    assert.equal(result.visible.retained.chars, notice.length);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
