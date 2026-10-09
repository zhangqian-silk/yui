import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectTaskUsageMetrics } from "../../dist/runtime/taskUsageMetrics.js";
import { projectSessionTokenMetrics } from "../../dist/runtime/sessionTokenMetrics.js";
import { createRuntimeObservation, runtimeObservationTaskEventPayload } from "../../dist/runtime/runtimeObservation.js";
import { buildTaskObservabilityProjection } from "../../dist/scheduler/taskObservabilityProjection.js";
import { runExecutionAudit } from "../../dist/observability/executionAudit.js";
import { renderExecutionAudit } from "../../dist/commands/executionAuditCommands.js";
import { METRICS_SCRIPT } from "../../dist/web/assets/client/ui/metrics.js";
import { TASK_VIEW_SCRIPT } from "../../dist/web/assets/client/app/taskView.js";
import { TASK_RUNTIME_SCRIPT } from "../../dist/web/assets/client/views/task/runtime.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { readTaskUsage } from "../../dist/runtime/taskUsageQuery.js";
import { taskUsageCommand } from "../../dist/commands/taskUsageCommand.js";
import { createYuiWebServer } from "../../dist/web/webServer.js";
import { coalesceRuntimeProgress } from "../../dist/controller/runtimeEventProcessor.js";
import { routeInvocation } from "../../dist/cli/invocationRouter.js";
import { createFixtureRun } from "../helpers/runFixture.mjs";
import { createConfiguredAgent } from "../../dist/agent/agent.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";

const origin = Date.parse("2026-09-13T00:00:00Z");
const at = seconds => new Date(origin + seconds * 1000).toISOString();
const task = { id: "task-1", status: "completed", createdAt: at(0), completedAt: at(30) };
let sequence = 0;
function event(kind, seconds, payload = {}, fence = {}) {
  const observation = createRuntimeObservation({
    schemaVersion: 1, eventId: `fixture-${++sequence}`, semanticKey: `fixture-${sequence}`,
    kind, authority: "provider-structured", receivedAt: at(seconds), observedAt: at(seconds),
    fence: { taskId: task.id, roleName: "leader", agentId: "codex",
      driverId: "openai/codex", nativeSessionId: "session-1", nativeTurnId: "turn-1", ...fence },
    payload
  });
  return { schemaVersion: 1, id: `event-${sequence}`, taskId: observation.fence.taskId,
    type: "runtime.observation", createdAt: at(seconds),
    payload: runtimeObservationTaskEventPayload(observation) };
}
const usage = (semantics, inputTokens, outputTokens = 0) => ({ semantics, inputTokens, outputTokens });
const token = (seconds, value, fence = {}, extra = {}) =>
  event("activity.observed", seconds, { activity: "model", usage: value, ...extra }, fence);
const project = (events, extra = {}) => projectTaskUsageMetrics({
  task, events, runs: [], now: new Date(at(30)), ...extra
});

test("Task usage preserves known zero, unknown history, replacements and exact request identity", () => {
  assert.equal(project([]).tokens.value, null);
  assert.equal(project([]).toolCalls.value, null);
  assert.equal(project([]).elapsedSeconds.value, 30, "direct Leader needs no Group or Run");
  const zero = token(1, usage("request-context", 0), {}, { activityId: "request-1" });
  assert.deepEqual([project([zero]).tokens.status, project([zero]).tokens.value], ["known", 0]);
  const events = [
    zero,
    token(2, usage("request-context", 12, 3), {}, { activityId: "request-1" }),
    token(3, usage("request-context", 12, 3), {}, { activityId: "request-1" }),
    token(4, usage("request-context", 5), { nativeSessionId: "replacement" }, { activityId: "request-1" }),
    token(5, usage("request-context", 999), { taskId: "task-2" }, { activityId: "request-1" })
  ];
  assert.equal(project(events).tokens.value, 20);
  assert.equal(project(events).sessions.length, 2);
  assert.deepEqual(project([...events].reverse()), project(events), "arrival order does not change the projection");
  const unknown = event("session.started", 6, {}, { nativeSessionId: "unobserved" });
  assert.equal(project([zero, unknown]).tokens.status, "partial");
  assert.equal(project([zero, unknown]).tokens.value, 0);
});

