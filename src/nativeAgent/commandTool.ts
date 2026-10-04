import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Json, Tool, ToolError, ToolOutcome } from './index.js';

export type CommandToolOptions = {
  root: string;
  /** Complete child environment. Never merged with process.env. */
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** Combined stdout/stderr capture limit; excess output stops execution. */
  maxOutputBytes?: number;
  killGraceMs?: number;
};

const failure = (code: string, message: string, effect: 'none' | 'unknown' = 'none'): ToolOutcome =>
  ({ ok: false, error: { code, message, effect } });
const inRoot = (root: string, cwd: string) => {
  const relative = path.relative(root, cwd);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const bounded = (value: number, maximum: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer in [1, ${maximum}]`);
  }
  return value;
};

/**
 * Controlled POSIX commands only, not an OS sandbox. Commands can access paths
 * outside cwd, perform external effects, or escape the process group themselves.
 * Callers must authorize the executable/arguments and supply a deliberate env.
 */
export function createCommandTool(options: CommandToolOptions): Tool {
  if (process.platform === 'win32') throw new Error('Command tool requires POSIX process groups');
  if (!options || typeof options.root !== 'string' || !path.isAbsolute(options.root)) {
    throw new Error('An explicit absolute workspace root is required');
  }
  const root = realpathSync(options.root);
  if (!statSync(root).isDirectory()) throw new Error('Workspace root must be a directory');
  if (!options.env || typeof options.env !== 'object' || Array.isArray(options.env)
    || Object.entries(options.env).some(([key, value]) =>
      !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))) {
    throw new Error('An explicit string environment without NUL or invalid keys is required');
  }
  const env = { ...options.env };
  const timeoutMs = bounded(options.timeoutMs ?? 10_000, 60_000, 'timeoutMs');
  const maxOutputBytes = bounded(options.maxOutputBytes ?? 64 * 1024, 64 * 1024, 'maxOutputBytes');
  const killGraceMs = bounded(options.killGraceMs ?? 100, 1000, 'killGraceMs');
  const validate = (args: Json): ToolError | null => {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !['command', 'argv', 'cwd'].includes(key))
      || typeof args.command !== 'string' || !path.isAbsolute(args.command) || args.command.includes('\0')
      || typeof args.cwd !== 'string' || !path.isAbsolute(args.cwd) || args.cwd.includes('\0')
      || !Array.isArray(args.argv) || args.argv.length > 256
      || args.argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))
      // Evidence echoes argv. Its JSON string is encoded once more in the
      // ToolOutcome: reserve room for 64KiB of worst-case control-byte output
      // (7x after both JSON encodings) within the public 512KiB message bound.
      || Buffer.byteLength(JSON.stringify(args)) > 16 * 1024) {
      return { code: 'invalid_arguments', message: 'Expected absolute command/cwd and bounded string argv only', effect: 'none' };
    }
    if (!inRoot(root, path.resolve(args.cwd))) {
      return { code: 'path_out_of_scope', message: 'cwd must be within the explicit workspace root', effect: 'none' };
    }
    return null;
  };
  return {
    definition: {
      name: 'command',
      description: 'Execute an explicitly authorized POSIX executable and argv in a controlled workspace; no implicit shell or OS sandbox',
      inputSchema: {
        type: 'object', properties: {
          command: { type: 'string', description: 'Absolute executable path' },
          argv: { type: 'array', items: { type: 'string' }, maxItems: 256 },
          cwd: { type: 'string', description: 'Absolute working directory within configured root' },
        }, required: ['command', 'argv', 'cwd'], additionalProperties: false,
      },
    },
    validate,
    async execute(args, _scope, signal): Promise<ToolOutcome> {
      const invalid = validate(args);
      if (invalid) return { ok: false, error: invalid };
      if (signal.aborted) return failure('cancelled_before_start', 'Command was not started');
      const input = args as { command: string; argv: string[]; cwd: string };
      // Copy caller-owned data before spawning; direct execute calls receive the
      // same checks as calls through the Agent loop.
      const command = input.command;
      const argv = [...input.argv];
      let cwd: string;
      try {
        cwd = realpathSync(input.cwd);
        if (!inRoot(root, cwd)) return failure('path_out_of_scope', 'Resolved cwd is outside workspace root');
        if (!statSync(cwd).isDirectory()) return failure('invalid_cwd', 'cwd is not a directory');
      } catch {
        return failure('invalid_cwd', 'cwd cannot be resolved as an accessible directory');
      }
      return new Promise<ToolOutcome>(resolve => {
        let child;
        try {
          child = spawn(command, argv, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          resolve(failure('spawn_failed', `Command could not be spawned (${(error as NodeJS.ErrnoException).code ?? 'unknown'})`));
          return;
        }
        let settled = false;
        let started = false;
        let directChildExited = false;
        let exitCode: number | null = null;
        let exitSignal: NodeJS.Signals | null = null;
        let reason: string | undefined;
        let processErrorCode: string | null = null;
        let captured = 0;
        let outputTruncated = false;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const signalErrors: string[] = [];
        let grace: NodeJS.Timeout | undefined;
        let settle: NodeJS.Timeout | undefined;
        const groupState = (): 'absent' | 'present' | 'unknown' => {
          if (!child.pid) return 'absent';
          try { process.kill(-child.pid, 0); return 'present'; }
          catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unknown'; }
        };
        const signalGroup = (kind: NodeJS.Signals) => {
          if (!child.pid) return;
          try { process.kill(-child.pid, kind); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ESRCH') signalErrors.push(`${kind}:${code ?? 'unknown'}`);
          }
        };
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          clearTimeout(grace);
          clearTimeout(settle);
          signal.removeEventListener('abort', abort);
          child.stdout.destroy();
          child.stderr.destroy();
          // A failure to observe termination must not keep the caller waiting
          // forever. Keep the pid and uncertainty in the returned evidence.
          child.unref();
          const evidence = {
            command, argv, cwd, pid: child.pid ?? null, exitCode, signal: exitSignal,
            stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'),
            capturedBytes: captured, outputTruncated, directChildExited,
            processGroup: groupState(), signalErrors, processErrorCode,
            descendantsMayHaveEscaped: true,
          };
          resolve(reason
            ? failure(reason, JSON.stringify(evidence), started ? 'unknown' : 'none')
            : { ok: true, content: JSON.stringify(evidence) });
        };
        const stop = (code: string) => {
          if (settled || reason) return;
          reason = code;
          signalGroup('SIGTERM');
          grace = setTimeout(() => {
            signalGroup('SIGKILL');
            // Bound observation after escalation; never infer quiescence from a
            // successful signal syscall, or wait forever on inherited pipes.
            settle = setTimeout(finish, 100);
          }, killGraceMs);
        };
        const abort = () => stop('cancelled');
        const deadline = setTimeout(() => stop('timeout'), timeoutMs);
        signal.addEventListener('abort', abort, { once: true });
        const capture = (target: Buffer[], chunk: Buffer) => {
          const available = maxOutputBytes - captured;
          if (available > 0) {
            const kept = chunk.subarray(0, available);
            target.push(Buffer.from(kept));
            captured += kept.length;
          }
          if (chunk.length > available) {
            outputTruncated = true;
            stop('output_limit');
          }
        };
        child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
        child.once('spawn', () => { started = true; });
        child.once('error', error => {
          processErrorCode = (error as NodeJS.ErrnoException).code ?? 'unknown';
          if (started) stop('process_error');
          else { reason = 'spawn_failed'; finish(); }
        });
        child.once('exit', (code, receivedSignal) => {
          directChildExited = true;
          exitCode = code;
          exitSignal = receivedSignal;
          if (!reason && groupState() !== 'absent') stop('background_processes');
        });
        child.once('close', () => {
          if (!reason) finish();
        });
        if (signal.aborted) abort();
      });
    },
  };
}
