import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

/**
 * Hardened, isolated Git runner for per-Task artifact repositories.
 *
 * Artifact repositories are local-only working stores for product files
 * (plans, prototypes, charts, reports). Their contents are DATA authored by
 * agents and, indirectly, by product material — never trusted to configure or
 * drive the Git process. Every managed invocation therefore runs with a
 * scrubbed environment and a fixed set of hardening options that:
 *
 *   - block ALL network/file transports (`protocol.allow=never`, and an
 *     explicit `protocol.file.allow=never`), so no `fetch`/`clone`/`push`
 *     can move bytes even if a rogue remote is configured;
 *   - disable hooks (`core.hooksPath` → null device) so a committed hook
 *     script can never execute;
 *   - refuse to read user/system config or attributes
 *     (`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` → null device,
 *     `GIT_CONFIG_NOSYSTEM`, `GIT_ATTR_NOSYSTEM`), so external filters,
 *     signing programs, pagers and editors cannot be injected;
 *   - never prompt (`GIT_TERMINAL_PROMPT=0`, askpass disabled) and fail
 *     closed on any transport helper (`GIT_SSH_COMMAND=false`);
 *   - pin a fixed committer/author identity so commits succeed without
 *     inheriting ambient user config.
 *
 * The runner also refuses caller-supplied `-c`/`-C`/`--exec`/`--upload-pack`/
 * `--receive-pack` arguments: hardening flags are prepended here and callers
 * pass only fixed subcommands with data after `--`, so there is no channel to
 * pass through options that could re-enable transport or run a program.
 */

const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

/**
 * Fixed option flags prepended to every managed invocation. These are applied
 * before the subcommand and can never be overridden by repository-local config,
 * because global/system config is disabled and no caller `-c` is accepted.
 */
const HARDENING_FLAGS: readonly string[] = Object.freeze([
  // Identity — commits succeed without ambient user config.
  "-c", "user.name=Yui",
  "-c", "user.email=yui@local",
  // Transport — nothing may move over the network or the filesystem.
  "-c", "protocol.allow=never",
  "-c", "protocol.file.allow=never",
  // Hooks / filters / external programs — no committed script may execute.
  "-c", `core.hooksPath=${NULL_DEVICE}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "core.editor=false",
  // Signing — never shell out to a signing program.
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
  // Determinism / quiet.
  "-c", "core.autocrlf=false",
  "-c", "gc.auto=0",
  "-c", "advice.detachedHead=false"
]);

/** Arguments a caller may never pass: they could re-enable transport or run a program. */
const FORBIDDEN_ARGUMENTS: readonly string[] = Object.freeze([
  "-c", "-C", "--exec-path", "--upload-pack", "--receive-pack", "--exec"
]);

/** Raised when a managed Git command exits non-zero. Carries the exact stderr. */
export class ManagedGitError extends Error {
  readonly stderr: string;
  readonly args: readonly string[];
  constructor(args: readonly string[], stderr: string, cause?: unknown) {
    super(stderr.length === 0 ? "Managed git command failed." : `Managed git command failed: ${stderr}`, { cause });
    this.name = "ManagedGitError";
    this.stderr = stderr;
    this.args = args;
  }
}

export type ManagedGitOptions = Readonly<{
  /** Upper bound on combined stdout+stderr. Defaults to 16 MiB. */
  maxBuffer?: number;
  /** Kill the process after this many milliseconds. Defaults to 30s. */
  timeoutMs?: number;
}>;

/** Build the scrubbed environment for a managed Git process. Never inherits ambient Git config. */
function managedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    // A minimal, deterministic PATH so `git` (and only trusted helpers) resolve.
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    // A neutral HOME keeps any accidental lookup inside a controlled area; config
    // lookups are already redirected to the null device below.
    HOME: process.platform === "win32" ? (process.env.USERPROFILE ?? "") : "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_SSH_COMMAND: "false",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "false",
    // Fixed identity as a second guarantee alongside the -c flags.
    GIT_AUTHOR_NAME: "Yui",
    GIT_AUTHOR_EMAIL: "yui@local",
    GIT_COMMITTER_NAME: "Yui",
    GIT_COMMITTER_EMAIL: "yui@local"
  };
}

function assertSafeArguments(args: readonly string[]): void {
  for (const arg of args) {
    if (typeof arg !== "string") throw new Error("Managed git argument must be a string.");
    if (arg.includes("\0")) throw new Error("Managed git argument contains a NUL byte.");
    if (FORBIDDEN_ARGUMENTS.includes(arg)) {
      throw new Error(`Managed git argument is not permitted: ${arg}.`);
    }
  }
}

/**
 * Core managed invocation. `-C repoPath` and the hardening flags are supplied
 * here; `args` carries only the subcommand and its data. Returns raw stdout and
 * stderr buffers; throws {@link ManagedGitError} on non-zero exit.
 */
async function spawnManagedGit(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  assertSafeArguments(args);
  try {
    const result = await executeFile(
      "git",
      [...HARDENING_FLAGS, "-C", repoPath, ...args],
      {
        encoding: "buffer",
        env: managedGitEnvironment(),
        maxBuffer: options?.maxBuffer ?? 16 * 1024 * 1024,
        timeout: options?.timeoutMs ?? 30_000,
        windowsHide: true
      }
    );
    return { stdout: result.stdout as Buffer, stderr: result.stderr as Buffer };
  } catch (error) {
    const stderr = readErrorStream(error);
    throw new ManagedGitError([...args], stderr, error);
  }
}

function readErrorStream(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr)) return stderr.toString("utf8").trim();
    if (typeof stderr === "string") return stderr.trim();
  }
  return "";
}

/** Run a managed Git command and return trimmed UTF-8 stdout. Throws on failure. */
export async function managedGit(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): Promise<string> {
  const { stdout } = await spawnManagedGit(repoPath, args, options);
  return stdout.toString("utf8");
}

/** Run a managed Git command and return raw stdout bytes (for reading blob content). Throws on failure. */
export async function managedGitBuffer(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): Promise<Buffer> {
  const { stdout } = await spawnManagedGit(repoPath, args, options);
  return stdout;
}

/** Run a managed Git command purely for its exit status; never throws on non-zero. */
export async function managedGitSucceeds(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): Promise<boolean> {
  try {
    await spawnManagedGit(repoPath, args, options);
    return true;
  } catch (error) {
    if (error instanceof ManagedGitError) return false;
    throw error;
  }
}

/** Validate and normalize a Git object id from managed output (40- or 64-hex). */
export function requireCommitId(value: string): string {
  const commit = value.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) {
    throw new Error("Managed git returned an invalid commit id.");
  }
  return commit;
}
