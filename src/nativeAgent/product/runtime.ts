import { mkdir, chmod, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAgent, createCodingTools, createContextBuilder, createExecutionOwner,
  createLocalObserver, createModelGateway, createSessionStore, createSqliteSessionBackend,
  connectModelObservations, createInteractionDiagnostics, openCli,
  type ExecutionOwner, type InteractionSessionPort, type SessionStore,
} from '../index.js';
import type { CliConnection } from '../interaction/index.js';
import { ProductError, containsCredential, type ProductArguments } from './config.js';
import { createProductTransport } from './transport.js';

/** Product owns the streams' connection listeners, model dispatcher, store and owner.
 * No hidden execution loop/catalog/policy: all execution goes through ExecutionOwner. */
export async function runProductRuntime(invocation: ProductArguments, credential?: string): Promise<number> {
  const { config } = invocation;
  const observer = createLocalObserver();
  let store: SessionStore | undefined, owner: ExecutionOwner | undefined, cli: CliConnection | undefined;
  let selected = invocation.session;
  let signalExit: number | undefined;
  let outputFailed = false;
  const displayedReceipts = new Set<string>();
  const guard = (value: unknown) => {
    if (credential && containsCredential(value, credential)) {
      throw new ProductError('agent_execution', 'credential', 'Credential found in conversation data; preserve saved facts, do not replay.');
    }
  };
  const write = async (value: unknown, prefix = '') => {
    guard(value);
    if (outputFailed) return;
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${prefix}${JSON.stringify(value)}\n`, error => {
        if (error) reject(new ProductError('agent_output', 'stdout', 'Output disconnected; owned execution is being closed.'));
        else resolve();
      });
    });
  };
  const outputError = () => { outputFailed = true; cli?.close(); void owner?.close(); };
  const terminate = () => { signalExit = 143; cli?.close(); void owner?.close(); };
  const interrupt = () => {
    void (async () => {
      if (selected && owner) {
        const page = await owner.read(selected, 0, 1);
        if (page.activeTurnId !== null) {
          await owner.cancel({ sessionId: selected, turnId: page.activeTurnId });
          if (invocation.command === 'run') signalExit = 130;
          return;
        }
      }
      signalExit = 130; cli?.close(); await owner?.close();
    })().catch(() => { signalExit = 130; cli?.close(); void owner?.close(); });
  };
  process.stdout.on('error', outputError);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  // Explicit per-product dispatcher. Closing it cannot close a borrowed/global pool.
  const network = createProductTransport();
  try {
    try {
      await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
      if ((await lstat(config.stateDir)).isSymbolicLink()) throw new Error();
      const stateDir = await realpath(config.stateDir);
      const filename = join(stateDir, 'sessions.sqlite');
      store = createSessionStore(createSqliteSessionBackend(filename));
      await chmod(filename, 0o600);
    } catch {
      throw new ProductError('agent_storage', 'stateDir', 'Choose a writable controlled state directory containing a supported Agent database.');
    }
    const provider = createModelGateway({
      endpoint: config.endpoint, model: config.model,
      account: credential ? { kind: 'bearer', token: credential } : { kind: 'none' },
      stream: config.stream, retry: { maxElapsedMs: config.modelTimeoutMs },
      onObservation: connectModelObservations(observer),
      // Use a locally owned network pool; no global connection or account state.
      transport: network.transport,
    });
    const tools = createCodingTools({
      root: config.cwd,
      ...(config.tools.includes('command') ? { command: { env: {} } } : {}),
    }).filter(tool => config.tools.includes(tool.definition.name));
    owner = createExecutionOwner({
      store, maxSteps: config.maxSteps, observer,
      ...(selected ? { sessions: [{ id: selected, title: 'Explicit selection' }] } : {}),
      agent: recording => createAgent({
        // Existing shorthand = caller-authorized, prebound tools. Not an 82 policy replacement.
        tools, contextBuilder: createContextBuilder(),
        contextBudget: { capacity: config.contextBytes, reserveOutput: config.outputReserveBytes },
        observer,
        provider: { async complete(request, signal) {
          guard(request);
          const response = await provider.complete(request, signal);
          guard(response); // Do not persist/execute a credential echoed by the model.
          return response;
        } },
        recorder: { async record(event) { guard(event); await recording.record(event); } },
      }),
    });
    if (selected) {
      try {
        const saved = await store.load(selected);
        guard(saved);
        if (saved.recovery.disposition !== 'ready') throw new Error();
      } catch {
        throw new ProductError('agent_storage', 'session', 'Select an existing ready Session in this state directory; inspect unsettled/unknown facts without replay.');
      }
    } else selected = (await owner.create('Agent session')).id;
    if (signalExit !== undefined || outputFailed) return signalExit ?? 1;
    if (invocation.command === 'run') {
      await owner.submit(selected, invocation.input!);
      const evidence = await owner.settle(selected);
      if (!evidence?.result || evidence.failure || evidence.result.recording.status !== 'recorded') {
        await write({ status: 'not_fully_saved', lastConfirmedReceipt: evidence?.receipt,
          error: { code: 'agent_storage', field: 'recording',
            nextAction: 'Inspect the last confirmed receipt and stored facts. No automatic retry.' } });
        return 1;
      }
      const saved = await store.load(selected).catch(() => undefined);
      const confirmed = saved && evidence.result.recording.status === 'recorded'
        && evidence.receipt?.digest === saved.digest && evidence.receipt.revision === saved.revision;
      // Failure evidence is not a full-turn save receipt.
      if (!confirmed) {
        await write({ status: 'receipt_verification_failed', lastConfirmedReceipt: evidence.receipt,
          error: { code: 'agent_storage', field: 'recording',
            nextAction: 'Preserve the state directory and inspect confirmed facts.' } });
        return 1;
      }
      await write({ configuration: config, result: evidence.result, receipt: evidence.receipt,
        observations: observer.query().records });
      return signalExit ?? (evidence.result.reason === 'completed' ? 0 : evidence.result.reason === 'cancelled'
        ? 130 : evidence.result.reason === 'budget_exhausted' ? 3 : 1);
    }
    const activeOwner = owner;
    const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { const value = await operation(); guard(value); return value; }
      catch { throw new ProductError('agent_execution', 'session', 'Inspect saved Session facts; do not automatically retry.'); }
    };
    const port: InteractionSessionPort = {
      async create(title) { guard(title); return safe(() => activeOwner.create(title)); },
      list: (offset, limit) => safe(() => activeOwner.list(offset, limit)),
      async submit(id, input) {
        guard(input);
        const scope = await safe(() => activeOwner.submit(id, input));
        selected = id;
        return scope;
      },
      cancel: scope => safe(() => activeOwner.cancel(scope)),
      history: (id, offset, limit) => safe(() => activeOwner.history(id, offset, limit)),
      subscribe: (id, callback) => activeOwner.subscribe(id, callback),
      async read(id, after, limit) {
        const page = await safe(() => activeOwner.read(id, after, limit));
        selected = id;
        if (page.records.some(record => record.kind === 'event' && record.event.data.type === 'turn_ended')) {
          const evidence = await activeOwner.settle(id);
          if (evidence?.receipt && evidence.result?.recording.status === 'recorded' && !evidence.failure
            && !displayedReceipts.has(evidence.receipt.digest)) {
            const saved = await store!.load(id);
            if (saved.digest === evidence.receipt.digest) {
              displayedReceipts.add(evidence.receipt.digest);
              await write(evidence.receipt, '[saved receipt] ');
            }
          }
        }
        return page;
      },
    };
    await write({ configuration: config, sessionId: selected, mode: 'prebound-tools',
      note: 'No persistent catalog/cwd binding or dynamic grants yet; commands are not sandboxed.' }, '[agent] ');
    cli = await openCli({ sessions: port, input: process.stdin, output: process.stdout,
      initialSessionId: selected, diagnostics: createInteractionDiagnostics(observer) });
    if (signalExit !== undefined || outputFailed) cli.close();
    const ended = await cli.done;
    // EOF/quit detaches UI only; the product owner must cancel/drain the actual
    // execution before acknowledging shutdown or closing storage/network pools.
    await owner.close();
    const finalEvidence = await owner.settle(selected);
    if (finalEvidence?.receipt && !displayedReceipts.has(finalEvidence.receipt.digest)) {
      const saved = await store.load(selected).catch(() => undefined);
      if (finalEvidence.result?.recording.status === 'recorded' && !finalEvidence.failure
        && saved?.digest === finalEvidence.receipt.digest) {
        await write(finalEvidence.receipt, '[saved receipt on close] ');
      } else await write({ status: 'not_fully_saved', lastConfirmedReceipt: finalEvidence.receipt,
        nextAction: 'Inspect saved facts; no automatic retry.' }, '[agent close] ');
    }
    return signalExit ?? (['display-error', 'input-error'].includes(ended.reason) || outputFailed ? 1 : 0);
  } finally {
    cli?.close();
    try { await owner?.close(); }
    finally {
      try { await store?.close(); }
      finally {
        observer.close();
        try { network.close(); }
        finally {
          process.stdout.off('error', outputError);
          process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
        }
      }
    }
  }
}
