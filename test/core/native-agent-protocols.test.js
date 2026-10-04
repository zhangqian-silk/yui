import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createAgent } from '../../dist/nativeAgent/index.js';
import { createModelGateway, createResponsesAdapter, getProtocolCapabilities } from '../../dist/nativeAgent/model/index.js';
import { createLocalObserver } from '../../dist/nativeAgent/observability/index.js';
import { connectModelObservations } from '../../dist/nativeAgent/composition.js';

const request = {
  sessionId: 's', turnId: 't', step: 1,
  messages: [{ role: 'system', content: 'guide' }, { role: 'user', content: 'hello' }],
  tools: [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }],
};
const options = { endpoint: 'http://127.0.0.1:1/explicit', model: 'fixture', account: { kind: 'none' } };
const signal = () => new AbortController().signal;
const textItem = { type: 'message', id: 'm1', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: '你好', annotations: [] }] };
const responsesFinal = { id: 'r1', status: 'completed', output: [textItem] };
const messagesFinal = { id: 'm1', type: 'message', role: 'assistant', stop_reason: 'end_turn',
  content: [{ type: 'text', text: '你好' }], usage: { input_tokens: 5, output_tokens: 3,
    cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } };
const calls = ['c1', 'c2'].map((id, i) => ({ id, name: 'read', arguments: { path: `${i}` } }));
const functionItems = calls.map(c => ({ id: `item-${c.id}`, type: 'function_call', status: 'completed',
  call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }));
const responsesTools = { ...responsesFinal, output: [textItem, ...functionItems],
  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } };
const messagesTools = { ...messagesFinal, stop_reason: 'tool_use',
  content: [messagesFinal.content[0], ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }))] };
