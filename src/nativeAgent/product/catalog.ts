import { isAbsolute, resolve } from 'node:path';
import { ProductError, containsCredential, resolveCredentialReference } from './config.js';
import { openProductStore, storageFailure } from './storage.js';

export const catalogCommands = ['sessions', 'session-info', 'rename', 'history'] as const;
export const catalogCommandOptions = (command: string) => ['--state-dir', '--credential-ref',
  ...(command === 'sessions' || command === 'history' ? ['--limit', '--cursor'] : []),
  ...(command !== 'sessions' ? ['--session'] : []),
  ...(command === 'rename' ? ['--title', '--expected-metadata-revision'] : [])];

/** Data-only catalog command: no provider, owner, tools, account fallback or cwd. */
export async function runCatalogCommand(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  const [command, ...tail] = args;
  const invalid = (): never => { throw new ProductError('agent_config', 'catalog',
    'Use explicit --state-dir, exact --session ID, opaque --cursor and bounded --limit; rename requires JSON --title and --expected-metadata-revision.'); };
  if (!catalogCommands.some(name => name === command)) return invalid();
  const allowed = catalogCommandOptions(command);
  const values = new Map<string, string>();
  for (let i = 0; i < tail.length; i++) {
    const key = tail[i];
    if (key === '--json' && !values.has(key)) { values.set(key, 'true'); continue; }
    const value = tail[++i];
    if (!allowed.includes(key) || values.has(key) || value === undefined
      || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/u.test(value)) return invalid();
    values.set(key, value);
  }
  const directory = values.get('--state-dir') ?? env.NATIVE_AGENT_STATE_DIR;
  if (!directory?.trim() || Buffer.byteLength(directory) > 4096 || /[\x00-\x1f\x7f]/u.test(directory)
    || (!values.has('--state-dir') && !isAbsolute(directory))) return invalid();
  const id = values.get('--session');
  if (command !== 'sessions' && (!id || !/^[A-Za-z0-9_-]{1,128}$/u.test(id))) return invalid();
  const integer = (text: string | undefined, maximum: number, minimum: number) => {
    if (!text || !/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text))
      || Number(text) < minimum || Number(text) > maximum) return invalid();
    return Number(text);
  };
  const limit = integer(values.get('--limit') ?? '20', 100, 1);
  const options = { limit, ...(values.has('--cursor') ? { cursor: values.get('--cursor')! } : {}) };
  let title: string | null = null, revision = 0;
  if (command === 'rename') {
    try { title = JSON.parse(values.get('--title') ?? ''); } catch { return invalid(); }
    if (title !== null && (typeof title !== 'string' || !title.trim()
      || [...title.trim()].length > 200 || /[\p{Cc}\p{Cs}]/u.test(title))) return invalid();
    revision = integer(values.get('--expected-metadata-revision'), Number.MAX_SAFE_INTEGER, 0);
  }
  const ref = values.get('--credential-ref') ?? env.NATIVE_AGENT_CREDENTIAL_REF;
  const credential = ref === undefined ? undefined : resolveCredentialReference(ref, env);
  const guard = (value: unknown) => {
    if (credential && containsCredential(value, credential)) throw new ProductError('agent_execution',
      'credential', 'Configured credential found in catalog data; no output or automatic replay.');
  };
  guard({ directory, id, title, options });
  const store = await openProductStore(resolve(cwd, directory), false);
  try {
    const result = command === 'sessions' ? await store.listSessions(options)
      : command === 'session-info' ? await store.getSessionInfo(id!)
        : command === 'history' ? await store.readHistory(id!, options)
          : await store.renameSession(id!, title, revision);
    guard(result);
    await new Promise<void>((done, fail) => process.stdout.write(`${JSON.stringify(result)}\n`,
      error => error ? fail(new ProductError('agent_output', 'stdout', 'Read saved facts; do not repeat an uncertain rename.')) : done()));
    return 0;
  } catch (error) { throw storageFailure(error); }
  finally { await store.close(); }
}
