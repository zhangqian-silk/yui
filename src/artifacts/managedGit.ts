import { execFile, execFileSync } from "node:child_process";
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
  /**
   * Sync-migration only: pin the author and committer dates so a rebuild of the
   * same historical data produces the same commit hashes. These env vars affect
   * only commit metadata — they can never re-enable transport, run a hook, or
   * execute a program — so applying them keeps the trust boundary intact. Only
   * honored by the synchronous runner; the async production runner ignores it.
   */
  commitDates?: Readonly<{ author: string; committer: string }>;
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
    // Every pathspec is a literal path, never a glob. A file legitimately named
    // `*.md` or `a?.md` must commit exactly itself and never sweep in undeclared
    // sibling changes; this makes `add`/`diff`/`commit --only` scope uniformly
    // and can never re-enable transport or run a program.
    GIT_LITERAL_PATHSPECS: "1",
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

/**
 * Repo-local config keys that can make Git execute an EXTERNAL PROGRAM during an
 * ordinary `add`/`diff`/`commit`/`show` — the vector env-scrubbing does not close.
 *
 * Disabling global/system config (see {@link managedGitEnvironment}) stops
 * ambient filters/hooks, but a repository's OWN `.git/config` is always read, and
 * a `[filter "x"] clean = <cmd>` there (paired with a worktree `.gitattributes`
 * `* filter=x`) runs `<cmd>` on `git add`. Some keys (`core.pager`, hooks, signing)
 * are already forced to safe values by the `-c` {@link HARDENING_FLAGS}, but an
 * arbitrarily NAMED filter/alias/tool driver cannot be overridden by a fixed `-c`.
 *
 * Yui configures NONE of these on a managed artifact repository, so any that
 * appear in repo-local config are external tampering. We DETECT and STOP (like an
 * unexpected remote); we never silently delete the config or try to out-configure
 * an arbitrary command. Keys are matched case-insensitively (Git config is).
 *
 * The direct scan sees only repo-local keys, so it also rejects the config
 * INCLUSION entry points (`include.*`, `includeIf.*`, `extensions.worktreeConfig`)
 * that could otherwise hide any of the below in a file this scan never opens —
 * see {@link isExternalProgramConfigKey}.
 */
const EXTERNAL_PROGRAM_CONFIG_SUFFIXES: readonly string[] = Object.freeze([
  ".clean", ".smudge", ".process", // filter.<name>.*
  ".command", ".textconv", ".cmd", // diff/difftool/mergetool.<name>.*
  ".driver", // merge.<name>.driver
  ".helper" // credential[.<url>].helper
]);
const EXTERNAL_PROGRAM_CONFIG_PREFIXES: readonly string[] = Object.freeze([
  "filter.", "alias.", "difftool.", "mergetool.", "pager.",
  "sendemail.", "instaweb.", "guitool.", "credential.", "url.",
  "browser.", "man.", "hooks."
]);
const EXTERNAL_PROGRAM_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "diff.external",
  "core.pager", "core.editor", "core.sshcommand", "core.askpass",
  "core.gitproxy", "core.fsmonitor", "core.hookspath", "core.alternaterefscommand",
  "gpg.program", "gpg.openpgp.program", "gpg.x509.program", "gpg.ssh.program",
  "sequence.editor", "uploadpack.packobjectshook",
  "web.browser", "help.browser"
]);

/**
 * Config keys that IMPORT or ENABLE another config scope. `git config --local
 * --list -z` lists these keys but does NOT expand them, so a `filter.*.clean`
 * hidden inside an included file (or the per-worktree config) is invisible to
 * the direct external-program scan above — yet an ordinary `git add`/`status`
 * DOES follow includes and would run that hidden filter. A managed artifact
 * repository never needs an include or a per-worktree config, so we reject the
 * ENTRY POINT itself rather than parsing the (arbitrary, possibly nested)
 * included files: `include.path`, any `includeIf.<condition>.path`, and the
 * `extensions.worktreeConfig` switch that activates `.git/config.worktree`.
 * Keys are already lower-cased by Git config.
 */
const CONFIG_INCLUSION_CONFIG_PREFIXES: readonly string[] = Object.freeze([
  "include.", "includeif."
]);
const CONFIG_INCLUSION_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "extensions.worktreeconfig"
]);

