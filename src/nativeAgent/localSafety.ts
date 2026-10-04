import { lstatSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Json, Tool, ToolError, ToolOutcome } from './contracts.js';
import { createCodingTools, type CodingToolsOptions } from './codingTools.js';
import type { CommandToolOptions } from './commandTool.js';
import type { EnvironmentTool, ToolEnvironment, ToolInvocation, ToolPermission } from './toolManager/index.js';

/** Trusted caller review, NOT program analysis or an OS sandbox. Exact argv only. */
export type LocalCommandSpec = {
  executable: string;
  argv: readonly string[];
  effect: 'read' | 'write';
};
export type LocalToolOptions = {
  root: string;
  cwd: string;
  allowWrite?: boolean;
  allowCommand?: boolean;
  text?: CodingToolsOptions['text'];
  search?: CodingToolsOptions['search'];
  command?: Omit<CommandToolOptions, 'root'> & { specs: readonly LocalCommandSpec[] };
  /** Known secret literals to remove from outcomes, including JSON-escaped text.
   * No heuristic credential discovery; unlisted secrets in files/output remain caller responsibility. */
  redact?: readonly string[];
};
export type LocalToolDescription = Readonly<{
  root: string; cwd: string; allowWrite: boolean; allowCommand: boolean;
  envKeys: readonly string[]; commandCount: number;
}>;
/** A live opaque lease, not a serialized authority token. Copies are never accepted. */
export type LocalToolEnvironment = LocalToolDescription;
export type LocalToolBinding = Readonly<{
  binding: LocalToolDescription;
  tools: readonly EnvironmentTool<LocalToolEnvironment>[];
  environment: ToolEnvironment<LocalToolEnvironment>;
  permission: ToolPermission<LocalToolEnvironment>;
}>;

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
function fields(value: unknown, allowed: readonly string[]): boolean {
  return object(value) && Object.keys(value).every(key => allowed.includes(key));
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const invalid = (code: string, message: string): ToolError => ({ code, message, effect: 'none' });
function absolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0')
    && path.normalize(value) === value;
}
/** Reject symlinks in every component, not just the leaf. Controlled filesystems only. */
function directory(value: unknown): string {
  try {
    if (!absolute(value)) throw new Error();
    let current = path.parse(value).root;
    for (const component of value.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error();
    }
    if (!statSync(value).isDirectory() || realpathSync(value) !== value) throw new Error();
    return value;
  } catch { throw new Error('An accessible absolute directory without symlink components is required'); }
}
const inside = (root: string, cwd: string) => {
  const relative = path.relative(root, cwd);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
function directoryIdentity(value: string): string {
  try {
    directory(value);
    const stat = statSync(value);
    return `${stat.dev}:${stat.ino}`;
  } catch { throw new Error('Bound directory is unavailable; settle and rebuild the binding'); }
}
function executableIdentity(value: string): string {
  try {
    if (!absolute(value)) throw new Error();
    directory(path.dirname(value));
    const stat = lstatSync(value);
    if (!stat.isFile() || !(stat.mode & 0o111) || realpathSync(value) !== value) throw new Error();
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.mode}`;
  } catch { throw new Error('Reviewed executable must be an accessible absolute regular executable without symlinks'); }
}
function environment(value: unknown): Record<string, string> {
  // Deliberately small, complete environment. No HOME, config, proxies, tokens,
  // interpreter/loader injection or process.env merge. Widen only with a reviewed contract.
  if (!object(value) || Object.entries(value).some(([key, entry]) => {
    if (typeof entry !== 'string' || entry.includes('\0') || entry.length > 4096) return true;
    if (key === 'PATH') return entry.split(path.delimiter).some(part => !absolute(part));
    if (key === 'LANG' || key === 'LC_ALL') return !/^[A-Za-z0-9_.@-]{1,128}$/.test(entry);
    if (key === 'TZ') return !/^[A-Za-z0-9_+./-]{1,128}$/.test(entry) || entry.includes('..');
    return true;
  })) throw new Error('Command environment permits only deliberate PATH, LANG, LC_ALL and TZ values');
  return { ...value } as Record<string, string>;
}

/** One common factory owns the actual prebound tools and their matching lease.
 * Use with createToolExecutor, never the Agent's three-argument tools shorthand.
 * No resources are started during construction/acquisition; commandTool owns its processes.
 */
export function createLocalToolBinding(options: LocalToolOptions): LocalToolBinding {
  if (!fields(options, ['root', 'cwd', 'allowWrite', 'allowCommand', 'text', 'search', 'command', 'redact'])
    || [options.allowWrite, options.allowCommand].some(v => v !== undefined && typeof v !== 'boolean')
    || (options.text !== undefined && !fields(options.text, ['maxBytes']))
    || (options.search !== undefined && !fields(options.search,
      ['maxEntries', 'maxResults', 'maxOutputBytes', 'maxFileBytes', 'maxTotalBytes', 'maxDepth']))) {
    throw new Error('Invalid local tool configuration');
  }
  const root = directory(options.root);
  const cwd = directory(options.cwd);
  if (!inside(root, cwd)) throw new Error('cwd must be within the explicit root directory');
  const rootIdentity = directoryIdentity(root);
  const cwdIdentity = directoryIdentity(cwd);
  const allowWrite = options.allowWrite === true;
  const allowCommand = options.allowCommand === true;
  if (options.redact !== undefined && (!Array.isArray(options.redact) || options.redact.length > 128
    || options.redact.some(v => typeof v !== 'string' || !v.length || v.length > 4096))) {
    throw new Error('Invalid known-secret redaction configuration');
  }
  const secrets = [...(options.redact ?? [])].sort((a, b) => b.length - a.length);
  const secretPattern = secrets.length
    ? new RegExp(secrets.map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  const scrub = (text: string): string => secretPattern ? text.replace(secretPattern, '[REDACTED]') : text;
  const scrubJson = (text: string): string => {
    const visit = (value: Json): Json => typeof value === 'string' ? scrub(value)
      : Array.isArray(value) ? value.map(visit)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([k, v]) =>
            [k, k === 'sha256' ? v : visit(v)])) : value;
    try { return JSON.stringify(visit(JSON.parse(text) as Json)); }
    catch { return scrub(text); }
  };
  const specs: { spec: LocalCommandSpec; identity: string }[] = [];
  let commandOptions: Omit<CommandToolOptions, 'root'> | undefined;
  if (options.command !== undefined) {
    if (!fields(options.command, ['env', 'specs', 'timeoutMs', 'maxOutputBytes', 'killGraceMs'])
      || !Array.isArray(options.command.specs) || options.command.specs.length > 128) {
      throw new Error('Invalid reviewed command configuration');
    }
    const env = environment(options.command.env);
    for (const spec of options.command.specs) {
      if (!fields(spec, ['executable', 'argv', 'effect']) || !absolute(spec.executable)
        || !Array.isArray(spec.argv) || spec.argv.length > 256
        || spec.argv.some((v: unknown) => typeof v !== 'string' || v.includes('\0'))
        || !['read', 'write'].includes(spec.effect)
        || Buffer.byteLength(JSON.stringify(spec)) > 16 * 1024) {
        throw new Error('Invalid exact reviewed command specification');
      }
      if (specs.some(entry => entry.spec.executable === spec.executable
        && JSON.stringify(entry.spec.argv) === JSON.stringify(spec.argv))) {
        throw new Error('Duplicate reviewed command specification');
      }
      specs.push({ spec: freeze({ ...spec, argv: [...spec.argv] }), identity: executableIdentity(spec.executable) });
    }
    commandOptions = { env, timeoutMs: options.command.timeoutMs,
      maxOutputBytes: options.command.maxOutputBytes, killGraceMs: options.command.killGraceMs };
  }
  if (allowCommand && !commandOptions) throw new Error('Explicit command environment and specifications are required');
  // Validate command budgets even when disabled; do not silently ignore invalid configuration.
  const all = createCodingTools({
    root, text: options.text, search: options.search, command: commandOptions,
  });
  const description = freeze({
    root, cwd, allowWrite, allowCommand,
    envKeys: Object.keys(commandOptions?.env ?? {}).sort(), commandCount: specs.length,
  });
  // Object member order is not part of the public ToolInvocation contract.
  // Project its required identity fields; compare JSON values without sorting
  // arrays or weakening parameter/definition equality.
  const invocationValue = ({ identity, call, definition }: ToolInvocation) => [
    identity.sessionId, identity.turnId, identity.step, identity.toolCallId, identity.name,
    call.id, call.name, call.arguments, definition,
  ] as const;
  const active = new WeakMap<LocalToolEnvironment, ReturnType<typeof invocationValue>>();
  const matchingLease = (lease: LocalToolEnvironment, invocation: ToolInvocation) =>
    isDeepStrictEqual(active.get(lease), invocationValue(invocation));
  const selected = all.filter(tool => (allowWrite || !['write', 'edit'].includes(tool.definition.name))
    && (allowCommand || tool.definition.name !== 'command'));
  const definitions = new Map(selected.map(tool => [tool.definition.name,
    freeze(structuredClone(tool.definition))]));
  const fresh = () => directoryIdentity(root) === rootIdentity && directoryIdentity(cwd) === cwdIdentity;
  const validate = (tool: Tool, args: Json): ToolError | null => {
    const bad = tool.validate(args);
    if (bad) return bad;
    if (tool.definition.name !== 'command') return null;
    const input = args as { command: string; argv: string[]; cwd: string };
    const match = specs.find(({ spec }) => spec.executable === input.command && input.cwd === cwd
      && JSON.stringify(spec.argv) === JSON.stringify(input.argv));
    if (!match || (match.spec.effect === 'write' && !allowWrite)) {
      return invalid('command_not_authorized', 'Command requires an exact reviewed executable/argv/cwd and permitted effect');
    }
    try {
      if (executableIdentity(match.spec.executable) !== match.identity) throw new Error();
    } catch { return invalid('binding_changed', 'Reviewed executable changed; settle and rebuild the binding'); }
    return null;
  };
  const validInvocation = (invocation: ToolInvocation): boolean => {
    const name = invocation.call.name;
    return invocation.identity.name === name && invocation.identity.toolCallId === invocation.call.id
      && definitions.has(name) && isDeepStrictEqual(invocation.definition, definitions.get(name));
  };
  const tools = selected.map(tool => {
    const definition = definitions.get(tool.definition.name)!;
    return Object.freeze({
      definition,
      validate: (args: Json) => validate(tool, args),
      async execute(args, identity, signal, lease): Promise<ToolOutcome> {
        // Guard here too: a permissive foreign permission, copied value, expired
        // lease or the three-argument shorthand cannot bypass the actual tool.
        const invocation = { identity: { ...identity, name: definition.name },
          call: { id: identity.toolCallId, name: definition.name, arguments: args }, definition };
        if (!lease || !matchingLease(lease, invocation)) {
          return { ok: false, error: invalid('binding_mismatch', 'A matching live invocation lease is required') };
        }
        try {
          if (!fresh()) throw new Error();
        } catch { return { ok: false, error: invalid('binding_changed', 'Workspace changed; settle and rebuild the binding') }; }
        const bad = validate(tool, args);
        if (bad) return { ok: false, error: bad };
        const outcome = await tool.execute(args, identity, signal);
        return outcome.ok ? { ok: true, content: scrubJson(outcome.content) }
          : { ok: false, error: { ...outcome.error, message: scrubJson(outcome.error.message) } };
      },
    } satisfies EnvironmentTool<LocalToolEnvironment>);
  });
  return Object.freeze({
    binding: description, tools: Object.freeze(tools),
    environment: Object.freeze({
      async acquire(invocation: ToolInvocation, signal: AbortSignal) {
        if (signal.aborted || !validInvocation(invocation) || !fresh()) {
          throw new Error('Local binding unavailable or declaration mismatched');
        }
        const lease = Object.freeze({ ...description });
        active.set(lease, freeze(structuredClone(invocationValue(invocation))));
        return { value: lease, async release() { active.delete(lease); } };
      },
    }),
    permission: Object.freeze({
      async check(invocation: ToolInvocation, lease: LocalToolEnvironment, signal: AbortSignal) {
        try {
          if (signal.aborted || !validInvocation(invocation) || !matchingLease(lease, invocation)
            || !fresh()) throw new Error();
          const tool = selected.find(tool => tool.definition.name === invocation.call.name)!;
          if (validate(tool, invocation.call.arguments)) throw new Error();
          return { allowed: true as const };
        } catch { return { allowed: false as const, reason: 'Local binding or reviewed capability does not match this invocation' }; }
      },
    }),
  });
}
