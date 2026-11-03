import test from "node:test";
import assert from "node:assert/strict";
import * as reader from "./original-reader.mjs";
import { hash } from "./common.mjs";

export const binding = { cli: "/f/bin/yui", home: "/f/state" };
export const environment = { YUI_HOME: binding.home, YUI_SESSION_SCOPE: "task", YUI_TASK_ID: "task-1",
  YUI_ROLE: "leader", YUI_AGENT_ID: "codex", CODEX_THREAD_ID: "thread" };
export const request = { kind: "run-message", runId: "run-1", messageId: "message-1" };
export const source = { taskId: "task-1", id: "message-1", body: "汉字🧭\\\n".repeat(7000) };
export function pageRows(value = { ref: { store: "task-message", refId: source.id }, value: source },
  name = "run:task-1/run-1/task-message/message-1", count = 3) {
  const text = JSON.stringify(value), digest = hash(text), rows = [];
  let offset = 0;
  for (let i = 1; i <= count; i++) {
    let end = Math.floor(text.length * i / count);
    if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    const nextCursor = end === text.length ? null
      : Buffer.from(JSON.stringify({ source: name, digest, offset: end })).toString("base64url");
    rows.push({ ok: true, data: { context: { contentPage: { source: name, digest, encoding: "json",
      offset, totalCharacters: text.length, totalBytes: Buffer.byteLength(text), text: text.slice(offset, end),
      complete: end === text.length, nextCursor } } } });
    offset = end;
  }
  return rows;
}
export function execute(req, row, overrides = {}) {
  const calls = [], stdout = JSON.stringify(row) + "\n";
  const result = reader.readOriginalPage(req, { binding, environment, transport: call => {
    calls.push(call); return { code: 0, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) };
  }, ...overrides });
  return { ...result, calls };
}

test("bound single-page entry forwards exact original CLI bytes once, with no range refetch or wrapper", () => {
  assert.equal(typeof reader.readOriginalPage, "function");
  const rows = pageRows(), received = [];
  let cursor;
  for (const row of rows) {
    const r = execute({ ...request, ...(cursor ? { cursor } : {}) }, row);
    assert.equal(r.calls.length, 1);
    assert.equal(r.stdout, JSON.stringify(row) + "\n");
    assert.equal(r.calls[0].environment, environment);
    assert.deepEqual(r.calls[0].args, ["--json", "task", "run", "context", "expand",
      "task-1/run-1", "message-1", "--store", "task-message", "--mode", "full",
      ...(cursor ? ["--cursor", cursor] : [])]);
    received.push(row.data.context.contentPage.text);
    cursor = row.data.context.contentPage.nextCursor;
  }
  assert.equal(cursor, null);
  assert.equal(hash(received.join("")), rows[0].data.context.contentPage.digest);
  assert.equal(JSON.parse(received.join("")).value.body, source.body);
});

test("page entry rejects wrong route/owner/cursor/metadata and budgets without fallback or partial stdout", () => {
  const rows = pageRows(), first = rows[0], p = first.data.context.contentPage;
  for (const req of [
    { ...request, kind: "shell" }, { ...request, home: binding.home },
    { ...request, owner: { roleName: "other" } }, { ...request, kind: "inbox-message" },
    { ...request, cursor: "wrong" }, { ...request, cursor: p.nextCursor },
    { ...request, maxOutputBytes: 20 }, { ...request, maxMs: 30000 },
  ]) assert.throws(() => execute(req, first));
  for (const env of [
    { ...environment, YUI_HOME: "/else" }, { ...environment, CODEX_THREAD_ID: undefined },
    { ...environment, YUI_ROLE: undefined }, { ...environment, YUI_SESSION_SCOPE: undefined },
    { ...environment, YUI_TASK_ID: undefined },
  ]) assert.throws(() => execute(request, first, { environment: env }));
  for (const change of [
    q => { q.source += "/wrong"; }, q => { q.offset++; },
    q => { q.text += "\uD83E"; }, q => { q.nextCursor = null; },
    q => { q.complete = true; }, q => { q.totalBytes = 1; },
  ]) {
    const row = structuredClone(first); change(row.data.context.contentPage);
    assert.throws(() => execute(request, row));
  }
  const changed = structuredClone(rows[1]); changed.data.context.contentPage.digest = "0".repeat(64);
  assert.throws(() => execute({ ...request, cursor: p.nextCursor }, changed));
  let calls = 0;
  for (const r of [
    { code: 1, stdout: Buffer.from('{"ok":false}'), stderr: Buffer.alloc(0) },
    { code: 0, stdout: Buffer.from('{"ok":true'), stderr: Buffer.alloc(0) },
    { code: 0, stdout: Buffer.alloc(70000), stderr: Buffer.alloc(0) },
    { code: 0, stdout: Buffer.from([255]), stderr: Buffer.alloc(0) },
  ]) {
    const before = calls;
    assert.throws(() => reader.readOriginalPage(request, { binding, environment, transport: () => { calls++; return r; } }));
    assert.equal(calls, before + 1);
  }
  assert.throws(() => execute(request, first, { clock: (() => { let t = 0; return () => t += 30000; })() }));
  for (const global of [false, true]) {
    const env = global ? { ...environment, YUI_SESSION_SCOPE: "global", YUI_TASK_ID: undefined, YUI_ROLE: "operator" } : environment;
    const req = global ? { kind: "inbox-message", messageId: "global-message-1" }
      : { kind: "task-message", messageId: source.id };
    const message = global ? { id: req.messageId, roleName: "operator", body: "exact 🧭" } : { ...source, body: "short" };
    const r = execute(req, { ok: true, data: message }, { environment: env });
    assert.equal(JSON.parse(r.stdout).data.body, message.body);
    assert.deepEqual(r.calls[0].args, global ? ["--json", "inbox", "show", req.messageId]
      : ["--json", "task", "message", "show", `task-1/${source.id}`]);
    assert.throws(() => execute(req, { ok: true, data: { ...message, body: undefined, summary: "only" } }, { environment: env }));
    assert.throws(() => execute(req, { ok: true, data: { ...message, taskId: "foreign" } }, { environment: env }));
  }
});