function isExternalProgramConfigKey(key: string): boolean {
  if (EXTERNAL_PROGRAM_CONFIG_KEYS.has(key)) return true;
  for (const prefix of EXTERNAL_PROGRAM_CONFIG_PREFIXES) if (key.startsWith(prefix)) return true;
  for (const suffix of EXTERNAL_PROGRAM_CONFIG_SUFFIXES) if (key.endsWith(suffix)) return true;
  // A config-inclusion / alternate-scope entry point can smuggle any of the
  // above in a file this direct scan never opens; reject the entry point itself.
  if (CONFIG_INCLUSION_CONFIG_KEYS.has(key)) return true;
  for (const prefix of CONFIG_INCLUSION_CONFIG_PREFIXES) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * Given the raw stdout of `git config --local --list -z` (records of the form
 * `key\nvalue\0`, keys already lower-cased by Git), return the sorted, de-duped
 * list of repo-local keys that can execute an external program. Empty means the
 * repository's own config is within the managed boundary.
 *
 * PURE: no I/O. Callers (sync migration and async runtime) read the config with
 * their own managed runner and pass the bytes here, so the security policy lives
 * in exactly one testable place. Reading `--local` deliberately excludes the
 * command-line `-c` hardening flags (which are safe and not persisted) and the
 * null-device'd global/system config; it sees only what is written in the repo.
 */
export function externalProgramConfigViolations(localConfigListZ: string): string[] {
  const offending = new Set<string>();
  for (const record of localConfigListZ.split("\0")) {
    if (record.length === 0) continue;
    const newline = record.indexOf("\n");
    const key = (newline < 0 ? record : record.slice(0, newline)).toLowerCase();
    if (isExternalProgramConfigKey(key)) offending.add(key);
  }
  return [...offending].sort();
}

/**
 * SYNCHRONOUS managed invocation, used ONLY where an async runner is
 * structurally impossible: a storage `migrateData(db)` step runs inside
 * `db.transaction(...)`, which better-sqlite3 requires to be synchronous, yet
 * the 18->19 migration must build per-Task artifact repositories on disk. This
 * shares the SAME hardening as {@link spawnManagedGit} — identical argument
 * refusal, identical scrubbed environment, identical prepended flags — so the
 * synchronous path never weakens the trust boundary. It is not exported for
 * ordinary runtime use; the async runner remains the only production write path.
 */
function spawnManagedGitSync(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): { stdout: Buffer; stderr: Buffer } {
  assertSafeArguments(args);
  const env = managedGitEnvironment();
  if (options?.commitDates !== undefined) {
    // Deterministic history: fixed author/committer dates make a rebuild of the
    // same source data reproduce the same commit ids. This only sets metadata.
    env.GIT_AUTHOR_DATE = options.commitDates.author;
    env.GIT_COMMITTER_DATE = options.commitDates.committer;
  }
  try {
    const stdout = execFileSync(
      "git",
      [...HARDENING_FLAGS, "-C", repoPath, ...args],
      {
        encoding: "buffer",
        env,
        maxBuffer: options?.maxBuffer ?? 16 * 1024 * 1024,
        timeout: options?.timeoutMs ?? 30_000,
        windowsHide: true
      }
    );
    return { stdout: stdout as Buffer, stderr: Buffer.alloc(0) };
  } catch (error) {
    throw new ManagedGitError([...args], readErrorStream(error), error);
  }
}

/** Synchronous counterpart to {@link managedGit}; returns trimmed UTF-8 stdout. */
export function managedGitSync(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): string {
  return spawnManagedGitSync(repoPath, args, options).stdout.toString("utf8");
}

/** Synchronous counterpart to {@link managedGitBuffer}; returns raw stdout bytes. */
export function managedGitSyncBuffer(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): Buffer {
  return spawnManagedGitSync(repoPath, args, options).stdout;
}

/** Synchronous counterpart to {@link managedGitSucceeds}; never throws on non-zero exit. */
export function managedGitSyncSucceeds(
  repoPath: string,
  args: readonly string[],
  options?: ManagedGitOptions
): boolean {
  try {
    spawnManagedGitSync(repoPath, args, options);
    return true;
  } catch (error) {
    if (error instanceof ManagedGitError) return false;
    throw error;
  }
}
