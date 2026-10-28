import { createHash } from "node:crypto";

/**
 * Pure-memory command observation for the Controller socket.
 *
 * The core server owns route/built-in command observation: every authenticated
 * request is counted once at the routing layer, and a bounded unrefed scheduler
 * samples event-loop delay as evidence of loop saturation, not an exact
 * measurement of any one request's pre-dispatch queue time. The
 * FileTaskController composes these snapshots into its runtime status metric;
 * nothing here is persisted and every snapshot is O(1).
 */

export type ControllerRouteKind = "builtin" | "dispatched";
export type ControllerRouteOutcome = "success" | "failure";

export type ControllerRouteMetrics = Readonly<{
  received: number;
  completed: number;
  failed: number;
  inFlight: number;
  /**
   * Age of the oldest in-flight request in milliseconds, or null when nothing
   * is in flight. This includes execution, not just time queued.
   */
  oldestInFlightAgeMs: number | null;
  builtin: Readonly<{ completed: number; failed: number }>;
  dispatched: Readonly<{ completed: number; failed: number }>;
  observations: ReturnType<ControllerWorkObserver["snapshot"]>;
}>;

/** Fixed-size retained diagnostics; live bookkeeping follows in-flight work.
 * Not a log or scheduling authority. No params,
 * prompts, paths, failure text or credentials are retained. Target/request
 * hashes correlate an observation without publishing arbitrary input. */
export class ControllerWorkObserver {
  readonly #active = new Map<object, { phase: string; target: string | null; startedAt: number }>();
  readonly #recent: { phase: string; target: string | null; startedAtMs: number; elapsedMs: number; failed: boolean }[] = [];
  #completed = 0;
  #maximumMs = 0;
  #slowest: { phase: string; target: string | null; startedAtMs: number; elapsedMs: number; failed: boolean } | null = null;
  constructor(readonly clock: () => number = monotonicMilliseconds) {}

