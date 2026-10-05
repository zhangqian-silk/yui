import {
  createAgent, createProjectGuidance, createContextBuilder, createExecutionOwner,
  createLocalObserver, createModelGateway,
  connectModelObservations, createInteractionDiagnostics, openCli,
  type ExecutionOwner, type InteractionSessionPort, type SessionStore, type SessionCatalog,
} from '../index.js';
import type { CliConnection } from '../interaction/index.js';
import { ProductError, containsCredential, createProductBinding, publicConfiguration, type ProductArguments } from './config.js';
import { createProductTransport } from './transport.js';
import { createProductTools } from './tools.js';
import { openProductStore, storageFailure } from './storage.js';
import { restoreProductLocation, createProductSession } from './location.js';

/** Product owns the streams' connection listeners, model dispatcher, store and owner.
 * No hidden execution loop/catalog/policy: all execution goes through ExecutionOwner. */
export async function runProductRuntime(invocation: ProductArguments, credential?: string): Promise<number> {
  let { config } = invocation;
  // Rebuild on EVERY open/resume from current explicit authority, never stored history.
  // Same factory for all three capabilities; do not grant the shorthand's always-allow lease.
  let binding: ReturnType<typeof createProductBinding>;
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
    store = await openProductStore(config.stateDir, true);
    if (selected) {
      const location = await restoreProductLocation(store, selected, config);
      config = { ...config, ...location };
      invocation = { ...invocation, config };
    }
    binding = createProductBinding(invocation, credential);
    const activeStore = store;
    const selectedLocation = { root: config.root, cwd: config.cwd };
    const admitLocation = async (id: string) => {
      const location = await restoreProductLocation(activeStore, id, config);
      guard(location);
      if (location.root !== selectedLocation.root || location.cwd !== selectedLocation.cwd)
        throw new ProductError('agent_config', 'location',
          'This UI is bound to a different location. Close the settled process and reopen with --session ID and fresh grants.');
      return location;
    };
    const provider = createModelGateway({
      endpoint: config.endpoint, model: config.model,
      account: credential ? { kind: 'bearer', token: credential } : { kind: 'none' },
      stream: config.stream, retry: { maxElapsedMs: config.modelTimeoutMs },
      onObservation: connectModelObservations(observer),
      // Use a locally owned network pool; no global connection or account state.
      transport: network.transport,
    });
    owner = createExecutionOwner({
      store, maxSteps: config.maxSteps, observer,
      ...(selected ? { sessions: [{ id: selected, title: 'Explicit selection' }] } : {}),
      agent: async recording => {
        // ExecutionOwner creates this Agent for the admitted Turn. Bind to the
        // recording's identity, never the UI's mutable selected Session.
        const sessionId = recording.lastReceipt.sessionId;
        const location = await admitLocation(sessionId);
        const currentInvocation = { ...invocation, config: { ...config, ...location } };
        const currentBinding = createProductBinding(currentInvocation, credential);
        const guidance = createProjectGuidance({ ...location, sessionId });
        return createAgent({
          toolExecutor: createProductTools(currentBinding, guidance, currentInvocation, sessionId),
          contextBuilder: createContextBuilder({ sources: [guidance.source] }),
          contextBudget: { capacity: config.contextBytes, reserveOutput: config.outputReserveBytes },
          observer,
          provider: { async complete(request, signal) {
            guard(request);
            const response = await provider.complete(request, signal);
            guard(response); // Do not persist/execute a credential echoed by the model.
            return response;
          } },
          recorder: { async record(event) { guard(event); await recording.record(event); } },
        });
      },
    });
    if (selected) {
      try {
        const saved = await store.load(selected);
        guard(saved);
        if (saved.recovery.disposition !== 'ready') throw new Error();
      } catch {
        throw new ProductError('agent_storage', 'session', 'Select an existing ready Session in this state directory; inspect unsettled/unknown facts without replay.');
      }
    } else selected = (await createProductSession(owner, store, 'Agent session', selectedLocation)).id;
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
      await write({ configuration: publicConfiguration(config), binding: binding.binding,
        projectAuthority: { allowMemoryWrite: invocation.allowMemoryWrite },
        result: evidence.result, receipt: evidence.receipt,
        observations: observer.query().records });
      return signalExit ?? (evidence.result.reason === 'completed' ? 0 : evidence.result.reason === 'cancelled'
        ? 130 : evidence.result.reason === 'budget_exhausted' ? 3 : 1);
    }
    const activeOwner = owner;
    const catalogSafe = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { const value = await operation(); guard(value); return value; }
      catch (error) { throw storageFailure(error); }
    };
    const catalog: SessionCatalog = {
      listSessions: options => catalogSafe(() => activeStore.listSessions(options)),
      getSessionInfo: id => catalogSafe(() => activeStore.getSessionInfo(id)),
      readHistory: (id, options) => catalogSafe(() => activeStore.readHistory(id, options)),
      async renameSession(id, title, expected) {
        guard(title);
        return catalogSafe(() => activeStore.renameSession(id, title, expected));
      },
    };
    const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { const value = await operation(); guard(value); return value; }
      catch (error) {
        if (error instanceof ProductError) throw error;
        throw storageFailure(error);
      }
    };
    const port: InteractionSessionPort = {
      async create(title) {
        guard(title);
        if (!title.trim() || [...title.trim()].length > 200 || /[\p{Cc}\p{Cs}]/u.test(title))
          throw new ProductError('agent_config', 'title', 'Use 1..200 Unicode characters without controls.');
        const item = await createProductSession(activeOwner, activeStore, title, selectedLocation);
        await catalog.renameSession(item.id, title, 0);
        return item;
      },
      list: (offset, limit) => safe(() => activeOwner.list(offset, limit)),
      async submit(id, input) {
        guard(input);
        await admitLocation(id);
        const scope = await safe(() => activeOwner.submit(id, input));
        selected = id;
        return scope;
      },
      cancel: scope => safe(() => activeOwner.cancel(scope)),
      history: (id, offset, limit) => safe(() => activeOwner.history(id, offset, limit)),
      subscribe: (id, callback) => activeOwner.subscribe(id, callback),
      async read(id, after, limit) {
        await admitLocation(id);
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
    await write({ configuration: publicConfiguration(config), binding: binding.binding,
      projectAuthority: { allowMemoryWrite: invocation.allowMemoryWrite },
      sessionId: selected, mode: 'local-tool-binding',
      note: 'Original root/cwd are persisted atomically. Cross-location selection requires settled close and explicit reopen with fresh authority. Not an OS sandbox.' }, '[agent] ');
    cli = await openCli({ sessions: port, catalog, input: process.stdin, output: process.stdout,
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
