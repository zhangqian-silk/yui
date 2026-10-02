import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAgent } from '../../dist/nativeAgent/index.js';
import { createModelGateway, createChatCompletionsAdapter, ModelGatewayError } from '../../dist/nativeAgent/model/index.js';

const request = {
  sessionId: 's', turnId: 't', step: 1,
  messages: [{ role: 'user', content: 'hello' }],
  tools: [{ name: 'read', description: 'read text', inputSchema: { type: 'object' } }],
};
const usage = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };
const final = { choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }], usage };
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const stream = frame(chunk({ role: 'assistant', content: '你好' }))
  + frame(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }))
  + frame(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a"}' } }] }, 'tool_calls'))
  + frame({ choices: [], usage }) + 'data: [DONE]\r\n\r\n';
const opts = { endpoint: 'http://127.0.0.1:1/chat/completions', model: 'fixture', account: { kind: 'none' } };
const jsonResponse = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const gateway = (transport, extra = {}) => createModelGateway({ ...opts, transport, ...extra });
const signal = () => new AbortController().signal;

test('model gateway: real loopback HTTP mapping, fragmented SSE and complete-only kernel handoff', { timeout: 5000 }, async t => {
  const seen = [];
  let heldClose;
  const heldClosed = new Promise(resolve => { heldClose = resolve; });
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    seen.push({ headers: req.headers, body: JSON.parse(text), url: req.url });
    if (seen.at(-1).body.messages[0].content === 'hold') {
      res.on('close', heldClose);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(frame(chunk({ content: 'started' })));
      return;
    }
    if (seen.at(-1).body.messages[0].content === 'redirect') {
      res.writeHead(307, { location: '/other' }); res.end(); return;
    }
    if (seen.at(-1).body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from(stream);
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      res.end();
    } else res.end(JSON.stringify(final));
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}/chat/completions`;
  const plain = createModelGateway({ ...opts, endpoint, account: { kind: 'bearer', token: 'fixture-only' } });
  const result = await plain.generate(request, signal());
  assert.deepEqual(result.response, { kind: 'final', content: '你好' });
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3, totalTokens: 8 });
  assert.equal(seen[0].headers.authorization, 'Bearer fixture-only');
  assert.equal(seen[0].body.model, 'fixture');
  assert.equal(seen[0].body.store, false);
  assert.equal(seen[0].body.tools[0].function.name, 'read');
  const observations = [];
  const streamed = createModelGateway({ ...opts, endpoint, stream: true, onObservation: e => observations.push(e) });
  const calls = await streamed.generate(request, signal());
  assert.deepEqual(calls.response, { kind: 'tool_calls', content: '你好', calls: [{ id: 'c1', name: 'read', arguments: { path: 'a' } }] });
  assert.equal(observations.some(e => e.data.type === 'text_delta'), true);
  assert.equal(observations.every(e => e.sessionId === 's' && e.turnId === 't' && e.step === 1), true);
  assert.deepEqual(calls.usage, result.usage);
  const history = [...request.messages,
    { role: 'assistant', content: '', toolCalls: calls.response.calls },
    { role: 'tool', toolCallId: 'c1', name: 'read', outcome: { ok: false, error: { code: 'missing', message: 'Absent', effect: 'none' } } }];
  await plain.complete({ ...request, messages: history }, signal());
  assert.equal(seen[2].body.messages[1].tool_calls[0].function.arguments, '{"path":"a"}');
  assert.equal(seen[2].body.messages[2].tool_call_id, 'c1');
  assert.equal(JSON.parse(seen[2].body.messages[2].content).error.effect, 'none');
  const controller = new AbortController();
  const cancellable = createModelGateway({ ...opts, endpoint, stream: true, onObservation: () => controller.abort() });
  await assert.rejects(cancellable.generate({
    ...request, messages: [{ role: 'user', content: 'hold' }],
  }, controller.signal), e => e.code === 'cancelled');
  await heldClosed;
  await assert.rejects(plain.generate({
    ...request, messages: [{ role: 'user', content: 'redirect' }],
  }, signal()), e => e.code === 'transport');
  assert.equal(seen.length, 5, 'redirect must not send a second request');
});

test('model gateway: malformed/truncated replies never become executable calls or retry unknown effects', async () => {
  const badCalls = args => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: {
    role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: args } }],
  } }] });
  const bad = [
    [false, JSON.stringify(badCalls('{'))],
    [false, JSON.stringify(badCalls('[]'))],
    [false, JSON.stringify({ ...final, choices: [{ ...final.choices[0], finish_reason: 'length' }] })],
    [true, stream.replace('data: [DONE]\r\n\r\n', '')],
    [true, frame(chunk({ content: 'partial' })) + 'data: [DONE]\n\n'],
    [true, frame({ error: { message: 'secret', code: 'rate_limit_exceeded' } })],
    [true, frame({ ...chunk({ content: 'first' }), id: 'a' })
      + frame({ ...chunk({}, 'stop'), id: 'b' }) + 'data: [DONE]\n\n'],
  ];
  for (const [streaming, body] of bad) {
    let attempts = 0, executions = 0;
    const provider = gateway(async () => { attempts++; return new Response(body); }, { stream: streaming });
    const agent = createAgent({ provider, tools: [{ definition: request.tools[0], validate: () => null,
      execute: async () => { executions++; return { ok: true, content: 'bad' }; } }] });
    const result = await agent.runTurn({ sessionId: 's', turnId: 't', input: 'x', maxSteps: 1 });
    assert.equal(result.reason, 'error');
    assert.equal(executions, 0);
    assert.equal(attempts, 1);
  }
});

test('model gateway: retry classification, server wait hints, attempt/time limits and redaction', async () => {
  let count = 0, now = 0;
  const waits = [];
  const clock = { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } };
  const rate = { error: { code: 'rate_limit_exceeded', message: 'secret' } };
  const provider = gateway(async () => ++count < 3
    ? jsonResponse(rate, 429, { 'retry-after': '1' }) : jsonResponse(final),
  { clock, retry: { maxAttempts: 3, maxElapsedMs: 5000, baseDelayMs: 10 } });
  assert.equal((await provider.generate(request, signal())).attempts.length, 3);
  assert.deepEqual(waits, [1000, 1000]);
  for (const [status, body, expected] of [
    [401, rate, 'authentication'], [403, rate, 'authentication'],
    [429, { error: { code: 'insufficient_quota' } }, 'quota'],
    [429, { error: { code: 'unknown', type: 'rate_limit_error' } }, 'http'],
    [429, { error: { code: 'rate_limit_exceeded', type: 'insufficient_quota' } }, 'quota'],
    [429, { error: { code: 'rate_limit_exceeded', type: 'authentication_error' } }, 'authentication'],
    [503, rate, 'http'],
  ]) {
    count = 0;
    await assert.rejects(gateway(async () => { count++; return jsonResponse(body, status); }).generate(request, signal()),
      error => error.code === expected && !JSON.stringify(error).includes('secret'));
    assert.equal(count, 1);
  }
  count = 0;
  await assert.rejects(gateway(async () => { count++; return jsonResponse(rate, 429); },
    { clock, retry: { maxAttempts: 2, maxElapsedMs: 5000, baseDelayMs: 10 } }).generate(request, signal()),
  e => e.code === 'rate_limit' && e.attempts.length === 2 && e.stopReason === 'attempt_limit');
  assert.equal(count, 2);
  count = 0;
  await assert.rejects(gateway(async () => { count++; return jsonResponse(rate, 429, { 'retry-after': '99' }); },
    { clock, retry: { maxAttempts: 3, maxElapsedMs: 100, baseDelayMs: 10 } }).generate(request, signal()),
  e => e.code === 'rate_limit' && e.stopReason === 'time_limit');
  assert.equal(count, 1);
  await assert.rejects(gateway(async () => { throw new Error('Bearer fixture-only https://secret'); }).generate(request, signal()),
    e => e.code === 'transport' && e.effect === 'unknown' && !`${e}${JSON.stringify(e)}`.includes('secret'));
});

test('model gateway: cancellation settles readers, pre-abort avoids sends, observer failure is nonfatal', async () => {
  let sent = 0, closed = 0;
  const controller = new AbortController();
  controller.abort('secret');
  await assert.rejects(gateway(async () => { sent++; return jsonResponse(final); }).generate(request, controller.signal),
    e => e.code === 'cancelled');
  assert.equal(sent, 0);
  const during = new AbortController();
  const body = new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frame(chunk({ content: 'partial' })))); },
    cancel() { closed++; },
  });
  await assert.rejects(gateway(async () => new Response(body), {
    stream: true, onObservation: () => during.abort(),
  }).generate(request, during.signal), e => e.code === 'cancelled');
  assert.equal(closed, 1);
  const successful = await gateway(async () => new Response(stream), {
    stream: true, onObservation: async () => { throw new Error('display gone'); },
  }).generate(request, signal());
  assert.equal(successful.response.kind, 'tool_calls');
  assert.equal((await gateway(async () => jsonResponse({ choices: final.choices })).generate(request, signal())).usage, undefined);
  assert.equal(typeof createChatCompletionsAdapter, 'function');
});

test('model gateway: replaceable adapters cannot replay successful HTTP, leak bodies, or bypass call validation', async () => {
  let closed = 0, sent = 0;
  const adapter = createChatCompletionsAdapter();
  const transport = async () => {
    sent++;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data')); },
      cancel() { closed++; },
    }));
  };
  await assert.rejects(gateway(transport, {
    adapter: { ...adapter, decode: async body => {
      await body[Symbol.asyncIterator]().next();
      throw new ModelGatewayError('rate_limit', 'none');
    } },
  }).generate(request, signal()), e => e.code === 'rate_limit' && e.effect === 'unknown');
  assert.equal(sent, 1);
  assert.equal(closed, 1);
  for (const calls of [
    [{ id: 'x', name: 'unregistered', arguments: {} }],
    [{ id: 'x', name: 'read', arguments: {} }, { id: 'x', name: 'read', arguments: {} }],
    [{ id: 'x', name: 'read', arguments: { x: Infinity } }],
  ]) {
    await assert.rejects(gateway(transport, {
      adapter: { ...adapter, decode: async () => ({ response: { kind: 'tool_calls', content: '', calls } }) },
    }).generate(request, signal()), e => e.code === 'protocol');
  }
  assert.equal(closed, 4);
  const bytes = Buffer.from(stream);
  let offset = 0;
  const split = new ReadableStream({ pull(c) {
    if (offset === bytes.length) c.close();
    else c.enqueue(bytes.subarray(offset, ++offset));
  } });
  assert.equal((await gateway(async () => new Response(split), { stream: true }).complete(request, signal())).content, '你好');
});

test('model gateway: total deadline and cancellation during backoff settle without another attempt', async () => {
  let sent = 0, aborted = 0;
  await assert.rejects(gateway(async (_url, init) => {
    sent++;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted++; reject(new Error('private transport error'));
    }, { once: true }));
  }, { retry: { maxElapsedMs: 20 } }).generate(request, signal()), e => e.code === 'deadline' && e.attempts.length === 1);
  assert.equal(sent, 1);
  assert.equal(aborted, 1);
  const controller = new AbortController();
  sent = 0;
  await assert.rejects(gateway(async () => {
    sent++; return jsonResponse({ error: { code: 'rate_limit_exceeded' } }, 429);
  }, { onObservation: event => { if (event.data.type === 'retry') controller.abort(); } })
    .generate(request, controller.signal), e => e.code === 'cancelled' && e.attempts[0].outcome === 'rate_limit');
  assert.equal(sent, 1);
  assert.throws(() => createModelGateway({ ...opts, endpoint: 'https://user:secret@example.com' }),
    e => e.code === 'configuration' && !String(e).includes('secret'));
  await assert.rejects(gateway(async () => { throw new Error('must not send'); }).generate({
    ...request, messages: [{ role: 'tool', toolCallId: 'x', name: 'read', outcome: { ok: true, content: '' } }],
  }, signal()), e => e.code === 'request' && e.effect === 'none');
});
