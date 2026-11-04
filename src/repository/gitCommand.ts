import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { DEFAULT_GIT_LOCAL_TIMEOUT_SECONDS } from "../config/gitConfig.js";

export const LOCAL_GIT_TIMEOUT_MS = DEFAULT_GIT_LOCAL_TIMEOUT_SECONDS * 1_000;

export type GitCommandBudget = Readonly<{
  totalMs: number;
  /** Silence on both stdout and stderr; omitted for short local operations. */
  inactivityMs?: number;
}>;
export type GitTimeoutKind = "inactivity" | "total";

/** Retain process facts independently of Git's last progress/error output. */
export class GitCommandError extends Error {
  readonly code: number | string | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly stderrTruncated: boolean;

  constructor(
    cause: unknown,
    readonly timeoutKind: GitTimeoutKind | undefined,
    readonly budget: GitCommandBudget,
    readonly elapsedMs: number,
    output: Readonly<{
      stdout: Buffer; stderr: Buffer; stderrTruncated: boolean; exitCode: number | null; signal: string | null;
    }>
  ) {
    const failure = cause as { code?: number | string; message?: string } | undefined;
    const code = failure?.code ?? output.exitCode;
    const exitCode = output.exitCode;
    const stderr = output.stderr.toString("utf8").trim();
    const reasons = [
      ...(timeoutKind === undefined ? [] : [
        `${timeoutKind === "inactivity" ? "no-progress timeout" : "total timeout"} after `
        + `${timeoutKind === "inactivity" ? budget.inactivityMs : budget.totalMs} ms`
      ]),
      ...(exitCode === null ? [] : [`exit code ${exitCode}`]),
      ...(output.signal === null ? [] : [`signal ${output.signal}`]),
      ...(typeof code === "string" ? [`${code}: ${failure?.message ?? "process error"}`] : [])
    ];
    if (reasons.length === 0) reasons.push(failure?.message ?? "unknown process failure");
    super(`Git command failed (${reasons.join("; ")}; elapsed ${elapsedMs} ms)`
      + (stderr.length === 0 ? "." : `: ${output.stderrTruncated ? "[stderr tail; earlier output omitted] " : ""}${stderr}`), { cause });
    this.name = "GitCommandError";
    this.code = code;
    this.exitCode = exitCode;
    this.signal = output.signal;
    this.stdout = output.stdout;
    this.stderr = stderr;
    this.stderrTruncated = output.stderrTruncated;
  }
}

/**
 * One buffered invocation, never retried. Output refreshes only the inactivity
 * clock; the total deadline never moves. At the hard deadline, kill the owned
 * process group (including transport helpers) before reporting completion.
 */
export async function executeGitCommand(
  program: string,
  args: readonly string[],
  options: Readonly<{
    budget?: GitCommandBudget;
    maxBuffer?: number;
    environment?: NodeJS.ProcessEnv;
    input?: string;
    /** Keep only the stderr tail for potentially large remote progress logs. */
    stderrTail?: boolean;
  }> = {}
): Promise<{ stdout: Buffer; stderr: Buffer; stderrTruncated: boolean }> {
  const budget = options.budget ?? { totalMs: LOCAL_GIT_TIMEOUT_MS };
  for (const value of [budget.totalMs, ...(budget.inactivityMs === undefined ? [] : [budget.inactivityMs])]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new TypeError("Git timeout budgets must be positive integer milliseconds within the timer range.");
    }
  }
  const started = performance.now();
  const child = spawn(program, args, {
    ...(options.environment === undefined ? {} : { env: options.environment }),
    detached: process.platform !== "win32",
    windowsHide: true
  });
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let stderrTruncated = false;
  let failure: unknown;
  let timeoutKind: GitTimeoutKind | undefined;
  let terminationError: unknown;
  const terminate = () => {
    try {
      if (child.pid !== undefined && process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else {
        child.kill("SIGKILL");
      }
    } catch (error) {
      terminationError = error;
      child.kill("SIGKILL");
    }
  };
  const expire = (kind: GitTimeoutKind) => {
    if (timeoutKind !== undefined || failure !== undefined) return;
    timeoutKind = kind;
    terminate();
  };
  child.once("error", error => { failure ??= error; });
  const completion = new Promise<{ exitCode: number | null; signal: string | null }>(settle => {
    child.once("close", (exitCode, signal) => settle({
      // A negative close code is an OS spawn error, not a process exit.
      exitCode: exitCode !== null && exitCode >= 0 ? exitCode : null, signal
    }));
  });
  const totalTimer = setTimeout(() => expire("total"), budget.totalMs);
  const inactivityTimer = budget.inactivityMs === undefined
    ? undefined : setTimeout(() => expire("inactivity"), budget.inactivityMs);
  const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (chunk.length === 0) return;
    if (timeoutKind === undefined && failure === undefined) inactivityTimer?.refresh();
    if (stream === "stderr" && options.stderrTail) {
      const limit = Math.min(maxBuffer, 64 * 1024);
      stderrTruncated ||= sizes.stderr + chunk.length > limit;
      const tail = Buffer.concat([...chunks.stderr, chunk]);
      chunks.stderr = [tail.subarray(Math.max(0, tail.length - limit))];
      sizes.stderr = Math.min(limit, tail.length);
      return;
    }
    const remaining = maxBuffer - sizes[stream];
    if (remaining > 0) {
      chunks[stream].push(chunk.subarray(0, remaining));
      sizes[stream] += Math.min(chunk.length, remaining);
    }
    if (chunk.length > remaining && failure === undefined) {
      failure = Object.assign(new Error(`${stream} maxBuffer length exceeded (${maxBuffer} bytes).`),
        { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
      terminate();
    }
  };
  child.stdout.on("data", chunk => collect("stdout", chunk));
  child.stderr.on("data", chunk => collect("stderr", chunk));
  child.stdin.on("error", error => {
    failure ??= error;
    terminate();
  });
  try {
    child.stdin.end(options.input);
    const status = await completion;
    const result = { stdout: Buffer.concat(chunks.stdout), stderr: Buffer.concat(chunks.stderr), stderrTruncated };
    if (failure !== undefined || timeoutKind !== undefined || status.exitCode !== 0 || status.signal !== null) {
      const error = new GitCommandError(failure, timeoutKind, budget,
        Math.round(performance.now() - started), { ...result, ...status });
      if (terminationError !== undefined) {
        throw new AggregateError([error, terminationError],
          `${error.message} Process-group termination failed; helper effects are unconfirmed.`, { cause: error });
      }
      throw error;
    }
    return result;
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(inactivityTimer);
  }
}
