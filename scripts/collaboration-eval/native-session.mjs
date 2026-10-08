import { setTimeout as delay } from "node:timers/promises";
import { readNativeTrace } from "./native-trace.mjs";

// Observer of this test's own isolated native Host, not a scheduler. Every
// event comes from the public fixed-bound delta and original-detail paths.
export class NativeObserver {
  constructor(fixture, task, cursor) {
    this.fixture = fixture; this.task = task; this.cursor = cursor; this.events = [];
  }
  collect() {
    let continuation;
    do {
      const page = this.fixture.call(["task", "context", "delta", this.task, "--after", this.cursor,
        ...(continuation ? ["--continuation", continuation] : [])]);
      for (const entry of page.events) {
        const event = entry.value ?? this.fixture.detail([
          "task", "context", "inspect", this.task, "--store", entry.ref.store,
          "--ref", entry.ref.refId, "--digest", entry.ref.digest]).value;
        this.events.push(event);
        if (event.type === "runtime.observation") {
          const observation = JSON.parse(event.payload.observation);
          if (observation.kind === "turn.completed" && observation.payload.output) {
            const result = JSON.parse(observation.payload.output);
            // Include even an idle notification's reads, not just winning Turns.
            if (result.kind?.startsWith("native-")) {
              includeNativeTrace(this.fixture, { result, trace: readNativeTrace(this.fixture.root, result) });
            }
          }
        }
      }
      continuation = page.continuation;
      if (!continuation) this.cursor = page.throughCursor;
    } while (continuation);
  }
  async terminal(kind, { excludeSession } = {}) {
    while (performance.now() < this.fixture.deadline) {
      this.collect();
      for (const event of this.events) {
        if (event.type !== "runtime.observation") continue;
        const observation = JSON.parse(event.payload.observation);
        if (observation.fence.nativeSessionId === excludeSession) continue;
        if (observation.kind === "turn.failed") throw new Error(JSON.stringify(observation));
        if (observation.kind !== "turn.completed" || !observation.payload.output) continue;
        const result = JSON.parse(observation.payload.output);
        if (result.kind !== kind) continue;
        if (result.threadId !== observation.fence.nativeSessionId
          || result.turnId !== observation.fence.nativeTurnId) throw new Error("Native terminal identity mismatch");
        return { event, result };
      }
      await delay(150);
    }
    throw new Error("budget-exceeded: native terminal deadline");
  }
}

export function includeNativeTrace(fixture, terminal) {
  for (const entry of terminal.trace ?? terminal.result.trace) {
    fixture.trace.push({ ...entry, actor: "native-participant", nativeSession: terminal.result.threadId });
    if (entry.phase === "query") {
      fixture.reads++; fixture.bytes += entry.stdoutBytes + entry.stderrBytes;
    }
  }
  if (fixture.reads > fixture.maxReads || fixture.bytes > fixture.maxBytes) throw new Error("budget-exceeded: native reads");
}