const frame = (type, fields = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...fields })}\r\n\r\n`;
function responsesStream(root) {
  const initial = { id: root.id, status: 'in_progress', output: [] };
  let out = frame('response.created', { response: initial })
    + frame('response.in_progress', { response: initial });
  for (const [i, item] of root.output.entries()) {
    out += frame('response.output_item.added', { output_index: i,
      item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
  }
  for (const [i, item] of root.output.entries()) {
    const refs = { output_index: i, item_id: item.id };
    if (item.type === 'message') {
      out += frame('response.content_part.added', { ...refs, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
        + frame('response.output_text.delta', { ...refs, content_index: 0, delta: '你好' })
        + frame('response.output_text.done', { ...refs, content_index: 0, text: '你好' })
        + frame('response.content_part.done', { ...refs, content_index: 0, part: item.content[0] });
    } else {
      out += frame('response.function_call_arguments.delta', { ...refs, delta: item.arguments.slice(0, 4) })
        + frame('response.function_call_arguments.delta', { ...refs, delta: item.arguments.slice(4) })
        + frame('response.function_call_arguments.done', { ...refs, arguments: item.arguments });
    }
    out += frame('response.output_item.done', { output_index: i, item });
  }
  let sequence = 0;
  return (out + frame('response.completed', { response: root }))
    .replace(/data: (.+)\r\n/g, (_match, json) =>
      `data: ${JSON.stringify({ ...JSON.parse(json), sequence_number: sequence++ })}\r\n`);
}
function messagesStream(root) {
  let out = frame('message_start', { message: { ...root, stop_reason: null, content: [],
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } });
  for (const [i, block] of root.content.entries()) {
    out += frame('content_block_start', { index: i,
      content_block: { ...block, ...(block.type === 'text' ? { text: '' } : { input: {} }) } });
    if (block.type === 'text') out += frame('content_block_delta', { index: i, delta: { type: 'text_delta', text: block.text } });
    else {
      const json = JSON.stringify(block.input);
      out += frame('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: json.slice(0, 4) } })
        + frame('content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: json.slice(4) } });
    }
    out += frame('content_block_stop', { index: i });
  }
  return out + frame('message_delta', { delta: { stop_reason: null, stop_sequence: null }, usage: { output_tokens: 2 } })
    + frame('message_delta', { delta: { stop_reason: root.stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } })
    + frame('message_stop');
}
const fixture = {
  responses: { final: responsesFinal, tools: responsesTools, stream: responsesStream },
  'anthropic-messages': { final: messagesFinal, tools: messagesTools, stream: messagesStream },
};
function fragmented(source) {
  const bytes = Buffer.from(source);
  return new ReadableStream({ start(c) {
    for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7));
    c.close();
  } });
}

test('native protocols: explicit selection, request mapping and absent/native usage', async () => {
  for (const protocol of ['responses', 'anthropic-messages']) {
    let sent;
    const gateway = createModelGateway({ ...options, protocol, generation: { maxOutputTokens: 20 },
      transport: async (_endpoint, init) => {
        sent = JSON.parse(init.body);
        return new Response(JSON.stringify(protocol === 'responses' ? responsesFinal : messagesFinal));
      } });
    const result = await gateway.generate(request, signal());
    assert.deepEqual(result.response, { kind: 'final', content: '你好' });
    if (protocol === 'responses') {
      assert.equal(sent.store, false);
      assert.equal(sent.truncation, 'disabled');
      assert.equal(sent.max_output_tokens, 20);
      assert.equal(sent.tools[0].strict, false);
      assert.equal(sent.input[0].role, 'system');
      assert.equal(result.usage, undefined);
    } else {
      assert.equal(sent.system[0].text, 'guide');
      assert.equal(sent.max_tokens, 20);
      assert.deepEqual(sent.tools[0].input_schema, request.tools[0].inputSchema);
      assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 3,
        cachedInputTokens: 2, cacheWriteInputTokens: 1 });
    }
    assert.equal(gateway.profile.protocol, protocol);
    assert.equal(gateway.profile.capacity, undefined);
  }
});

test('Responses: caller-owned assistant history uses input messages, not fabricated output items', async () => {
  let sent;
  const provider = createModelGateway({ ...options, protocol: 'responses',
    transport: async (_endpoint, init) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify(responsesFinal));
    } });
  await provider.generate({ ...request, messages: [
    ...request.messages,
    { role: 'assistant', content: 'previous answer', toolCalls: [] },
    { role: 'user', content: 'follow up' },
  ] }, signal());
  // Official EasyInputMessage accepts string/input content. ResponseOutputMessage
  // needs a real item ID/status; the kernel does not retain or invent those IDs.
  assert.deepEqual(sent.input[2], { role: 'assistant', content: 'previous answer' });
});

test('Responses: unsupported execution contexts and assistant phases cannot become local calls/history', async () => {
  for (const patch of [{ async: true }, { namespace: 'external' },
    { caller: { type: 'program', caller_id: 'p1' } }, { unrecognized_context: 'external' }]) {
    for (const stream of [false, true]) {
      let sends = 0;
      const root = { ...responsesTools, output: [textItem, { ...functionItems[0], ...patch }] };
      const provider = createModelGateway({ ...options, protocol: 'responses', stream,
        transport: async () => { sends++; return new Response(stream ? responsesStream(root) : JSON.stringify(root)); } });
      await assert.rejects(provider.generate(request, signal()), e => e.code === 'protocol' && e.effect === 'unknown');
      assert.equal(sends, 1);
    }
  }
  const provider = createModelGateway({ ...options, protocol: 'responses',
    transport: async () => new Response(JSON.stringify({
      ...responsesFinal, output: [{ ...textItem, phase: 'commentary' }],
    })) });
  await assert.rejects(provider.generate(request, signal()), e => e.code === 'protocol');
});

test('native protocols: known in-band errors stay classified but never authorize replay', async () => {
  for (const protocol of Object.keys(fixture)) {
    for (const [type, code] of [['authentication_error', 'authentication'],
      [protocol === 'responses' ? 'rate_limit_exceeded' : 'rate_limit_error', 'rate_limit'],
      ['unrecognized_error', 'incomplete']]) {
      let sends = 0;
      const provider = createModelGateway({ ...options, protocol, stream: true, generation: { maxOutputTokens: 20 },
        transport: async () => {
          sends++;
          return new Response(frame('error', protocol === 'responses'
            ? { code: type, message: 'dummy-only' }
            : { error: { type, message: 'dummy-only' } }));
        } });
      await assert.rejects(provider.generate(request, signal()), e => e.code === code
        && e.effect === 'unknown' && !`${e}${JSON.stringify(e)}`.includes('dummy-only'));
      assert.equal(sends, 1);
    }
  }
});

test('native protocols: loopback JSON/SSE multi-tool turn preserves every input/output pair', { timeout: 5000 }, async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text), protocol = req.url.slice(1);
    seen.push({ protocol, body, headers: req.headers });
    const paired = protocol === 'responses' ? body.input.some(m => m.type === 'function_call_output')
      : body.messages.some(m => m.content.some(b => b.type === 'tool_result'));
    const f = fixture[protocol], value = paired ? f.final : f.tools;
    res.setHeader(protocol === 'responses' ? 'x-request-id' : 'request-id', 'fixture-remote-id');
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    const bytes = Buffer.from(body.stream ? f.stream(value) : JSON.stringify(value));
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const protocol of Object.keys(fixture)) for (const stream of [false, true]) {
    const executed = [], observations = [], executionsAtDelta = [];
    const provider = createModelGateway({ ...options, protocol, stream, generation: { maxOutputTokens: 20 },
      endpoint: `http://127.0.0.1:${server.address().port}/${protocol}`,
      account: { kind: protocol === 'responses' ? 'bearer' : 'api-key', token: 'dummy-only' },
      onObservation: e => { observations.push(e); if (e.data.type === 'tool_delta') executionsAtDelta.push(executed.length); } });
    const agent = createAgent({ provider, tools: [{ definition: request.tools[0], validate: () => null,
      execute: async args => { executed.push(args.path); return args.path === '0' ? { ok: true, content: 'read' }
        : { ok: false, error: { code: 'missing', message: 'Absent', effect: 'none' } }; } }] });
    const turn = await agent.runTurn({ sessionId: 's', turnId: 't', input: 'hello',
      history: [request.messages[0]], maxSteps: 2 });
    assert.equal(turn.reason, 'completed');
    assert.deepEqual(executed, ['0', '1']);
    assert.equal(executionsAtDelta.every(n => n === 0), true, 'partial calls cannot start tools');
    assert.deepEqual(turn.messages.filter(m => m.role === 'tool').map(m => m.toolCallId), ['c1', 'c2']);
    const sent = seen.at(-1);
    if (protocol === 'responses') {
      const outputs = sent.body.input.filter(m => m.type === 'function_call_output');
      assert.deepEqual(outputs.map(m => m.call_id), ['c1', 'c2']);
      assert.equal(JSON.parse(outputs[1].output).error.effect, 'none');
      assert.equal(sent.headers.authorization, 'Bearer dummy-only');
    } else {
      const blocks = sent.body.messages.flatMap(m => m.content).filter(m => m.type === 'tool_result');
      assert.deepEqual(blocks.map(b => b.tool_use_id), ['c1', 'c2']);
      assert.equal(blocks[1].is_error, true);
      assert.equal(sent.headers['x-api-key'], 'dummy-only');
      assert.equal(sent.headers['anthropic-version'], '2023-06-01');
      assert.equal(sent.headers.authorization, undefined);
    }
    const attempts = observations.filter(e => e.data.type === 'attempt_finished');
    assert.equal(attempts[0].data.record.providerRequestId, 'fixture-remote-id');
    assert.equal(attempts[0].data.record.usage.inputTokens, 5);
    assert.equal(attempts[0].data.record.usage.cachedInputTokens, 2);
    assert.equal(attempts[0].data.record.usage.cacheWriteInputTokens, 1);
    if (protocol === 'anthropic-messages') {
      assert.equal(attempts[0].data.record.usage.totalTokens, undefined);
      assert.equal(attempts[0].data.record.usage.outputTokens, 3, 'cumulative updates are not summed');
    }
  }
});