test("money evidence retains currency, source and estimate basis without becoming a bill", () => {
  const charge = (seconds, amount, extra = {}) => event("activity.observed", seconds, {
    activity: "model", activityId: "request-1",
    cost: { kind: "actual", semantics: "request", amount, currency: "USD",
      source: "fixture-provider", ...extra }
  });
  const actual = [charge(1, 0), charge(2, 0.25), charge(3, 0.25)];
  assert.equal(project(actual).costs.actual.amounts[0].value, 0.25);
  assert.equal(project(actual).costs.actual.amounts[0].currency, "USD");
  assert.equal(project(actual).costs.estimated.status, "unknown");
  assert.equal(project(actual).tokens.value, null, "money does not invent tokens");
  const missing = event("activity.observed", 4, {
    activity: "model", sourceId: "missing-receipt", observationQuality: "partial"
  });
  const partial = project([...actual, missing]).costs.actual;
  assert.equal(partial.amounts[0].value, 0.25, "a missing receipt does not discard a known subtotal");
  assert.equal(partial.status, "partial");
  assert.ok(partial.reasons.includes("source-coverage-partial"));
  const estimate = charge(4, 0.1, { kind: "estimated", basis: {
    model: "fixture-model", source: "fixture-price-sheet", version: "2026-01",
    scope: "input and output tokens", excluded: ["cache", "tools"]
  } });
  const result = project([...actual, estimate]);
  assert.equal(result.costs.estimated.amounts[0].value, 0.1);
  assert.equal(result.costs.actual.amounts[0].value, 0.25);
  assert.equal(result.costs.estimated.evidence[0].basis.model, "fixture-model");
  const euro = charge(5, 2, { currency: "EUR" });
  assert.deepEqual(project([...actual, euro]).costs.actual.amounts.map(({ value, currency }) => [value, currency]),
    [[2, "EUR"]], "a currency correction replaces the same request, not a second charge");
  assert.throws(() => charge(1, 1, { kind: "estimated" }), /basis/i);
  assert.throws(() => charge(1, -1), /amount/i);
  const cumulative = [
    charge(1, 4, { semantics: "cumulative-session" }),
    charge(2, 6, { semantics: "cumulative-session" })
  ];
  assert.equal(project(cumulative).costs.actual.amounts[0].value, 2);
  assert.equal(project(cumulative).costs.actual.status, "partial");
  assert.equal(project(cumulative.slice(0, 1)).costs.actual.status, "unknown");
  assert.equal(project([...cumulative, charge(3, 1, { semantics: "cumulative-session" })])
    .costs.actual.status, "unknown");
  const mirror = event("activity.observed", 6, { activity: "model", activityId: "request-1",
    cost: { kind: "actual", semantics: "request", amount: 0.25, currency: "USD", source: "fixture-provider" }
  }, { roleName: "mirror" });
  assert.equal(project([...actual, mirror]).costs.actual.status, "unknown");
  const separate = event("activity.observed", 7, { activity: "model", activityId: "request-2",
    cost: { kind: "actual", semantics: "request", amount: 0.5, currency: "USD", source: "receipt-2" } });
  assert.equal(project([...actual, separate]).costs.actual.amounts[0].value, 0.75);
  assert.equal(project([...actual, separate]).costs.actual.evidence.length, 2);
  assert.equal(project([...actual, separate, euro]).costs.actual.amounts.length, 2,
    "independent requests in different currencies remain separate");
  const replay = actual.map((entry, index) => ({ id: `inbox-${index}`, type: "runtime-observation",
    taskId: task.id, observation: JSON.parse(entry.payload.observation) }));
  assert.equal(coalesceRuntimeProgress(replay).length, 3, "cost facts must survive ingress compaction");
});

