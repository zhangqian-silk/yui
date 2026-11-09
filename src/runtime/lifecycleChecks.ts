/** Optional observations, not guards. One independent async lane per check:
 * slow/failed checks cannot gate a state transition or another check. Each
 * lane coalesces to its latest observation; events are hints, never authority.
 * Callbacks must yield for I/O and honour cancellation before requesting work. */
export type LifecycleCheck<T> = Readonly<{
  id: string;
  run(observation: T, signal: AbortSignal): void | Promise<void>;
}>;

export function createNonBlockingChecks<T>(
  checks: readonly LifecycleCheck<T>[],
  onError: (error: unknown) => void = () => {}
) {
  if (new Set(checks.map(check => check.id)).size !== checks.length) throw new Error("Duplicate lifecycle check id.");
  const abort = new AbortController();
  const lanes = checks.map(check => ({ check, running: false, pending: undefined as { value: T } | undefined }));
  const launch = (lane: typeof lanes[number]) => {
    if (lane.running || abort.signal.aborted) return;
    lane.running = true;
    // Defer even synchronous callbacks until the caller has committed its state.
    void Promise.resolve().then(async () => {
      while (lane.pending && !abort.signal.aborted) {
        const { value } = lane.pending;
        lane.pending = undefined;
        try { await lane.check.run(value, abort.signal); }
        catch (error) {
          try { onError(error); } catch { /* Diagnostics cannot gate lifecycle. */ }
        }
      }
    }).finally(() => {
      lane.running = false;
      if (lane.pending) launch(lane);
    });
  };
  return {
    notify(observation: T): void {
      if (abort.signal.aborted) return;
      for (const lane of lanes) {
        lane.pending = { value: observation };
        launch(lane);
      }
    },
    get pendingCount() { return lanes.filter(lane => lane.pending !== undefined).length; },
    close(): void {
      abort.abort();
      for (const lane of lanes) lane.pending = undefined;
    }
  };
}

export type NonBlockingChecks<T> = ReturnType<typeof createNonBlockingChecks<T>>;