test('native protocols: native terminal and associations fail closed without executing or replaying', async () => {
  for (const [protocol, f] of Object.entries(fixture)) {
    const stream = f.stream(f.tools);
    const bad = [
      [false, JSON.stringify({ ...f.tools, ...(protocol === 'responses' ? { status: 'incomplete' } : { stop_reason: 'max_tokens' }) })],
      [false, JSON.stringify(protocol === 'responses' ? { ...f.tools, output: [functionItems[0], functionItems[0]] }
        : { ...f.tools, content: [messagesTools.content[1], messagesTools.content[1]] })],
      [true, stream.slice(0, stream.lastIndexOf(protocol === 'responses' ? 'event: response.completed' : 'event: message_stop'))],
      [true, stream.replace(protocol === 'responses' ? '"item_id":"item-c1"' : '"index":0', protocol === 'responses' ? '"item_id":"wrong"' : '"index":99')],
      [true, stream.replace(protocol === 'responses' ? '"type":"function_call"' : '"type":"tool_use"', '"type":"thinking"')],
      [true, frame('error', { error: { message: 'dummy-only', type: 'rate_limit_error' } })],
      [true, stream.replace(protocol === 'responses' ? '"sequence_number":1' : 'event: message_stop',
        protocol === 'responses' ? '"sequence_number":9' : 'event: message_delta')],
    ];
    for (const [streaming, body] of bad) {
      let sends = 0, executions = 0;
      const provider = createModelGateway({ ...options, protocol, stream: streaming, generation: { maxOutputTokens: 20 },
        transport: async () => { sends++; return new Response(fragmented(body)); } });
      const agent = createAgent({ provider, tools: [{ definition: request.tools[0], validate: () => null,
        execute: async () => { executions++; return { ok: true, content: 'bad' }; } }] });
      const turn = await agent.runTurn({ sessionId: 's', turnId: 't', input: 'x', maxSteps: 1 });
      assert.equal(turn.reason, 'error', `${protocol}: ${body}`);
      assert.equal(executions, 0);
      assert.equal(sends, 1);
    }
  }
});

