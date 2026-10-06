// No preparation/catalog/oracle import. Only original public Yui records are
// inputs to the deterministic business participant.
import { readNativeFacts } from "./readback.mjs";
import { executeCase } from "./cases/participant.mjs";
import { mutate } from "./cases/business.mjs";

export async function nativeBusiness({ client, records, task, threadId, turnId, trace }) {
  const messages = records.flatMap(r => {
    try { return [{ ref: r.ref, value: JSON.parse(r.value.body) }]; }
    catch { return []; }
  });
  const request = messages.find(m => m.value.kind === "native-eval-predecessor-request");
  if (!request) return null;
  const prior = messages.filter(m => m.value.kind === "native-business-checkpoint");
  const predecessor = prior.find(m => m.value.threadId !== threadId);
  const root = request.value.root;
  if (!predecessor) {
    if (prior.length) return JSON.stringify({ kind: "native-business-idle", threadId, turnId,
      reason: "Checkpoint already saved; no replay", trace });
    const operation = request.value.operation;
    if (operation.kind !== "notification") throw new Error("Unsupported predecessor operation");
    const response = await mutate(root, { actor: "predecessor", action: "send",
      key: operation.key, target: operation.target, payload: operation.payload, dropResponse: true });
    // The returned response has no effect receipt. Do not consult the private
    // evaluator observation or invent confirmation after a lost response.
    const checkpoint = { kind: "native-business-checkpoint", threadId, turnId,
      request: request.ref, key: operation.key, response, effect: response.status };
    client.call(["task", "message", "send", task, JSON.stringify(checkpoint)], "write");
    return JSON.stringify({ kind: "native-business-predecessor", threadId, turnId, checkpoint, trace });
  }
  if (messages.some(m => m.value.kind === "native-business-result")) {
    return JSON.stringify({ kind: "native-business-idle", threadId, turnId,
      reason: "Result already saved; no repeated business work", trace });
  }
  const readback = readNativeFacts({ records: (id, store) =>
    store === "task-message" ? records : client.records(id, store) }, task);
  const fact = key => readback.records.find(r => r.value.key === key)?.value.body;
  if (fact("checkpoint")?.originalKey !== predecessor.value.key
    || fact("checkpoint")?.effect !== predecessor.value.effect) throw new Error("Checkpoint disagrees with predecessor original");
  const result = await executeCase({ root, readback });
  const saved = client.call(["task", "message", "send", task,
    JSON.stringify({ kind: "native-business-result", result })], "write");
  return JSON.stringify({ kind: "native-business-successor", threadId, turnId,
    predecessor, readback, result,
    resultRef: { store: "task-message", refId: saved.message.id, digest: saved.message.digest }, trace });
}
