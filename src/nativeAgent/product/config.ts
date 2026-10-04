import { open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { createLocalToolBinding, type LocalToolOptions } from '../index.js';

export class ProductError extends Error {
  constructor(readonly code: 'agent_config' | 'agent_storage' | 'agent_execution' | 'agent_output',
    readonly field: string, readonly nextAction: string) {
    super(`${code}: ${field}; ${nextAction}`);
  }
}
export function productFailure(error: unknown) {
  // Never format arbitrary thrown messages, causes, argv or HTTP response bodies.
  return error instanceof ProductError
    ? { code: error.code, field: error.field, nextAction: error.nextAction }
    : { code: 'agent_execution', field: 'runtime', nextAction: 'Inspect saved facts; do not replay uncertain effects.' };
}
const invalid = (field: string, action = 'Provide a supported explicit value and restart.'): never => {
  throw new ProductError('agent_config', field, action);
};
const fields = ['adapter', 'endpoint', 'model', 'credentialRef', 'cwd', 'stateDir', 'tools',
  'maxSteps', 'contextBytes', 'outputReserveBytes', 'modelTimeoutMs', 'stream', 'command'] as const;
type Field = typeof fields[number];
export type ProductConfig = {
  adapter: 'chat-completions'; endpoint: string; model: string; credentialRef: string;
  cwd: string; stateDir: string; tools: string[]; maxSteps: number;
  contextBytes: number; outputReserveBytes: number; modelTimeoutMs: number; stream: boolean;
  command?: LocalToolOptions['command'];
  sources: Record<Field, 'cli' | 'environment' | 'file' | 'default'>;
};
export type ProductArguments = {
  command: 'check-config' | 'start' | 'run'; config: ProductConfig;
  session?: string; input?: string; allowWrite: boolean;
};
const options: Record<string, Field> = {
  '--adapter': 'adapter', '--endpoint': 'endpoint', '--model': 'model', '--credential-ref': 'credentialRef',
  '--cwd': 'cwd', '--state-dir': 'stateDir', '--tools': 'tools', '--max-steps': 'maxSteps',
  '--context-bytes': 'contextBytes', '--output-reserve-bytes': 'outputReserveBytes',
  '--model-timeout-ms': 'modelTimeoutMs', '--stream': 'stream', '--command-config': 'command',
};
export const productConfigurationOptions = [...Object.keys(options), '--config',
  '--allow-write', '--allow-command', '--allow-http'];
const environment: Record<Field, string> = {
  adapter: 'NATIVE_AGENT_ADAPTER', endpoint: 'NATIVE_AGENT_ENDPOINT', model: 'NATIVE_AGENT_MODEL',
  credentialRef: 'NATIVE_AGENT_CREDENTIAL_REF', cwd: 'NATIVE_AGENT_CWD', stateDir: 'NATIVE_AGENT_STATE_DIR',
  tools: 'NATIVE_AGENT_TOOLS', maxSteps: 'NATIVE_AGENT_MAX_STEPS', contextBytes: 'NATIVE_AGENT_CONTEXT_BYTES',
  outputReserveBytes: 'NATIVE_AGENT_OUTPUT_RESERVE_BYTES', modelTimeoutMs: 'NATIVE_AGENT_MODEL_TIMEOUT_MS',
  stream: 'NATIVE_AGENT_STREAM', command: 'NATIVE_AGENT_COMMAND_CONFIG',
};
const toolNames = ['read', 'list', 'find', 'search', 'write', 'edit', 'command'];
function text(value: unknown, field: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) return invalid(field);
  return value;
}
function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum || number > maximum) return invalid(field);
  return number;
}
async function configurationFile(path: string): Promise<Record<string, unknown>> {
  let handle;
  try {
    handle = await open(path, 'r');
    if (!(await handle.stat()).isFile()) return invalid('config');
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) return invalid('config', 'Use a JSON configuration no larger than 64 KiB.');
    const object = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (!object || typeof object !== 'object' || Array.isArray(object) || object.schemaVersion !== 1
      || Object.keys(object).some(key => key !== 'schemaVersion' && !fields.includes(key as Field))) return invalid('config');
    return object;
  } catch { return invalid('config', 'Select a readable, valid version-1 JSON configuration.'); }
  finally { await handle?.close(); }
}