  start(phase: string, target?: string): (failed?: boolean) => void {
    const token = {};
    const entry = { phase, target: target === undefined ? null
      : createHash("sha256").update(target).digest("hex").slice(0, 16), startedAt: this.clock() };
    this.#active.set(token, entry);
    return (failed = false) => {
      if (!this.#active.delete(token)) return;
      const elapsedMs = Math.max(0, this.clock() - entry.startedAt);
      this.#completed++;
      this.#maximumMs = Math.max(this.#maximumMs, elapsedMs);
      const completed = { phase, target: entry.target, startedAtMs: entry.startedAt, elapsedMs, failed };
      if (this.#slowest === null || elapsedMs > this.#slowest.elapsedMs) this.#slowest = completed;
      this.#recent.push(completed);
      if (this.#recent.length > 16) this.#recent.shift();
    };
  }

  async observe<T>(phase: string, target: string | undefined, action: () => T | Promise<T>): Promise<T> {
    const finish = this.start(phase, target);
    try { const value = await action(); finish(); return value; }
    catch (error) { finish(true); throw error; }
  }

  snapshot() {
    const active = [];
    for (const entry of this.#active.values()) {
      active.push({ phase: entry.phase, target: entry.target, startedAtMs: entry.startedAt,
        ageMs: Math.max(0, this.clock() - entry.startedAt) });
      if (active.length === 16) break;
    }
    return {
      completed: this.#completed, maximumMs: this.#maximumMs, inFlight: this.#active.size,
      active, slowest: this.#slowest,
      recent: [...this.#recent]
    };
  }
}

export type ControllerReadMetrics = ReturnType<ControllerWorkObserver["snapshot"]> & {
  projectionCache: { hits: number; rebuilds: number; invalidations: number };
};

/** Small worker-response observation; no historical arrays on the RPC wire. */
export function compactWorkObservation(observer: ControllerWorkObserver) {
  const { completed, maximumMs, slowest, recent } = observer.snapshot();
  return { completed, maximumMs, slowest, latest: recent.at(-1) ?? null };
}

export type ControllerEventLoopDelayMetrics = Readonly<{
  samples: number;
  maximumLagMs: number;
  lagBuckets: Readonly<Record<string, number>>;
  maximumObservedAtMs: number | null;
}>;

/**
 * The telemetry the core server hands to the status composer. The server owns
 * the instances; the FileTaskController only reads their snapshots.
 */
export type ControllerStatusTelemetry = Readonly<{
  commandObserver: ControllerCommandObserver;
  eventLoopDelay: ControllerEventLoopDelay;
}>;

const CONTROLLER_DELAY_BUCKETS_MS = [10, 50, 100, 250, 500, 1_000, 3_000] as const;

const DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS = 50;

const BUILTIN_METHODS = new Set([
  "controller.status",
  "controller.identity",
  "controller.stop",
  "controller.begin-handover",
  "controller.commit-handover",
  "controller.rollback-handover",
  "controller.handover-state"
]);

const OBSERVED_METHODS = new Set([...BUILTIN_METHODS,
  "scheduler.signal", "scheduler.scan", "scheduler.configure",
  "runtime.ensure-role-session", "runtime.stop-role-session",
  "capability.search", "capability.describe", "capability.call",
  "schedule.control", "job.definition", "job.start", "job.get", "job.cancel", "job.acknowledge"
]);

export function isBuiltinControllerMethod(method: string): boolean {
  return BUILTIN_METHODS.has(method);
}

export function monotonicMilliseconds(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export type ControllerTelemetryHandle = Readonly<{
  unref(): void;
  close(): void;
}>;

/**
 * Scheduler seam for the delay sampler. Production uses an unrefed interval so
 * the sampler never keeps the process alive; tests drive a manual scheduler to
 * assert lag without real time.
 */
export type ControllerTelemetryScheduler = Readonly<{
  setInterval(callback: () => void, delayMs: number): ControllerTelemetryHandle;
}>;

export const productionTelemetryScheduler: ControllerTelemetryScheduler = {
  setInterval: (callback, delayMs) => {
    const timer = setInterval(callback, delayMs);
    timer.unref();
    return {
      unref: () => timer.unref(),
      close: () => clearInterval(timer)
    };
  }
};

export type ControllerCommandObservation = Readonly<{
  complete(kind: ControllerRouteKind, outcome: ControllerRouteOutcome): void;
}>;

/**
 * Counts routed commands once at the routing layer. Built-in routes
 * (controller.status/identity/stop) and dispatcher routes are observed
 * separately so the dispatcher's own service-time metric cannot be mistaken
 * for end-to-end latency and is never double-counted.
 */
export class ControllerCommandObserver {
  readonly #clock: () => number;
  #received = 0;
  #completed = 0;
  #failed = 0;
  #inFlight = 0;
  /** Insertion order preserves arrival order; completion removes its own token. */
  readonly #inFlightStarted = new Map<object, number>();
  #builtinCompleted = 0;
  #builtinFailed = 0;
  #dispatchedCompleted = 0;
  #dispatchedFailed = 0;
  readonly #observations: ControllerWorkObserver;

  constructor(clock: () => number = monotonicMilliseconds) {
    this.#clock = clock;
    this.#observations = new ControllerWorkObserver(clock);
  }

  start(method = "unknown", requestId?: string): ControllerCommandObservation {
    this.#received += 1;
    this.#inFlight += 1;
    const token = {};
    this.#inFlightStarted.set(token, this.#clock());
    const finish = this.#observations.start(
      OBSERVED_METHODS.has(method) ? method : "other", requestId);
    let completed = false;
    return {
      complete: (kind, outcome) => {
        if (completed) return;
        completed = true;
        this.#inFlight = Math.max(0, this.#inFlight - 1);
        this.#inFlightStarted.delete(token);
        finish(outcome === "failure");
        this.#completed += 1;
        if (outcome === "failure") this.#failed += 1;
        if (kind === "builtin") {
          if (outcome === "failure") this.#builtinFailed += 1;
          else this.#builtinCompleted += 1;
        } else if (outcome === "failure") {
          this.#dispatchedFailed += 1;
        } else {
          this.#dispatchedCompleted += 1;
        }
      }
    };
  }

  snapshot(): ControllerRouteMetrics {
    const oldest = this.#inFlightStarted.size === 0
      ? null
      : Math.max(0, this.#clock() - this.#inFlightStarted.values().next().value!);
    return {
      received: this.#received,
      completed: this.#completed,
      failed: this.#failed,
      inFlight: this.#inFlight,
      oldestInFlightAgeMs: oldest,
      builtin: {
        completed: this.#builtinCompleted,
        failed: this.#builtinFailed
      },
      dispatched: {
        completed: this.#dispatchedCompleted,
        failed: this.#dispatchedFailed
      },
      observations: this.#observations.snapshot()
    };
  }
}

/**
 * Bounded event-loop delay sampler. A fixed-cadence unrefed interval measures
 * how much later than expected it fires; that lag is the pre-dispatch wait an
 * already-written socket request experiences while the loop is busy. State is
 * a fixed counter set plus seven bucket counters, so memory is constant and
 * snapshots are O(1).
 */
export class ControllerEventLoopDelay {
  readonly #clock: () => number;
  readonly #scheduler: ControllerTelemetryScheduler;
  readonly #intervalMs: number;
  #handle: ControllerTelemetryHandle | undefined;
  #expectedAt = 0;
  #samples = 0;
  #maximumLagMs = 0;
  #maximumObservedAtMs: number | null = null;
  readonly #buckets = new Map<number, number>(
    CONTROLLER_DELAY_BUCKETS_MS.map((threshold) => [threshold, 0])
  );
  #stopped = false;

  constructor(
    clock: () => number = monotonicMilliseconds,
    scheduler: ControllerTelemetryScheduler = productionTelemetryScheduler,
    intervalMs: number = DEFAULT_EVENT_LOOP_DELAY_INTERVAL_MS
  ) {
    this.#clock = clock;
    this.#scheduler = scheduler;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#handle !== undefined || this.#stopped) return;
    this.#expectedAt = this.#clock() + this.#intervalMs;
    this.#handle = this.#scheduler.setInterval(
      () => this.#sample(),
      this.#intervalMs
    );
  }

  #sample(): void {
    if (this.#stopped) return;
    const lag = Math.max(0, this.#clock() - this.#expectedAt);
    this.#expectedAt = this.#clock() + this.#intervalMs;
    this.#samples += 1;
    const bounded = Math.ceil(lag);
    if (this.#maximumObservedAtMs === null || bounded > this.#maximumLagMs) {
      this.#maximumLagMs = bounded;
      this.#maximumObservedAtMs = this.#clock();
    }
    for (const threshold of CONTROLLER_DELAY_BUCKETS_MS) {
      if (bounded <= threshold) {
        this.#buckets.set(threshold, (this.#buckets.get(threshold) ?? 0) + 1);
      }
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#handle?.close();
    this.#handle = undefined;
  }

  snapshot(): ControllerEventLoopDelayMetrics {
    return {
      samples: this.#samples,
      maximumLagMs: this.#maximumLagMs,
      maximumObservedAtMs: this.#maximumObservedAtMs,
      lagBuckets: Object.fromEntries(
        CONTROLLER_DELAY_BUCKETS_MS.map((threshold) => [
          `le${threshold}ms`,
          this.#buckets.get(threshold) ?? 0
        ])
      )
    };
  }
}