test("cross-currency request revisions retain Run attribution and source conflict checks", () => {
  const runs = [1, 2].map(n => ({ id: `run-${n}`, taskId: task.id, roleName: "worker",
    workItemId: `work-${n}`, effective: { agentId: "codex", adapterId: "codex" } }));
  const charge = (n, currency, source = "provider") => event("activity.observed", n, {
    activity: "model", activityId: "same-request",
    cost: { kind: "actual", semantics: "request", amount: 0.25, currency, source }
  }, { runId: `run-${n}`, roleName: "worker" });
  const events = [charge(1, "USD"), charge(2, "EUR")];
  assert.deepEqual(project(events, { runs }).costs.actual.amounts.map(x => x.currency), ["EUR"]);
  for (const workItemId of ["work-1", "work-2"]) {
    const cost = project(events, { runs, workItemId }).costs.actual;
    assert.equal(cost.status, "unknown");
    assert.ok(cost.reasons.includes("request-run-attribution-conflict"));
  }
  const conflict = project([events[0], charge(2, "EUR", "other-source")], { runs }).costs.actual;
  assert.equal(conflict.status, "unknown");
  assert.ok(conflict.reasons.includes("cost-source-overlap"));
});

test("usage source queries bound JSON work before projecting large histories", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-usage-bounded-sql-"));
  const store = new SqliteTaskStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  store.saveTask(createTask(task.id, "Bounded SQL", new Date(at(0))));
  const db = store.databaseHandle();
  const agent = createConfiguredAgent("codex", "codex", "false", [], [], new Date(at(0)));
  const role = createRole(task.id, "leader", [createRoleAgentBinding(agent)], agent.id, home, new Date(at(0)));
  const run = createFixtureRun(null, "run-1", task.id, "leader", "new",
    { source: { type: "yui", channel: "task-dispatch" }, directive: "Fixture", deltaRefIds: [] },
    new Date(at(0)), { effective: resolveEffectiveLaunch({ role, purpose: "execution" }) });
  const insertEvent = db.prepare("INSERT INTO events VALUES(?, ?, ?, ?, ?)");
  const insertRun = db.prepare("INSERT INTO turns VALUES(?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (let n = 1; n <= 5000; n++) {
      // Equal timestamps exercise the tie-break path, not just distinct times.
      const e = token(1, usage("request-context", 1), {}, { activityId: `request-${n}` });
      insertEvent.run(task.id, e.id, e.type, e.createdAt, JSON.stringify(e));
      const id = `run-${n}`;
      insertRun.run(task.id, id, "leader", run.status, JSON.stringify({ ...run, id }), at(1));
    }
  })();
  let projections = 0;
  db.function("usage_probe", payload => { projections++; return payload; });
  const prepare = db.prepare.bind(db);
  const plans = [];
  // Instrument the real queries at the SQLite boundary. Probe preserves the
  // payload and counts JSON inputs; no timing assertion or parallel query copy.
  db.prepare = sql => {
    if (/SELECT json_(set|object)/.test(sql)) {
      const instrumented = sql.replaceAll("json_set(payload,", "json_set(usage_probe(payload),")
        .replaceAll("json_extract(payload,", "json_extract(usage_probe(payload),");
      return { all: (...args) => {
        plans.push(...prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(row => row.detail));
        return prepare(instrumented).all(...args);
      } };
    }
    return prepare(sql);
  };
  const facts = store.readTaskUsageFacts(task.id);
  assert.equal(facts.events.length, 2000);
  assert.equal(facts.runs.length, 2000);
  assert.equal(facts.complete, false);
  assert.ok(projections <= 6 * 2001, `JSON projection processed full history: ${projections} inputs`);
  assert.ok(!plans.some(detail => /\bSCAN (events|turns)\b/.test(detail)), plans.join("\n"));
});

