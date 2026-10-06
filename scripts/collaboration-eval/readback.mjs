import { digest } from "./evidence.mjs";

// Fact digests identify synthetic business material. Context ref digests
// identify the actual enclosing Yui records; neither substitutes for the other.
function verifyFact(fact) {
  if (!fact || typeof fact.key !== "string" || !fact.key || typeof fact.digest !== "string") {
    throw new Error("Missing business fact identity or digest");
  }
  const { digest: expected, ...unsigned } = fact;
  if (digest(JSON.stringify(unsigned)) !== expected) throw new Error("Business fact digest mismatch");
}

export function persistTaskFacts(fixture, task, facts) {
  if (!Array.isArray(facts) || !facts.length) throw new Error("Expected nonempty business facts");
  const keys = new Set();
  // Validate all inputs before any writes. No oracle, expected output, or future
  // event belongs in this public material channel.
  for (const fact of facts) {
    verifyFact(fact);
    if (keys.has(fact.key)) throw new Error("Duplicate business fact key");
    keys.add(fact.key);
  }
  return facts.map(fact => fixture.call(["task", "message", "send", task,
    JSON.stringify({ kind: "collaboration-eval-fact", value: fact }),
    "--intent", "record", "--request-id", `fact-${fact.key}-${fact.digest}`], "prepare"));
}

export function readTaskFacts(fixture, task) {
  return extractFacts(fixture.messageRecords(task), task);
}

export function readNativeFacts(fixture, task, { knowledge = false } = {}) {
  const originals = [
    ...fixture.records(task, "task-message"),
    ...fixture.records(task, "task-decision").filter(r => r.value.status === "active"),
    ...(knowledge ? fixture.records(task, "project-knowledge").filter(r => r.value.status === "active") : [])
  ];
  return extractFacts(originals, task);
}

function extractFacts(originals, task) {
  const records = [];
  const keys = new Set();
  // No prepared facts argument: the participant's values come exclusively
  // from complete, digest-bound original Yui records discovered in this Task.
  for (const original of originals) {
    let envelope;
    const store = original.ref?.store;
    try { envelope = JSON.parse(store === "task-decision" ? original.value.rationale : original.value.body); }
    catch { continue; }
    if (envelope?.kind !== "collaboration-eval-fact") continue;
    if ((store !== "project-knowledge" && original.value.taskId !== task)
      || !["task-message", "task-decision", "project-knowledge"].includes(store)
      || !original.ref.refId || !original.ref.digest) throw new Error("Invalid Yui source identity");
    const fact = envelope.value;
    verifyFact(fact);
    if (keys.has(fact.key)) throw new Error("Duplicate persisted business fact key");
    keys.add(fact.key);
    records.push({ ref: original.ref, digest: fact.digest, sourceDigest: original.ref.digest, value: fact });
  }
  if (!records.length) throw new Error("No persisted business facts were discovered");
  return { origin: "yui-cli", records };
}