test('native protocols: explicit model bounds, unsupported parameters and history reject before sending', async () => {
  assert.deepEqual(getProtocolCapabilities('responses'), { text: true, functionTools: true, streaming: true });
  for (const extra of [
    { protocol: 'unknown' }, { protocol: 'anthropic-messages' },
    { protocol: 'responses', adapter: { ...createResponsesAdapter(), protocol: 'chat-completions' } },
    { protocol: 'responses', account: { kind: 'api-key', token: 'dummy' } },
    { protocol: 'responses', generation: { reasoning: 'high' } },
    { protocol: 'responses', generation: { maxOutputTokens: 21 }, capacity: { maxOutputTokens: 20 } },
    { protocol: 'responses', capacity: { contextWindowTokens: -1 } },
    { protocol: 'responses', modelCapabilities: { streaming: false }, stream: true },
    { protocol: 'responses', cache: true },
  ]) assert.throws(() => createModelGateway({ ...options, ...extra }), e => e.code === 'configuration');
  for (const protocol of Object.keys(fixture)) {
    let sends = 0;
    const provider = createModelGateway({ ...options, protocol, generation: { maxOutputTokens: 20 },
      capacity: { contextWindowTokens: 100, maxOutputTokens: 20 }, transport: async () => { sends++; throw 0; } });
    assert.deepEqual(provider.profile.capacity, { contextWindowTokens: 100, maxOutputTokens: 20 });
    assert.equal(Object.isFrozen(provider.profile.capacity), true);
    for (const invalid of [
      { ...request, reasoning: 'high' },
      { ...request, messages: [{ role: 'user', content: 'hi', image: 'no' }] },
      { ...request, messages: [...request.messages, { role: 'assistant', content: '', toolCalls: calls }] },
    ]) await assert.rejects(provider.generate(invalid, signal()), e => e.code === 'request' && e.effect === 'none');
    assert.equal(sends, 0);
    const narrow = createModelGateway({ ...options, protocol, generation: { maxOutputTokens: 20 },
      modelCapabilities: { functionTools: false }, transport: async () => { sends++; throw 0; } });
    await assert.rejects(narrow.generate(request, signal()), e => e.code === 'request');
  }
  const anthropic = createModelGateway({ ...options, protocol: 'anthropic-messages', generation: { maxOutputTokens: 20 },
    transport: async () => { throw Error('must not send'); } });
  await assert.rejects(anthropic.generate({ ...request, messages: [
    request.messages[1], request.messages[0], request.messages[1],
  ] }, signal()), e => e.code === 'request' && e.effect === 'none');
});

