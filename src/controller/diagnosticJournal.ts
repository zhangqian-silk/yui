import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { monotonicMilliseconds } from "../core/controllerTelemetry.js";
import { YUI_VERSION } from "../version.js";

// Operational evidence only: no business records, recovery policy or SQLite
// writes. Admission is bounded in memory and all filesystem work is async.
const MAX_RECORD_BYTES = 16 * 1024;
const MAX_PENDING = 32;
const NUMERIC_KEYS = new Set([
  "completed", "failed", "received", "inFlight", "maximumMs", "maximumLagMs",
  "maximumObservedAtMs", "oldestInFlightAgeMs", "startedAtMs", "elapsedMs",
  "ageMs", "depth", "semanticDepth", "progressDepth", "pendingKeys", "queueDepth",
  "hits", "rebuilds", "invalidations", "passes", "listedEvents", "selectedEvents"
]);
const CONTAINER_KEYS = new Set([
  "commands", "observations", "routes", "eventLoopDelay", "phases", "reads",
  "persistence", "main", "worker", "database", "roundTrips", "work", "body",
  "lock", "commit", "payloadReads", "inbox", "scheduler", "projectionCache",
  "active", "recent", "slowest", "latest"
]);
const ERROR_CODES = new Set([
  "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_IOERR", "SQLITE_FULL", "SQLITE_READONLY",
  "ENOENT", "EACCES", "EPERM", "ENOSPC", "CONTROLLER_TIMEOUT", "COMMAND_TIMED_OUT"
]);
const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function errorEvidence(error: unknown) {
  const frames: { module: string; line: number; column: number }[] = [];
  let candidate = error instanceof Error ? error : null;
  let code = "UNCLASSIFIED";
  const fingerprint = createHash("sha256").update((candidate?.message ?? "non-error").slice(0, 4096)).digest("hex");
  for (let depth = 0; candidate !== null && depth < 4; depth++) {
    const rawCode = "code" in candidate ? candidate.code : undefined;
    if (typeof rawCode === "string" && ERROR_CODES.has(rawCode)) code = rawCode;
    for (const line of (candidate.stack ?? "").slice(0, 8192).split("\n").slice(1, 12)) {
      const match = line.match(/(file:\/\/\/[^()]+):(\d+):(\d+)\)?$/);
      if (match === null || frames.length >= 8) continue;
      try {
        const module = relative(SOURCE_ROOT, fileURLToPath(match[1]!));
        // Only source locations inside this build; never keep the raw stack,
        // function names, absolute paths, exception text or user arguments.
        if (/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[jt]s$/.test(module)) {
          frames.push({ module, line: Number(match[2]), column: Number(match[3]) });
        }
      } catch { /* Not a source location. */ }
    }
    candidate = candidate.cause instanceof Error ? candidate.cause : null;
  }
  return { code, fingerprint, frames };
}

/** Allowlisted observations only; never serialize arbitrary errors or params. */
function safeSnapshot(value: unknown, depth = 0): unknown {
  if (depth > 10 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.slice(-4).map(item => safeSnapshot(item, depth + 1));
  const safe: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (NUMERIC_KEYS.has(key) && (typeof item === "boolean"
      || (typeof item === "number" && Number.isFinite(item)))) safe[key] = item;
    else if (CONTAINER_KEYS.has(key)) safe[key] = safeSnapshot(item, depth + 1);
    else if (key === "target" && typeof item === "string" && /^[a-f0-9]{16}$/.test(item)) safe[key] = item;
    else if (key === "phase" && typeof item === "string" && /^[a-z][a-z0-9.-]{0,63}$/.test(item)) safe[key] = item;
    else if (key === "instance" && typeof item === "string" && /^[a-f0-9-]{36}$/.test(item)) safe[key] = item;
    else if ((key === "running" || key === "pendingFull") && typeof item === "boolean") safe[key] = item;
  }
  return safe;
}

/** A bounded diagnostic journal, readable after exit/restart. Failure is counted
 * but cannot fail semantic work. Force-kill/disk failure can lose pending data. */
