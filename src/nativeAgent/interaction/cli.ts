import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { InteractionDiagnosticsPort, InteractionRenderer, InteractionSessionPort, InteractionTextProgress } from './contracts.js';
import { createTextRenderer, terminalText } from './renderer.js';

export type CliEnd = { reason: 'closed' | 'quit' | 'eof' | 'display-error' | 'input-error'; error?: unknown };
export type CliConnection = { done: Promise<CliEnd>; close(): void };
const PAGE = 20;
const HELP = 'Text: submit | /new [title] | /sessions [offset] | /use ID | /history [offset] | /diagnostics [offset] | /refresh | /more | /cancel | /quit\n';

/** Caller owns the streams and session service. Detaching never cancels a turn. */
export async function openCli(options: {
  sessions: InteractionSessionPort; input: Readable; output: Writable;
  initialSessionId?: string; renderer?: InteractionRenderer;
  diagnostics?: InteractionDiagnosticsPort;
  progress?: InteractionTextProgress;
}): Promise<CliConnection> {
  const { sessions, input, output } = options;
  const renderer = options.renderer ?? createTextRenderer();
  let selected = options.initialSessionId ?? (await sessions.create('CLI session')).id;
  let cursor = 0;
  let closed = false;
  let unsubscribe = () => {};
  let unsubscribeDiagnostics = () => {};
  let unsubscribeProgress = () => {};
  let progressQueued = false;
  let pendingProgress: { sessionId: string; turnId: string; text: string; omitted: boolean } | undefined;
  let diagnosticsQueued = false;
  let refreshQueued = false;
  let scheduled: NodeJS.Immediate | undefined;
  let queue = Promise.resolve();
  let resolveDone!: (end: CliEnd) => void;
  const done = new Promise<CliEnd>(resolve => { resolveDone = resolve; });
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  const finish = (end: CliEnd) => {
    if (closed) return;
    closed = true;
    if (scheduled) clearImmediate(scheduled);
    unsubscribe();
    try { unsubscribeProgress(); }
    catch (error) { end.error ??= error; }
    try { unsubscribeDiagnostics(); }
    catch (error) { end.error ??= error; }
    lines.close();
    lines.off('error', inputError);
    input.off('error', inputError);
    output.off('error', displayError);
    output.off('close', outputClose);
    resolveDone(end);
  };
  const displayError = (error: unknown) => finish({ reason: 'display-error', error });
  const inputError = (error: unknown) => finish({ reason: 'input-error', error });
  const outputClose = () => displayError(new Error('Output closed'));
  input.on('error', inputError);
  lines.on('error', inputError);
  output.on('error', displayError);
  output.on('close', outputClose);
  const write = async (text: string) => {
    if (closed) return;
    // Await the callback rather than buffering an unbounded amount for slow terminals.
    await new Promise<void>(resolve => {
      try {
        output.write(text, error => {
          // Writable emits its error after this callback. Keep our error listener
          // installed until that event; removing it here causes an unhandled error.
          if (error) return resolve();
          resolve();
        });
      } catch (error) { displayError(error); resolve(); }
    });
  };
  const enqueue = (work: () => Promise<void>) => {
    queue = queue.then(async () => {
      if (closed) return;
      try { await work(); }
      catch (error) {
        await write(`[error] ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
      }
    });
  };
  const diagnostics = async (offset?: number) => {
    if (!options.diagnostics) {
      await write('[observation unavailable: no adapter configured]\n');
      return;
    }
    try {
      if (offset !== undefined) {
        const page = await options.diagnostics.query(selected, offset, PAGE);
        if (page.lines.length > PAGE) throw new Error('Observation page exceeds limit');
        for (const line of page.lines) await write(`[observation] ${terminalText(line)}\n`);
        if (page.nextOffset !== null) await write(`[next: /diagnostics ${page.nextOffset}]\n`);
      }
      await write(`[observation health; NOT execution state] ${terminalText(await options.diagnostics.health())}\n`);
    } catch (error) {
      await write(`[observation unavailable] ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
    }
  };
  const refresh = async () => {
    const page = await sessions.read(selected, cursor, PAGE);
    if (closed) return;
    if (page.records.length > PAGE || !Number.isSafeInteger(page.cursor) || page.cursor < cursor
      || (page.hasMore && page.cursor <= cursor)) throw new Error('Invalid display page progress');
    let previous = cursor;
    for (const record of page.records) {
      const id = record.kind === 'event' ? record.event.sessionId : record.sessionId;
      if (id !== selected || !Number.isSafeInteger(record.cursor) || record.cursor <= previous || record.cursor > page.cursor) {
        throw new Error('Invalid display record identity/order');
      }
      // Renderer is also an optional display adapter, never an execution sink.
      let rendered: string;
      try { rendered = renderer.record(record); }
      catch (error) { displayError(error); return; }
      await write(rendered);
      if (closed) return;
      previous = record.cursor;
      cursor = record.cursor;
    }
    if (page.cursor !== previous) throw new Error('Display cursor skipped records');
    if (page.diagnostic) await write(`[diagnostic] ${terminalText(page.diagnostic)}\n`);
    if (page.hasMore) scheduleRefresh();
  };
  const scheduleRefresh = () => {
    if (closed || refreshQueued || scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      refreshQueued = true;
      enqueue(async () => {
        refreshQueued = false;
        await refresh();
      });
    });
  };
  const select = async (id: string) => {
    // Validate the target before losing the current selection.
    await sessions.read(id, 0, 1);
    if (closed) return;
    unsubscribe();
    selected = id;
    cursor = 0;
    // Subscribe before reading so changes concurrent with the read are not missed.
    unsubscribe = sessions.subscribe(selected, scheduleRefresh);
    await write(`[selected ${terminalText(selected, 200)}; replay]\n`);
    await refresh();
  };
  const offset = (argument: string) => {
    if (!argument) return 0;
    if (!/^\d+$/.test(argument) || !Number.isSafeInteger(Number(argument))) throw new Error('Expected a non-negative offset');
    return Number(argument);
  };
  const command = async (line: string) => {
    if (line.length > 65536) throw new Error('Input exceeds 65536 characters');
    const match = /^\/(\S+)(?:\s+(.*))?$/.exec(line.trim());
    if (!match) {
      if (!line.trim()) return;
      const scope = await sessions.submit(selected, line);
      await write(`[submitted ${terminalText(scope.turnId, 100)}]\n`);
      scheduleRefresh();
      return;
    }
    const arg = (match[2] ?? '').trim();
    switch (match[1]) {
      case 'help': await write(HELP); break;
      case 'new': {
        const item = await sessions.create(arg || 'CLI session');
        if (!closed) await select(item.id);
        break;
      }
      case 'use':
        if (!arg) throw new Error('Usage: /use ID');
        await select(arg); break;
      case 'sessions': {
        const page = await sessions.list(offset(arg), PAGE);
        if (page.sessions.length > PAGE) throw new Error('Session page exceeds limit');
        for (const item of page.sessions) await write(`${terminalText(item.id, 200)} ${terminalText(item.title, 200)}\n`);
        if (page.nextOffset !== null) await write(`[next: /sessions ${page.nextOffset}]\n`);
        break;
      }
      case 'history': {
        const page = await sessions.history(selected, offset(arg), PAGE);
        if (page.messages.length > PAGE) throw new Error('History page exceeds limit');
        await write(`[history ${terminalText(selected, 200)} offset ${offset(arg)}]\n`);
        for (const message of page.messages) {
          try { await write(renderer.message(message)); }
          catch (error) { displayError(error); return; }
        }
        if (page.nextOffset !== null) await write(`[next: /history ${page.nextOffset}]\n`);
        break;
      }
      case 'diagnostics': await diagnostics(offset(arg)); break;
      case 'refresh': cursor = 0; await write('[replay from session facts]\n'); await refresh(); break;
      case 'more': await refresh(); break;
      case 'cancel': {
        const page = await sessions.read(selected, cursor, 1);
        if (closed) return;
        const accepted = page.activeTurnId !== null && await sessions.cancel({ sessionId: selected, turnId: page.activeTurnId });
        await write(accepted ? '[cancel requested; awaiting actual terminal]\n' : '[no matching active turn]\n');
        break;
      }
      case 'quit': finish({ reason: 'quit' }); break;
      default: throw new Error('Unknown command; /help lists commands');
    }
  };
  lines.on('line', line => enqueue(() => command(line)));
  lines.on('close', () => {
    // Let already accepted input lines finish on piped EOF.
    enqueue(async () => finish({ reason: 'eof' }));
  });
  enqueue(async () => {
    await write(HELP);
    await select(selected);
    if (closed) return;
    if (options.progress) unsubscribeProgress = options.progress.subscribe(progress => {
      if (closed || progress.sessionId !== selected) return;
      const same = pendingProgress?.turnId === progress.turnId;
      const text = (same ? pendingProgress!.text : '') + progress.text;
      pendingProgress = { ...progress, text: text.slice(0, 8192),
        omitted: text.length > 8192 || !!pendingProgress?.omitted || (!!pendingProgress && !same) };
      if (progressQueued) return;
      progressQueued = true;
      enqueue(async () => {
        const next = pendingProgress;
        pendingProgress = undefined; progressQueued = false;
        if (next?.sessionId === selected) {
          await write(`[provisional ${terminalText(next.turnId, 100)}] ${terminalText(next.text)}${next.omitted ? ' [updates omitted]' : ''}\n`);
        }
      });
    });
    if (!options.diagnostics) return;
    try {
      unsubscribeDiagnostics = options.diagnostics.subscribe(() => {
        if (closed || diagnosticsQueued) return;
        diagnosticsQueued = true;
        enqueue(async () => { diagnosticsQueued = false; await diagnostics(); });
      });
    } catch (error) {
      await write(`[observation unavailable] ${terminalText(error instanceof Error ? error.message : String(error))}\n`);
    }
  });
  if (input.readableEnded) enqueue(async () => finish({ reason: 'eof' }));
  if (output.destroyed) displayError(new Error('Output unavailable'));
  return { done, close: () => finish({ reason: 'closed' }) };
}
