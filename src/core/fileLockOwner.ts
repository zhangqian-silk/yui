import { lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { nativeExecutable } from "../runtime/nativeExecutable.js";

/** One process generation, shared by file-lock producers and reclaim checks. */
export function currentFileLockOwner(): string {
  return `${process.pid}:${currentProcessStartIdentity()}`;
}

/**
 * Identity of the current process. Linux reads the /proc start-time field,
 * which survives PID reuse. macOS uses libproc's process start timestamp.
 */
export function currentProcessStartIdentity(): string {
  const identity = readProcessStartIdentity(process.pid);
  if (identity === undefined) throw new Error(`Process start identity is unavailable for PID ${process.pid}.`);
  return identity;
}

export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === "linux") {
    try { return readProcessStart(pid); } catch { return undefined; }
  }
  if (process.platform !== "darwin") return undefined;
  try {
    const identity = execFileSync(
      nativeExecutable("process-identity"),
      [String(pid)],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return /^(0|[1-9][0-9]{0,31})$/u.test(identity) ? identity : undefined;
  } catch {
    return undefined;
  }
}

/**
 * False requires proof of absence or a different process generation.
 * Missing publication, invalid identity and unavailable OS evidence are not
 * dead owners: callers retain the lock and report the bounded diagnosis.
 */
export function fileLockOwnerIsLive(lock: string): boolean {
  let owner: string;
  try {
    owner = readFileSync(join(lock, "owner"), "utf8").trim();
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      try { lstatSync(lock); }
      catch (statError) {
        if (hasCode(statError, "ENOENT")) return false;
      }
    }
    throw unverified(lock);
  }
  const match = /^([1-9][0-9]*):(0|[1-9][0-9]{0,31})$/u.exec(owner);
  const pid = Number(match?.[1]);
  if (match === null || !Number.isSafeInteger(pid)) throw unverified(lock);
  try { return processGenerationIsLive(pid, match[2]!); }
  catch { throw unverified(lock); }
}

/** A known generation is live, provably gone, or unverified (throws). */
export function processGenerationIsLive(pid: number, startIdentity: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^(0|[1-9][0-9]{0,31})$/u.test(startIdentity)) {
    throw new Error(`Unverified process generation for PID ${pid}.`);
  }
  const actual = readProcessStartIdentity(pid);
  if (actual !== undefined) return actual === startIdentity;
  // PID liveness can prove a process is gone, never prove its generation.
  try { process.kill(pid, 0); }
  catch (error) { if (hasCode(error, "ESRCH")) return false; }
  throw new Error(`Unverified process generation for PID ${pid}; OS identity could not be read.`);
}

/**
 * Owner liveness used by reconciliation. An unreadable identity for a live
 * PID is unknown and must not authorize cleanup or release of durable custody.
 */
export function processOwnerIsLive(pid: number, startIdentity: string): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || !/^(0|[1-9][0-9]{0,31})$/u.test(startIdentity)) {
    throw new Error(`Unverified process generation for PID ${pid}.`);
  }
  return processGenerationIsLive(pid, startIdentity);
}

function readProcessStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  const start = close < 0 ? undefined : stat.slice(close + 2).trim().split(/\s+/u)[19];
  if (start === undefined || !/^(0|[1-9][0-9]{0,31})$/u.test(start)) {
    throw new Error(`Process start identity is unavailable for PID ${pid}.`);
  }
  return start;
}

function unverified(lock: string): Error {
  return new Error(`Unverified lock owner identity: ${lock}. Preserve the lock and inspect its owner before cleanup.`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