test('native protocols: cancellation, reported usage on failure, error classification and key redaction', async () => {
  for (const [protocol, f] of Object.entries(fixture)) {
    let sent = 0, closed = 0;
    const controller = new AbortController();
    const source = f.stream(f.tools);
    const provider = createModelGateway({ ...options, protocol, stream: true, generation: { maxOutputTokens: 20 },
      onObservation: e => { if (e.data.type === 'text_delta') controller.abort('dummy-only'); },
      transport: async () => { sent++; return new Response(new ReadableStream({
        start(c) { c.enqueue(Buffer.from(source)); }, cancel() { closed++; },
      })); } });
    await assert.rejects(provider.generate(request, controller.signal), e => e.code === 'cancelled' && e.effect === 'unknown');
    assert.equal(sent, 1); assert.equal(closed, 1);
    sent = 0;
    const pre = new AbortController(); pre.abort();
    await assert.rejects(provider.generate(request, pre.signal), e => e.effect === 'none');
    assert.equal(sent, 0);
    const missingTerminal = source.slice(0, source.lastIndexOf(protocol === 'responses' ? 'event: response.completed' : 'event: message_stop'));
    const truncated = createModelGateway({ ...options, protocol, stream: true, generation: { maxOutputTokens: 20 },
      transport: async () => new Response(missingTerminal) });
    await assert.rejects(truncated.generate(request, signal()), e => e.code === 'incomplete'
      && (protocol !== 'anthropic-messages' || e.attempts[0].usage.outputTokens === 3));
    for (const [status, type, code] of [
      [401, 'authentication_error', 'authentication'],
      [429, protocol === 'responses' ? 'rate_limit_exceeded' : 'rate_limit_error', 'rate_limit'],
      [429, 'unknown', 'http'], [503, 'overloaded_error', 'http'],
    ]) {
      sent = 0;
      const bad = createModelGateway({ ...options, protocol, generation: { maxOutputTokens: 20 },
        account: { kind: protocol === 'responses' ? 'bearer' : 'api-key', token: 'dummy-only' },
        retry: { maxAttempts: 1 }, transport: async () => {
          sent++; return new Response(JSON.stringify({ error: { code: type, type: protocol === 'responses' ? undefined : type,
            message: 'dummy-only' } }), { status, headers: { [protocol === 'responses' ? 'x-request-id' : 'request-id']: 'dummy-only' } });
        } });
      await assert.rejects(bad.generate(request, signal()), e => e.code === code && !`${e}${JSON.stringify(e)}`.includes('dummy-only'));
      assert.equal(sent, 1);
    }
    const absent = createModelGateway({ ...options, protocol, generation: { maxOutputTokens: 20 },
      transport: async () => new Response(JSON.stringify({ ...f.final, usage: undefined })) });
    assert.equal((await absent.generate(request, signal())).usage, undefined);
    const observer = createLocalObserver();
    const composed = createModelGateway({ ...options, protocol, generation: { maxOutputTokens: 20 },
      onObservation: connectModelObservations(observer),
      transport: async () => new Response(JSON.stringify(f.tools)) });
    await composed.generate(request, signal());
    const observed = observer.query().records.find(r => r.kind === 'model');
    assert.equal(observed.usage.cacheWriteInputTokens, 1, 'composition must not silently drop reported cache writes');
    if (protocol === 'anthropic-messages') assert.equal(observed.usage.totalTokens, undefined);
    observer.close();
  }
});