/** Data-only explicit file; no discovery, scripts, account lookup or Yui configuration. */
export async function resolveProductArguments(args: string[], env: NodeJS.ProcessEnv, launchCwd: string): Promise<ProductArguments> {
  const [command, ...tail] = args;
  if (!['check-config', 'start', 'run'].includes(command)) return invalid('command', 'Use check-config, start or run; see yui agent --help.');
  const cli: Partial<Record<Field, unknown>> = {};
  const seen = new Set<string>();
  let filePath: string | undefined, session: string | undefined, input: string | undefined;
  let allowWrite = false, allowCommand = false, allowHttp = false;
  for (let index = 0; index < tail.length; index++) {
    const key = tail[index];
    if (seen.has(key)) return invalid('arguments', 'Do not repeat options.');
    seen.add(key);
    if (key === '--json') continue;
    if (key === '--allow-write') { allowWrite = true; continue; }
    if (key === '--allow-command') { allowCommand = true; continue; }
    if (key === '--allow-http') { allowHttp = true; continue; }
    if (!Object.hasOwn(options, key) && !['--config', '--session', '--input'].includes(key)) return invalid('arguments');
    const value = tail[++index];
    if (value === undefined) return invalid('arguments');
    if (key === '--config') filePath = resolve(launchCwd, text(value, 'config'));
    else if (key === '--session') session = text(value, 'session', 128);
    else if (key === '--input') {
      if (!value.trim() || Buffer.byteLength(value) > 65536) return invalid('input');
      input = value;
    } else cli[options[key]] = value;
  }
  if (command === 'start' && seen.has('--json')) return invalid('arguments', 'Use run for JSON results; start is a line UI.');
  if ((command === 'run') !== (input !== undefined)) return invalid('input', 'run requires --input; start/check-config do not accept it.');
  if (session !== undefined && !/^[A-Za-z0-9_-]{1,128}$/u.test(session)) return invalid('session');
  if (command === 'check-config' && session !== undefined) return invalid('session');
  const file = filePath ? await configurationFile(filePath) : {};
  const defaults: Partial<Record<Field, unknown>> = { adapter: 'chat-completions', cwd: launchCwd,
    tools: ['read', 'list', 'find', 'search'], maxSteps: 8, contextBytes: 1048576,
    outputReserveBytes: 0, modelTimeoutMs: 30000, stream: false };
  const values: Partial<Record<Field, unknown>> = {};
  const sources = {} as ProductConfig['sources'];
  for (const field of fields) {
    const environmentValue = env[environment[field]];
    sources[field] = cli[field] !== undefined ? 'cli' : environmentValue !== undefined ? 'environment'
      : file[field] !== undefined ? 'file' : 'default';
    values[field] = sources[field] === 'cli' ? cli[field] : sources[field] === 'environment' ? environmentValue
      : sources[field] === 'file' ? file[field] : defaults[field];
  }
  if (values.adapter !== 'chat-completions') return invalid('adapter', 'Only chat-completions is supported.');
  const endpoint = text(values.endpoint, 'endpoint');
  try {
    const url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash
      || !(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:'
        && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return invalid('endpoint');
  } catch { return invalid('endpoint', 'Use an exact HTTPS URL without userinfo/query/fragment, or explicit --allow-http for loopback fixtures.'); }
  const credentialRef = text(values.credentialRef, 'credentialRef', 256);
  if (credentialRef !== 'anonymous' && !/^env:[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialRef)) return invalid('credentialRef', 'Use env:VARIABLE_NAME or explicit anonymous.');
  const path = (field: 'cwd' | 'stateDir') => {
    const value = text(values[field], field);
    if (sources[field] === 'environment' && !isAbsolute(value)) return invalid(field, 'Environment paths must be absolute.');
    return resolve(sources[field] === 'file' ? dirname(filePath!) : launchCwd, value);
  };
  let cwd: string;
  try {
    cwd = await realpath(path('cwd'));
    if (!(await stat(cwd)).isDirectory()) return invalid('cwd');
  } catch { return invalid('cwd', 'Select an existing controlled directory.'); }
  const stateDir = path('stateDir');
  const selected = typeof values.tools === 'string' ? values.tools.split(',') : values.tools;
  if (!Array.isArray(selected) || selected.length > toolNames.length
    || selected.some(tool => !toolNames.includes(tool)) || new Set(selected).size !== selected.length) return invalid('tools');
  if (selected.some(tool => ['write', 'edit'].includes(tool)) && !allowWrite) return invalid('tools', 'Pass --allow-write explicitly on this invocation to select write/edit.');
  if (selected.includes('command') && !allowCommand) return invalid('tools', 'Pass --allow-command explicitly on this invocation to select command; this is not a sandbox.');
  const stream = values.stream === 'true' ? true : values.stream === 'false' ? false : values.stream;
  if (typeof stream !== 'boolean') return invalid('stream');
  const contextBytes = integer(values.contextBytes, 'contextBytes', 1, 1048576);
  const outputReserveBytes = integer(values.outputReserveBytes, 'outputReserveBytes', 0, contextBytes - 1);
  let reviewedCommand = values.command;
  if (typeof reviewedCommand === 'string') {
    try {
      if (Buffer.byteLength(reviewedCommand) > 65536) return invalid('command');
      reviewedCommand = JSON.parse(reviewedCommand);
    } catch { return invalid('command', 'Provide a bounded JSON object containing explicit env and reviewed exact specs.'); }
  }
  if (reviewedCommand !== undefined && (!reviewedCommand || typeof reviewedCommand !== 'object'
    || Array.isArray(reviewedCommand))) return invalid('command');
  return {
    command: command as ProductArguments['command'], allowWrite,
    ...(session ? { session } : {}), ...(input !== undefined ? { input } : {}),
    config: { adapter: 'chat-completions', endpoint, model: text(values.model, 'model', 256), credentialRef,
      cwd, stateDir, tools: [...selected], sources, stream, contextBytes, outputReserveBytes,
      ...(reviewedCommand !== undefined ? { command: reviewedCommand as LocalToolOptions['command'] } : {}),
      maxSteps: integer(values.maxSteps, 'maxSteps', 1, 100),
      modelTimeoutMs: integer(values.modelTimeoutMs, 'modelTimeoutMs', 1, 300000) },
  };
}

/** One real producer factory owns tools, permission and live environments.
 * The selected data is not authority until current invocation opt-ins admit it. */
export function createProductBinding(invocation: ProductArguments, credential?: string) {
  try {
    const { config } = invocation;
    return createLocalToolBinding({
      root: config.cwd, cwd: config.cwd, allowWrite: invocation.allowWrite,
      allowCommand: config.tools.includes('command'), command: config.command,
      ...(credential ? { redact: [credential] } : {}),
    });
  } catch {
    return invalid('binding', 'Select a canonical controlled directory and valid reviewed command executable/argv/effect/env; settle old execution before rebuilding.');
  }
}

/** Specs/argv and environment values are caller data, not public diagnostics. */
export function publicConfiguration(config: ProductConfig) {
  const { command: _command, ...configuration } = config;
  return configuration;
}

/** Resolved only in memory. Never returned in configuration, receipts or diagnostics. */
export function resolveCredential(config: ProductConfig, env: NodeJS.ProcessEnv): string | undefined {
  if (config.credentialRef === 'anonymous') return undefined;
  const token = env[config.credentialRef.slice(4)];
  if (!token?.trim() || token.length > 4096 || /[\x00-\x1f\x7f]/u.test(token)) return invalid('credentialRef', 'Set the referenced credential environment variable to a valid nonempty value.');
  if (containsCredential(config, token)) return invalid('credentialRef', 'Keep the credential value separate from public configuration.');
  return token;
}

/** Exact configured secret protection, not heuristic detection of arbitrary user secrets. */
export function containsCredential(value: unknown, token: string): boolean {
  return typeof value === 'string' ? value.includes(token)
    : value !== null && typeof value === 'object' && Object.entries(value)
      .some(([key, child]) => key.includes(token) || containsCredential(child, token));
}