export class ControllerDiagnosticJournal {
  readonly #file: string;
  readonly #instance = randomUUID();
  readonly #maxBytes: number;
  readonly #pending: string[] = [];
  #drain: Promise<void> | undefined;
  #closed = false;
  #dropped = 0;
  #writeFailures = 0;
  #written = 0;
  #lastSampleAt = -Infinity;
  #observedThrough = 0;

  constructor(home: string, options: { maxBytes?: number } = {}) {
    this.#file = join(home, "runtime", "controller-diagnostics.jsonl");
    this.#maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new Error("Diagnostic file bound must be at least 1024 bytes.");
    }
  }

  error(error: unknown): void {
    this.#enqueue("error", { error: errorEvidence(error) });
  }

  sample(snapshot: unknown, lagMs: number): void {
    const now = monotonicMilliseconds();
    if (now - this.#lastSampleAt < 1000) { this.#dropped++; return; }
    this.#lastSampleAt = now;
    this.#enqueue("latency", { lagMs, snapshot: safeSnapshot(snapshot) });
  }

  /** Called with memory-only metric snapshots, never a Store read or RPC.
   * Retained completed samples are emitted once; long active work is bounded
   * by the one-second sample rate and rolling files. */
  observe(snapshot: unknown, lagMs: number): void {
    let anomaly = lagMs >= 1000;
    let through = this.#observedThrough;
    const visit = (value: unknown, depth: number): void => {
      if (depth > 10 || value === null || typeof value !== "object") return;
      const item = value as Record<string, unknown>;
      if (typeof item.startedAtMs === "number" && typeof item.elapsedMs === "number") {
        const finishedAt = item.startedAtMs + item.elapsedMs;
        if (finishedAt > this.#observedThrough && (item.elapsedMs >= 1000 || item.failed === true)) anomaly = true;
        through = Math.max(through, finishedAt);
      }
      if (typeof item.ageMs === "number" && item.ageMs >= 1000) anomaly = true;
      for (const child of Object.values(item)) visit(child, depth + 1);
    };
    visit(snapshot, 0);
    this.#observedThrough = through;
    if (anomaly) this.sample(snapshot, lagMs);
  }

  metrics() {
    return { written: this.#written, dropped: this.#dropped,
      writeFailures: this.#writeFailures, pending: this.#pending.length };
  }

  #enqueue(kind: "error" | "latency", detail: Record<string, unknown>): void {
    if (this.#closed) return;
    if (this.#pending.length >= MAX_PENDING) { this.#dropped++; return; }
    const line = JSON.stringify({ schemaVersion: 1, kind, at: new Date().toISOString(),
      monotonicMs: monotonicMilliseconds(), pid: process.pid, instance: this.#instance,
      version: YUI_VERSION, dropped: this.#dropped, ...detail }) + "\n";
    if (Buffer.byteLength(line) > Math.min(MAX_RECORD_BYTES, this.#maxBytes)) {
      this.#dropped++;
      return;
    }
    this.#pending.push(line);
    this.#startDrain();
  }

  #startDrain(): void {
    if (this.#drain === undefined) {
      this.#drain = this.#writePending().finally(() => {
        this.#drain = undefined;
        if (this.#pending.length > 0) this.#startDrain();
      });
    }
  }

  async #writePending(): Promise<void> {
    while (this.#pending.length > 0) {
      const line = this.#pending.shift()!;
      try {
        await mkdir(join(this.#file, ".."), { recursive: true, mode: 0o700 });
        let file = await this.#open();
        try {
          if ((await file.stat()).size + Buffer.byteLength(line) > this.#maxBytes) {
            await file.close();
            await rename(`${this.#file}.1`, `${this.#file}.2`).catch(error => {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            });
            await rename(this.#file, `${this.#file}.1`);
            file = await this.#open();
          }
          await file.writeFile(line);
          this.#written++;
        } finally { await file.close(); }
      } catch { this.#writeFailures++; }
    }
  }

  async #open() {
    const file = await open(this.#file,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("Invalid diagnostic log target.");
      await file.chmod(0o600);
      return file;
    } catch (error) { await file.close(); throw error; }
  }

  async flush(): Promise<void> { while (this.#drain !== undefined) await this.#drain; }
  async close(): Promise<void> { this.#closed = true; await this.flush(); }
}
