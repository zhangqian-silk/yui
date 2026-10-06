import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Fixture } from "./fixture.mjs";
import { nativeBusiness } from "./native-business.mjs";
import { nativeWorker } from "./native-worker.mjs";
import { externalizeTrace } from "./native-trace.mjs";

// This calibration handler has no material/oracle/case-ID access. Its only
// inputs are the real Host's launch environment and native notification.
export async function handleTurn({ threadId, turnId, environment, input }) {
  const result = await executeTurn({ threadId, turnId, environment, input });
  return JSON.stringify(externalizeTrace(join(environment.YUI_HOME, ".."), JSON.parse(result)));
}

async function executeTurn({ threadId, turnId, environment, input }) {
  const manifest = JSON.parse(readFileSync(environment.YUI_SESSION_MANIFEST, "utf8"));
  if (manifest.owner.taskId !== environment.YUI_TASK_ID || !["leader", "worker"].includes(manifest.roleKind)) {
    throw new Error("Unexpected managed identity");
  }
  const trace = [];
  const client = Object.assign(Object.create(Fixture.prototype), {
    cli: join(environment.YUI_HOME, "..", "bin", "yui"), environment, trace,
    deadline: performance.now() + 20_000, reads: 0, bytes: 0,
    maxReads: 20, maxBytes: 1024 * 1024
  });
  const task = environment.YUI_TASK_ID;
  if (manifest.roleKind === "worker") {
    return nativeWorker({ client, input, task, role: environment.YUI_ROLE, threadId, turnId, trace });
  }
  const context = client.call(["task", "context", task]);
  const records = client.messageRecords(task);
  const business = await nativeBusiness({ client, records, task, threadId, turnId, trace });
  if (business !== null) return business;
  const originals = records.filter(r => r.value.body === "Artificial original requirement: preserve checkpoint across Session replacement.");
  if (originals.length !== 1) throw new Error("Missing or ambiguous original");
  const checkpoints = records.flatMap(r => {
    try {
      const value = JSON.parse(r.value.body);
      return value.kind === "native-eval-checkpoint" ? [{ ref: r.ref, ...value }] : [];
    } catch { return []; }
  });
  const previous = checkpoints.filter(c => c.threadId !== threadId);
  const checkpoint = { kind: "native-eval-checkpoint", threadId, turnId,
    original: originals[0].ref, previous: previous.map(c => c.ref) };
  if (!checkpoints.some(c => c.threadId === threadId)) {
    client.call(["task", "message", "send", task, JSON.stringify(checkpoint)], "write");
  }
  return JSON.stringify({ kind: "native-eval-observation", threadId, turnId,
    identity: Object.fromEntries(["YUI_SESSION_SCOPE", "YUI_TASK_ID", "YUI_ROLE",
      "YUI_WORKSPACE", "YUI_SESSION_MANIFEST", "CODEX_THREAD_ID"]
      .filter(key => environment[key] !== undefined).map(key => [key, environment[key]])),
    contextLoaded: !!context, original: originals[0], previous, trace });
}
