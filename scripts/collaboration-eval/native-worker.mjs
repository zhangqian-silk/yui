// Deterministic native Worker calibration. Identity comes from the actual
// Provider input, never a guessed run ID or evaluator-supplied credentials.
export function workerEnvelope(input, task, role) {
  const texts = input.input?.filter(item => item.type === "text").map(item => item.text) ?? [];
  const matches = texts.join("\n").match(/^task=(\S+) run=(\S+) role=(\S+)$/gm) ?? [];
  if (matches.length !== 1) throw new Error("Missing or ambiguous native AgentRun envelope");
  const [, taskId, runId, roleName] = /^task=(\S+) run=(\S+) role=(\S+)$/.exec(matches[0]);
  if (taskId !== task || roleName !== role) throw new Error("Native AgentRun identity mismatch");
  return { taskId, runId, roleName };
}

export function selfAcceptanceDenied(entry) {
  if (!entry || entry.exitCode === 0) return false;
  try {
    const response = JSON.parse(entry.stderr || entry.stdout);
    return response.ok === false && response.details?.diagnostic?.causes?.some(cause =>
      cause.message.startsWith("A managed Task Session may perform this action only as the matching Leader:"));
  } catch { return false; }
}

export function nativeWorker({ client, input, task, role, threadId, turnId, trace }) {
  const identity = workerEnvelope(input, task, role);
  const runRef = `${task}/${identity.runId}`;
  // Reuse complete-original pagination with the Run API's context wrapper.
  const reader = Object.assign(Object.create(Object.getPrototypeOf(client)), {
    call: (...args) => client.call(...args).context
  });
  const pack = reader.detail(["task", "run", "context", runRef]);
  if (pack.identity.taskId !== task || pack.identity.runId !== identity.runId
    || pack.identity.roleName !== role || pack.authority.view !== "worker"
    || !pack.snapshot?.digest || pack.authority.writableProjectIds.length) {
    throw new Error("Unexpected read-only frozen Assignment");
  }
  const items = pack.pointers.filter(p => p.store === "work-item");
  if (items.length !== 1) throw new Error("Expected one assigned WorkItem");
  const original = reader.detail(["task", "run", "context", "expand", runRef,
    items[0].refId, "--store", items[0].store, "--mode", "full"]);
  const work = original.value;
  let rejection;
  try {
    client.call(["task", "work", "accept", `${task}/${work.id}`,
      "--summary", "Forbidden self-acceptance probe in owned fixture"], "write");
  } catch (error) { rejection = String(error); }
  if (!rejection || !selfAcceptanceDenied(trace.at(-1))) {
    throw new Error(`Self-acceptance was not rejected by authority: ${rejection ?? "succeeded"}`);
  }
  return JSON.stringify({ kind: "native-business-worker-calibration", threadId, turnId,
    identity, pack, original, rejection, trace,
    finding: { objective: work.objective, acceptance: work.acceptance,
      noWritableProjects: true, selfAcceptanceDenied: true } });
}
