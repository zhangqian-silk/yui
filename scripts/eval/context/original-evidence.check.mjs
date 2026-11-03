import test from "node:test";
import assert from "node:assert/strict";
import { hash, shellQuote } from "./common.mjs";
import { nativeEvidence } from "./native-evidence.mjs";
import { gradeReads } from "./judge.mjs";
import { binding, environment, request, source, pageRows, execute } from "./original-reader.check.mjs";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("bound tool uses existing fixture config in an actual login shell, fails missing identity/output cap closed", () => {
  const root = mkdtempSync(join(tmpdir(), "original-tool-entry-"));
  try {
    mkdirSync(join(root, "tools")); mkdirSync(join(root, "evidence"));
    for (const name of ["original-tool.mjs", "original-reader.mjs", "../core/io.mjs"]) {
      const destination = join(root, "tools", name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(new URL(name, import.meta.url), destination);
    }
    const message = { id: "global-message-1", roleName: "operator", body: "exact 汉字🧭" }, cli = join(root, "cli");
    // Pure protocol boundary, not managed authentication. Actual CLI/Home tests
    // are the separate model-free normal-warm fixture.
    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(
      JSON.stringify({ ok: true, data: message }) + "\n")});\n`, { mode: 0o755 });
    const env = { PATH: "/usr/bin:/bin", YUI_HOME: join(root, "not-a-Home"), YUI_SESSION_SCOPE: "global",
      YUI_ROLE: "operator", YUI_AGENT_ID: "codex", CODEX_THREAD_ID: "stub-thread" };
    writeFileSync(join(root, "provider.json"), JSON.stringify({ evidence: join(root, "evidence"),
      originalTool: { cli, home: env.YUI_HOME } }));
    const run = (req, e = env) => spawnSync("/usr/bin/zsh", ["-lc",
      [process.execPath, join(root, "tools/original-tool.mjs"), JSON.stringify(req)].map(shellQuote).join(" ")],
    { env: e, cwd: root, encoding: "utf8", timeout: 3000, maxBuffer: 65536 });
    const req = { kind: "inbox-message", messageId: message.id }, result = run(req);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, JSON.stringify({ ok: true, data: message }) + "\n");
    assert.equal(env.COLLAB_EVAL_CONFIG, undefined);
    const missing = { ...env }; delete missing.CODEX_THREAD_ID;
    for (const r of [run(req, missing), run({ ...req, home: "/other" })]) {
      assert.equal(r.status, 1); assert.equal(r.stdout, "");
    }
    const audit = readFileSync(join(root, "evidence/original-tool-audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(audit.map(a => a.calls.length), [1, 0, 0]);
  } finally { rmSync(root, { recursive: true }); }
});

test("single-page helper reuses native original union/hash judge, never credits internal/summary/deadline/foreign output", () => {
  const b = { ...binding, taskId: "task-1", roleName: "leader", product: "/product", node: "/node",
    originalTool: { ...binding, entry: "/f/tools/original-tool.mjs",
      files: { "original-tool.mjs": "a".repeat(64), "original-reader.mjs": "b".repeat(64), "common.mjs": "c".repeat(64) } } };
  function fixture(rows = pageRows()) {
    const audits = [], events = []; let cursor;
    for (const [index, row] of rows.entries()) {
      const req = { ...request, ...(cursor ? { cursor } : {}) }, calls = [];
      const response = execute(req, row);
      calls.push({ cli: binding.cli, args: response.args, code: 0, stdout: response.stdout, stderr: "" });
      const at = "2026-10-26T00:00:02Z", startedAt = "2026-10-26T00:00:01Z";
      const item = { id: `tool-${index}`, type: "commandExecution", status: "completed", exitCode: 0,
        command: `${b.node} ${b.originalTool.entry} ${shellQuote(JSON.stringify(req))}`,
        cwd: "/f", aggregatedOutput: response.stdout };
      const event = (method, at) => ({ direction: "native", binding: b, at,
        message: { method, params: { threadId: "thread", turnId: "turn", item } } });
      events.push(event("item/started", startedAt), event("item/completed", at));
      audits.push({ request: req, environment, cwd: "/f", startedAt, finishedAt: at,
        files: b.originalTool.files, calls, stdout: response.stdout, code: 0 });
      cursor = row.data.context.contentPage.nextCursor;
    }
    return { events, options: { originalAudits: audits } };
  }
  const { events, options } = fixture();
  const scope = { taskId: "task-1", roleName: "leader", threadId: "thread", turnId: "turn",
    epoch: 0, beforeAt: "2026-10-26T00:00:03Z" };
  const grade = (ev = events, opts = options, s = scope) => gradeReads(nativeEvidence(ev, [], opts), [source], s).status;
  assert.equal(grade(), "pass");
  const trace = nativeEvidence(events, [], options).flatMap(g => g.trace);
  assert.equal(trace.length, 3); assert(trace.every(t => t.originalTool.addedWrapperBytes === 0));
  assert.equal(trace.reduce((n, t) => n + t.originalTool.cliCalls, 0), 3);
  for (const subset of [events.slice(2), events.slice(0, -2),
    [...events.slice(0, 2), ...events.slice(0, 2), ...events.slice(-2)]])
    assert.notEqual(grade(subset), "pass", "missing/duplicate page is not full coverage");
  for (const mutate of [
    item => ({ ...item, aggregatedOutput: item.aggregatedOutput.slice(0, -5) }),
    item => ({ ...item, aggregatedOutput: '{"complete":true,"summary":"read all"}' }),
    item => ({ ...item, command: `node -e ${shellQuote("console.log('fake')")}` }),
    item => ({ ...item, command: item.command.replace("/f/tools/", "/else/") }),
    item => ({ ...item, cwd: "/else" }), item => ({ ...item, exitCode: 1 }),
    item => ({ ...item, command: item.command + " | jq ." }),
  ]) assert.notEqual(grade(events.map(e => ({ ...e, message: { ...e.message,
    params: { ...e.message.params, item: mutate(e.message.params.item) } } }))), "pass");
  for (const change of [
    a => ({ ...a, files: {} }), a => ({ ...a, calls: [] }),
    a => ({ ...a, calls: [{ ...a.calls[0], code: 1 }] }),
    a => ({ ...a, environment: { ...environment, CODEX_THREAD_ID: "foreign" } }),
    a => ({ ...a, environment: { ...environment, YUI_HOME: "/foreign" } }),
  ]) assert.notEqual(grade(events, { originalAudits: options.originalAudits.map(change) }), "pass");
  for (const s of [{ ...scope, epoch: 1 }, { ...scope, threadId: "foreign" },
    { ...scope, beforeAt: "2026-10-26T00:00:02Z" }]) assert.notEqual(grade(events, options, s), "pass");
  assert.notEqual(grade(events.filter(e => e.message.method !== "item/started")), "pass");
  // Self-consistent page metadata/hash is still insufficient if actual text is
  // only a summary or wrong source body. This tests the independent oracle.
  for (const value of [
    { ref: { store: "task-message", refId: source.id }, value: { ...source, body: undefined, summary: "read all" } },
    { ref: { store: "task-message", refId: source.id }, value: { ...source, body: "summary" } },
    { ref: { store: "task-message", refId: source.id }, value: { ...source, taskId: "other" } },
  ]) {
    const f = fixture(pageRows(value));
    assert.notEqual(grade(f.events, f.options), "pass");
  }
  const changed = structuredClone(events), changedAudits = structuredClone(options.originalAudits);
  for (const i of [2, 3]) {
    const item = changed[i].message.params.item, r = JSON.parse(item.aggregatedOutput);
    r.data.context.contentPage.digest = "0".repeat(64);
    item.aggregatedOutput = JSON.stringify(r) + "\n";
    changedAudits[1].stdout = item.aggregatedOutput; changedAudits[1].calls[0].stdout = item.aggregatedOutput;
  }
  assert.notEqual(grade(changed, { originalAudits: changedAudits }), "pass");
  assert.equal(hash(JSON.parse(trace[0].stdout).data.context.contentPage.text).length, 64);
});
