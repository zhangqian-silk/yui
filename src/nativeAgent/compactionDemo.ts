import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, createContextBuilder, createProviderCompressor, createModelGateway,
  createSessionStore, createSqliteSessionBackend, createExecutionOwner, createTextTools,
  type ModelTransport, type SessionStore, type ExecutionOwner, type TurnResult, type ContextReport,
  type Message } from './index.js';
import type { SessionSnapshot } from './session/index.js';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Only model responses are fixtures. Real gateway, kernel, tools, SQLite and owner remain in the path. */
export async function runCompactionDemo() {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-compaction-demo-'));
  let store: SessionStore | undefined, owner: ExecutionOwner | undefined;
  let summaryCalls = 0, codingCalls = 0, compressedRequests = 0;
  const observedSummaryBytes: number[] = [];
  const observedSourceBytes: number[] = [];
  const codingProjections: (string | undefined)[] = [];
  const sessionId = 'long-session';
  const verifySources = (serialized: string, report: ContextReport, full: readonly Message[]) => {
    const summary = JSON.parse(serialized).contextSummary;
    const selected = report.entries.filter(entry => entry.action === 'summarized');
    assert.equal(summary.historyDigest, report.historyDigest);
    assert.equal(summary.digest, digest(selected.map(entry => entry.digest)));
    assert.equal(summary.sources.provenanceDigest,
      digest(selected.map(({ action: _action, reason: _reason, ...entry }) => entry)));
    const span = summary.sources.history;
    assert.equal(span.rangeKind, 'enclosing');
    assert.equal(span.digest, digest(full.slice(...span.historyRange)));
    const outcomes = selected.flatMap(entry => entry.toolOutcomes ?? []);
    assert.deepEqual(summary.sources.toolSettlements, {
      representation: 'aggregate-only', succeeded: outcomes.filter(outcome => outcome.ok).length,
      failedWithoutEffect: outcomes.filter(outcome => !outcome.ok && outcome.effect === 'none').length,
      digest: digest(outcomes),
    });
    const bytes = Buffer.byteLength(JSON.stringify(summary.sources));
    assert.ok(bytes < 1500);
    observedSourceBytes.push(bytes);
  };
  const verifyTurn = (before: SessionSnapshot, result: TurnResult) => {
    for (const { report } of result.contextReports) {
      assert.ok(report.estimatedInput <= report.availableInput);
      assert.equal(report.baseReceipt!.digest, before.digest);
      const full = [...before.messages, ...result.messages].slice(0,
        Math.max(...report.entries.filter(e => e.historyRange).map(e => e.historyRange![1])));
      assert.equal(report.historyDigest, digest(full));
      for (const entry of report.entries) if (entry.historyRange)
        assert.equal(entry.digest, digest(full.slice(...entry.historyRange)));
      const serialized = codingProjections.shift();
      if (serialized) verifySources(serialized, report, full);
      else assert.ok(report.entries.every(entry => entry.action !== 'summarized'));
    }
  };
  try {
    await writeFile(path.join(root, 'input.txt'), 'Selected workspace evidence.\n'.repeat(30));
    const transport: ModelTransport = async (_endpoint, init) => {
      const wire = JSON.parse(init.body);
      const isSummary = wire.messages[0]?.content.startsWith('Summarize coding-session data');
      let content: string, toolCalls;
      if (isSummary) {
        summaryCalls++;
        assert.equal(wire.tools?.length ?? 0, 0);
        // The adapter adds its own wire overhead, which the JSON-byte fixture does not call tokens.
        observedSummaryBytes.push(Buffer.byteLength(init.body));
        content = 'Workspace reads confirmed. Preserve API; never publish. Continue coding from saved original facts.';
      } else {
        codingCalls++;
        codingProjections.push(wire.messages.find((message: { content: string }) =>
          typeof message.content === 'string' && message.content.includes('"contextSummary":'))?.content);
        assert.ok(wire.messages.some((m: { content: string }) => m.content.includes('Goal: preserve API; never publish')));
        assert.ok(wire.messages.some((m: { role: string; content: string }) =>
          m.role === 'system' && m.content.includes('Trusted project guidance')));
        for (const message of wire.messages) {
          if (typeof message.content !== 'string' || !message.content.includes('"contextSummary":')) continue;
          const summary = JSON.parse(message.content).contextSummary;
          assert.equal(summary.trust, 'data');
          compressedRequests++;
        }
        const last = wire.messages.at(-1);
        if (last.role === 'user') {
          content = 'Read the explicitly selected file.';
          toolCalls = [{ id: `read-${codingCalls}`, type: 'function',
            function: { name: 'read', arguments: '{"path":"input.txt"}' } }];
        } else {
          assert.equal(last.role, 'tool');
          assert.equal(JSON.parse(last.content).ok, true);
          content = 'Read confirmed; detailed intermediate progress. '.repeat(65);
        }
      }
      return new Response(JSON.stringify({ choices: [{ index: 0,
        finish_reason: toolCalls ? 'tool_calls' : 'stop',
        message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
      }] }));
    };
    const gateway = createModelGateway({ endpoint: 'https://offline.invalid/chat', model: 'fixture',
      account: { kind: 'none' }, transport });
    const compressor = createProviderCompressor({ id: 'provider-summary-v1', provider: gateway,
      budget: { capacity: 6500, reserveOutput: 500 }, maxSummaryBytes: 500, maxCalls: 32 });
    const context = createContextBuilder({ compressor, sources: [{ id: 'explicit-guide', async load() {
      return [{ id: 'guide', kind: 'guidance' as const, content: 'Trusted project guidance: bounded edits only.',
        source: 'demo-guide', revision: 'v1', required: true }];
    } }] });
    const tools = createTextTools({ root }).filter(t => t.definition.name === 'read');
    const budget = { capacity: 14_000, reserveOutput: 1000, reserveTools: 500 };
    const filename = path.join(root, 'sessions.sqlite');
    store = createSessionStore(createSqliteSessionBackend(filename));
    await store.create(sessionId);
    owner = createExecutionOwner({ store, maxSteps: 2,
      context: { builder: context, budget, tools: tools.map(t => t.definition) },
      agent: recording => createAgent({ tools, recorder: recording, provider: gateway,
        contextBuilder: context, contextBudget: budget }),
    });
    for (let i = 0; i < 8; i++) {
      const before: SessionSnapshot = await store.load(sessionId);
      await owner.submit(sessionId, i === 0 ? 'Goal: preserve API; never publish' : `Continue coding: ${i}`);
      const result: TurnResult = (await owner.settle(sessionId))!.result!;
      assert.equal(result.reason, 'completed', result.error?.message);
      const saved: SessionSnapshot = await store.load(sessionId);
      assert.deepEqual(saved.document.events.slice(0, before.document.events.length), before.document.events);
      assert.deepEqual(saved.messages.slice(0, before.messages.length), before.messages);
      assert.equal(saved.recovery.disposition, 'ready');
      verifyTurn(before, result);
    }
    const beforeManual = await store.load(sessionId);
    const manual = await owner.compact(sessionId);
    assert.ok(manual.report.entries.some(e => e.action === 'summarized'));
    const manualSummary = manual.request.messages.flatMap(message =>
      'content' in message && message.content.includes('"contextSummary":') ? [message.content] : [])[0];
    assert.ok(manualSummary);
    verifySources(manualSummary, manual.report, beforeManual.messages);
    assert.deepEqual(await store.load(sessionId), beforeManual);
    await owner.submit(sessionId, 'Continue after manual compact');
    const continued = (await owner.settle(sessionId))!.result!;
    assert.equal(continued.reason, 'completed');
    verifyTurn(beforeManual, continued);
    assert.equal(codingProjections.length, 0);
    const saved = await store.load(sessionId);
    assert.equal(saved.recovery.calls.length, 9);
    assert.ok(saved.recovery.calls.every(c => c.status === 'settled' && c.outcome?.ok));
    assert.ok(summaryCalls >= 2);
    assert.ok(compressedRequests >= 2);
    await owner.close();
    await store.close();
    store = createSessionStore(createSqliteSessionBackend(filename));
    assert.equal((await store.load(sessionId)).digest, saved.digest);
    return { turns: 9, summaryCalls, compressedRequests, codingCalls, verifiedToolPairs: 9,
      immutableHistory: true, provenanceVerified: true, sqliteRestartVerified: true,
      largestSummaryWireBytes: Math.max(...observedSummaryBytes),
      largestSourceMetadataBytes: Math.max(...observedSourceBytes),
      validation: 'offline fixture responses; not real-model summary quality' };
  } finally {
    await owner?.close();
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await runCompactionDemo(), null, 2));