test("Task usage query and Web share bounded facts and explicit detail pages", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-usage-query-"));
  const store = new SqliteTaskStore(home);
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    } finally { store.close(); rmSync(home, { recursive: true, force: true }); }
  });
  store.saveTask(createTask(task.id, "Usage query", new Date(at(0))));
  const evidence = token(1, usage("request-context", 12), {}, { activityId: "request" });
  store.saveEvent(task.id, evidence);
  store.listEvents = () => { throw new Error("unbounded history must not be read"); };
  store.listRuns = () => { throw new Error("full Run reports must not be read"); };
  const summary = readTaskUsage(store, task.id, { now: new Date(at(30)) });
  assert.equal(summary.tokens.value, 12);
  assert.equal(summary.sessions.length, 0);
  assert.equal(summary.details.sessionTotal, 1);
  const cli = taskUsageCommand([task.id], store, { now: () => new Date(at(30)) }).data;
  assert.equal(routeInvocation(["task", "usage", task.id]).kind, "execute");
  assert.deepEqual(cli, summary);
  assert.equal(readTaskUsage(store, task.id, { limit: 1 }).sessions.length, 1);
  assert.equal(readTaskUsage(store, task.id, { offset: 1, limit: 1 }).sessions.length, 0);
  assert.throws(() => readTaskUsage(store, task.id, { limit: 51 }));
  server = createYuiWebServer(store, { token: "fixture-token", now: () => new Date(at(30)) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/tasks/${task.id}/usage`;
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, { headers: { "x-yui-web-token": "fixture-token" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), summary);
  store.transaction(() => {
    for (let i = 0; i < 2001; i++) {
      store.saveEvent(task.id, token(2, usage("request-context", 1), {}, { activityId: `large-${i}` }));
    }
  });
  const bounded = readTaskUsage(store, task.id);
  assert.equal(bounded.history.complete, false);
  assert.equal(bounded.tokens.status, "partial");
  assert.equal(bounded.tokens.value, 2000);
  assert.equal(bounded.sessions.length, 0);
});

test("Web usage sources load on disclosure and retain price provenance without rendering markup", async () => {
  const element = (tag, className, text) => ({
    tag, className, textContent: text == null ? "" : String(text), childNodes: [], handlers: {}, dataset: {},
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    addEventListener(name, handler) { this.handlers[name] = handler; }
  });
  const calls = [];
  const context = vm.createContext({ node: element, formatDateTime: value => value,
    document: { documentElement: { lang: "en" } },
    requestJson: async path => {
      calls.push(path);
      return { sessions: [], details: { sessionTotal: 0, actualTotal: 0, estimatedTotal: 1, nextOffset: null },
        costs: { actual: { evidence: [] }, estimated: { evidence: [{
          amount: { value: 0.1, status: "partial" }, currency: "USD", source: "<b>provider</b>",
          roleName: "leader", nativeSessionId: "native", semantics: "request",
          basis: { model: "fixture-model", source: "price-sheet", version: "v1",
            scope: "tokens", excluded: ["tools"] }
        }] } } };
    }
  });
  vm.runInContext(METRICS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const card = context.observabilityMetricCard({ cost: project([]), context: {}, dag: {} }, key => key);
  const disclosure = card.childNodes.find(child => child.tag === "details");
  assert.equal(calls.length, 0);
  disclosure.open = true;
  disclosure.handlers.toggle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /usage\?limit=20&offset=0$/u);
  const texts = node => [node.textContent, ...node.childNodes.flatMap(texts)].join(" ");
  assert.match(texts(disclosure), /<b>provider<\/b>.*fixture-model.*price-sheet@v1.*tools/u);
  assert.equal(disclosure.childNodes.at(-1).hidden, true);
  disclosure.handlers.toggle();
  assert.equal(calls.length, 1);
});

test("Web usage reads protect refresh and preserve open detail pages through Context redraw", async () => {
  const descendants = node => node.childNodes.flatMap(child => [child, ...descendants(child)]);
  const element = (tag, className, text) => ({
    tag, className, textContent: text == null ? "" : String(text), childNodes: [], handlers: {}, dataset: {},
    append(...children) { this.childNodes.push(...children); },
    replaceChildren(...children) { this.childNodes = children; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    querySelectorAll(selector) {
      return descendants(this).filter(child => selector.startsWith("details")
        ? child.tag === "details" && child.dataset.viewKey && (!selector.includes("[open]") || child.open)
        : selector === '[data-reading="true"]' && child.dataset.reading === "true");
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  });
  const calls = [], pending = [];
  const root = element("div"), viewState = {};
  const data = { task, viewState, runtime: { observability: { cost: project([]) } } };
  const context = vm.createContext({
    node: element, h: (tag, attrs, ...children) => {
      const node = element(tag); Object.assign(node.dataset, attrs?.dataset); node.append(...children); return node;
    }, formatDateTime: value => value, isEditing: () => false,
    document: { documentElement: { lang: "en" }, activeElement: null },
    card: () => { const node = element("section"); node.body = element("div"); node.append(node.body); return node; },
    emptyState: () => element("p"),
    requestJson: path => { calls.push(path); return new Promise((resolve, reject) => pending.push({ resolve, reject })); }
  });
  for (const script of [METRICS_SCRIPT, TASK_RUNTIME_SCRIPT, TASK_VIEW_SCRIPT]) {
    vm.runInContext(script.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  }
  context.renderTaskDetail = (container, detail, t) => {
    container.dataset.taskId = detail.task.id;
    container.replaceChildren(context.usageCard(detail, t));
  };
  const deps = { el: { detail: root, center: { scrollTop: 0, contains: () => false } },
    state: { detail: data }, t: key => key, locale: () => "en" };
  const disclosure = () => descendants(root).find(node => node.tag === "details");
  const text = node => [node.textContent, ...descendants(node).map(child => child.textContent)].join(" ");
  const page = (source, nextOffset) => ({
    observedThrough: at(3), sessions: [],
    details: { sessionTotal: 0, actualTotal: 21, estimatedTotal: 0, nextOffset },
    costs: { actual: { evidence: [{ source, amount: { value: 0.25, status: "known" },
      currency: "USD", roleName: "leader", nativeSessionId: "session-1", semantics: "request" }] },
    estimated: { evidence: [] } }
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  context.drawDetail(deps, {});
  disclosure().open = true;
  disclosure().handlers.toggle();
  assert.ok(context.centerIsBusy(deps), "the real Context refresh guard must protect the pending read");
  pending.shift().resolve(page("first-receipt", 20));
  await settle();
  assert.equal(!!context.centerIsBusy(deps), false);
  context.drawDetail(deps, {});
  assert.equal(disclosure().open, true);
  assert.match(text(root), /first-receipt/);
  disclosure().handlers.toggle();
  assert.equal(calls.length, 1, "redraw must use the loaded page");
  disclosure().childNodes.at(-1).handlers.click();
  assert.match(calls[1], /offset=20$/);
  pending.shift().resolve(page("second-receipt", null));
  await settle();
  context.drawDetail(deps, {});
  assert.match(text(root), /first-receipt.*second-receipt/);
  assert.equal(disclosure().childNodes.at(-1).hidden, true);
});

test("cumulative baselines never become request allocations or include pre-Task consumption", () => {
  const cumulative = [
    token(1, usage("cumulative-session", 100)),
    token(2, usage("cumulative-session", 150, 10)),
    token(3, usage("cumulative-session", 150, 10))
  ];
  assert.equal(project(cumulative).tokens.value, 60);
  assert.equal(project(cumulative).tokens.status, "partial", "nonzero first snapshot is an excluded baseline");
  assert.equal(project(cumulative.slice(0, 1)).tokens.value, null);
  assert.equal(project([
    token(0, usage("cumulative-session", 0)), ...cumulative
  ]).tokens.value, 160);
  assert.equal(project([...cumulative, token(4, usage("cumulative-session", 3))]).tokens.value, null);
  assert.equal(project([...cumulative, token(4, usage("request-context", 3), {}, { activityId: "mixed" })]).tokens.value, null);
  assert.equal(project([token(1, usage("remaining-context", 1000))]).tokens.value, null);
  assert.equal(project(cumulative, { workItemId: "work-1" }).tokens.value, null);
});

test("WorkItem attribution requires an exact Run and never counts child mirrors twice", () => {
  const run = { id: "run-1", taskId: task.id, roleName: "worker", workItemId: "work-1",
    effective: { agentId: "codex", adapterId: "codex" } };
  const fence = { roleName: "worker", runId: "run-1", nativeSessionId: "worker-session" };
  const events = [
    token(1, usage("request-context", 20), fence, { activityId: "request-1" }),
    token(2, usage("request-context", 20), { ...fence, continuationId: "child-1" }, { activityId: "request-1" }),
    token(3, usage("request-context", 7), {}, { activityId: "direct" })
  ];
  assert.equal(project(events, { runs: [run] }).tokens.value, 27);
  assert.equal(project(events, { runs: [run] }).tokens.status, "partial");
  assert.equal(project(events, { runs: [run], workItemId: "work-1" }).tokens.value, 20);
  assert.equal(project(events, { runs: [run], workItemId: "work-1" }).sessions[0].metrics.cumulativeTotal.totalTokens, 20);
  assert.equal(project(events, { runs: [], workItemId: "work-1" }).tokens.value, null);
  const conflicting = token(4, usage("request-context", 21), { ...fence, runId: "run-2" }, { activityId: "request-1" });
  assert.equal(project([...events, conflicting], { runs: [run], workItemId: "work-1" }).tokens.value, null);
  const mirror = token(5, usage("request-context", 27), { roleName: "mirror" }, { activityId: "mirror" });
  assert.equal(project([events[2], mirror]).tokens.value, null, "shared native counter is not two independent Roles");
  const alias = token(5, usage("request-context", 27), { agentId: "another-codex" }, { activityId: "alias" });
  assert.equal(project([events[2], alias]).tokens.value, null, "Agent aliases do not create another native counter");
  assert.equal(projectSessionTokenMetrics(events.slice(0, 2), {
    taskId: task.id, roleName: fence.roleName, agentId: "codex", driverId: "openai/codex",
    nativeSessionId: fence.nativeSessionId
  }).cumulativeTotal.totalTokens, 20, "Session cards exclude child mirrors too");
  const tool = { operation: "tool", operationId: "call-1" };
  const conflictingTool = [
    event("operation.started", 6, tool, fence),
    event("operation.completed", 7, tool, { ...fence, runId: "run-2" })
  ];
  assert.equal(project(conflictingTool, { runs: [run] }).toolCalls.value, 1);
  assert.equal(project(conflictingTool, { runs: [run], workItemId: "work-1" }).toolCalls.value, null);
});

test("retained tools and native intervals are partial evidence, not Group wall clock", () => {
  const turn = { nativeTurnId: "turn-1" };
  const events = [
    event("operation.started", 1, { operation: "tool", operationId: "call-1" }, turn),
    event("operation.failed", 2, { operation: "tool", operationId: "call-1" }, turn),
    event("operation.completed", 3, { operation: "tool", operationId: "call-1" }, turn),
    event("turn.accepted", 5, {}, turn),
    event("turn.completed", 15, {}, turn),
    event("turn.accepted", 5, {}, { ...turn, roleName: "worker", nativeSessionId: "session-2" }),
    event("turn.completed", 15, {}, { ...turn, roleName: "worker", nativeSessionId: "session-2" })
  ];
  const result = project(events);
  assert.equal(result.toolCalls.value, 1);
  assert.equal(result.toolCalls.status, "partial");
  assert.equal(result.executionSeconds.value, 20);
  assert.equal(result.executionSeconds.status, "partial");
  assert.equal(result.elapsedSeconds.value, 30);
  assert.equal(project([events[3]]).executionSeconds.value, null, "missing terminal cannot run forever");
  assert.equal(project([event("turn.completed", 15, {}, turn)]).executionSeconds.value, null);
  const overlapping = [
    event("turn.accepted", 10, {}, { nativeTurnId: "turn-2" }),
    event("turn.completed", 15.125, {}, { nativeTurnId: "turn-2" })
  ];
  assert.equal(project([...events, ...overlapping]).executionSeconds.value, 20.125);
  assert.equal(project([], { task: { ...task, status: "active", completedAt: undefined } }).elapsedSeconds.value, 30);
  assert.equal(project([], { task: { ...task, status: "archived" } }).elapsedSeconds.value, 30);
  assert.equal(project([], { task: { ...task, status: "cancelled", completedAt: undefined } }).elapsedSeconds.value, null);
});

test("partial boundaries, cache subsets and diagnostic values cannot fabricate totals", () => {
  const zero = token(1, usage("request-context", 0), {}, { activityId: "request-1" });
  const missing = event("activity.observed", 2, {
    activity: "model", sourceId: "missing-request", observationQuality: "partial"
  });
  assert.equal(project([zero, missing]).tokens.value, null);
  const diagnostic = token(2, usage("request-context", 999), {}, { activityId: "diagnostic" });
  const observation = JSON.parse(diagnostic.payload.observation);
  observation.authority = "diagnostic";
  diagnostic.payload = runtimeObservationTaskEventPayload(createRuntimeObservation(observation));
  assert.equal(project([zero, diagnostic]).tokens.value, 0);
  assert.equal(projectSessionTokenMetrics([zero, diagnostic], {
    taskId: task.id, roleName: "leader", agentId: "codex", driverId: "openai/codex",
    nativeSessionId: "session-1"
  }).cumulativeTotal.totalTokens, 0);
  const subsets = token(3, { ...usage("request-context", 100, 20), cachedInputTokens: 50, reasoningTokens: 10 },
    {}, { activityId: "request-1" });
  assert.equal(project([zero, subsets]).tokens.value, 120);
  const otherSession = event("session.started", 4, {}, { nativeSessionId: "missing-tokens" });
  assert.equal(project([zero, otherSession]).tokens.status, "partial");
});

test("CLI/Web cost and audit share lifetime evidence; reads never collect or write", t => {
  const home = mkdtempSync(join(tmpdir(), "yui-usage-audit-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const events = [token(1, usage("request-context", 0), {}, { activityId: "zero" })];
  const facts = { task, workItems: [], executionGroups: [], runs: [], events, now: new Date(at(30)) };
  const cost = buildTaskObservabilityProjection(facts).cost;
  const store = {
    getHomeIdentity: () => ({ homeId: "fixture" }), listTasks: () => [task],
    getTask: id => id === task.id ? task : null, listEvents: id => id === task.id ? events : [],
    listRuns: () => []
  };
  const report = runExecutionAudit(home, { taskId: task.id, since: new Date(at(10)), until: new Date(at(20)) },
    { openStore: () => store, directorySize: () => 0 });
  assert.equal(report.usage.status, "ok");
  for (const key of ["tokens", "toolCalls", "elapsedSeconds", "executionSeconds", "coverage", "sessions"]) {
    assert.deepEqual(report.usage.data[0][key], cost[key]);
  }
  assert.match(renderExecutionAudit(report), /Task lifetime.*audit time window not applied/u);
  assert.match(renderExecutionAudit(report), /tokens=0; tools=unknown/u);

  // Execute the actual shipped DOM builder, not a parallel formatter.
  const node = (_tag, _className, text) => ({
    textContent: text == null ? "" : String(text), childNodes: [],
    append(...children) { this.childNodes.push(...children); }
  });
  const context = vm.createContext({ node, formatDateTime: value => value });
  vm.runInContext(METRICS_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  const translate = key => key === "detail.unobserved" ? "unknown" : key;
  const card = context.observabilityMetricCard({ cost, context: {}, dag: {} }, translate);
  const texts = element => [element.textContent, ...element.childNodes.flatMap(texts)];
  const visible = texts(card).join(" ");
  assert.match(visible, /unknown/u);
  assert.doesNotMatch(visible, /0\*|undefineds|\[object Object\]/u);
  assert.equal(context.usageMetricText(cost.tokens, translate), "0");
  assert.match(context.usageMetricText({ value: 0, status: "partial" }, translate), /0.*partial/u);
  assert.equal(events.length, 1);
});
