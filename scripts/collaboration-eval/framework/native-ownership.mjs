// A proxy connection can receive native broadcasts for unrelated Threads.
// Derive ownership from this connection's exact Host request/response pairs,
// never from the connection's Role label or an unsolicited notification.
import { resolve, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { hash, redactTransport, completeJsonLines } from "./common.mjs";
export function readNativeTransports(directory) {
  return readdirSync(directory).filter(n => /^transport-.*\.jsonl$/.test(n)).flatMap(n => {
    const { records, tail } = completeJsonLines(readFileSync(join(directory, n), "utf8"));
    const tagged = records.map(e => ({ ...e, sourceConnection: n }));
    return tail ? [...tagged, { sourceConnection: n,
      invalidFrame: { file: n, reason: "pending append-only JSONL tail", ...tail } }] : tagged;
  });
}
// No automatic archive: a rejected resume is not authority over an old Thread.
// Even a proven new Thread remains unsettled until an authorized disposition.
export function rejectedNativeCleanup(raw, teardown = {}) {
  const { proofs } = attributeNativeEvents(raw);
  const abnormalProxyExit = e => e.protocol === "app-server-ws" && e.direction === "exit"
    && (e.code !== 0 || e.signal);
  const plannedCloses = [];
  const unresolved = raw.filter(e => e.direction === "isolation-rejected" || e.invalidFrame || abnormalProxyExit(e)).flatMap(e => {
    if (abnormalProxyExit(e)) {
      const planned = plannedProxyClose(raw, e, proofs, teardown);
      if (planned) { plannedCloses.push(planned); return []; }
    }
    const s = e.startup;
    const proof = s && proofs.find(p => p.connection === e.sourceConnection
      && p.method === s.method && JSON.stringify(p.requestId) === JSON.stringify(s.requestId)
      && p.threadId === s.threadId && Date.parse(p.at) <= Date.parse(e.at));
    return [{ connection: e.sourceConnection, at: e.at,
      status: proof?.method === "thread/start" ? "created-unsettled" : "unknown",
      proof, reason: e.error ?? e.invalidFrame ?? { reason: "abnormal proxy process exit",
        code: e.code, signal: e.signal, nativeLifecycle: "unknown" } }];
  });
  return { status: unresolved.length ? "unknown" : "no-rejected-startup", unresolved, plannedCloses,
    automaticArchive: false };
}
// Reuse the parent's original CLI call evidence, including an intermediate
// checkpoint stop. A later empty session-stop-all cannot settle an old Thread.
export function recordedStopControls(trace) {
  const args = e => e.args.filter(x => x !== "--json");
  const result = e => {
    try { const v = JSON.parse(e.stdout); return e.code === 0 && v.ok === true ? v.data : undefined; }
    catch { return undefined; }
  };
  return trace.flatMap((e, index) => {
    const a = args(e);
    if (a.slice(0, 4).join(" ") !== "task role session stop" || !result(e)) return [];
    const inspection = trace.slice(index + 1).find(x => {
      const b = args(x);
      return b.slice(0, 4).join(" ") === "task role session inspect"
        && b[4] === a[4] && b[5] === a[5] && result(x)
        && Date.parse(x.startedAt) >= Date.parse(e.at);
    });
    return [{ args: a, result: result(e), startedAt: e.startedAt, at: e.at,
      ...(inspection ? { inspection: { at: inspection.at, result: result(inspection) } } : {}),
      provenance: "original parent CLI trace; not reconstructed from later cleanup status" }];
  });
}
function plannedProxyClose(raw, exit, proofs, teardown) {
  const conn = raw.filter(e => e.sourceConnection === exit.sourceConnection);
  // Each connection is an append-only stream. Wall-clock milliseconds bound
  // the control interval, but cannot order a request and its same-ms response.
  const before = (a, b) => a.sourceConnection === b.sourceConnection
    && raw.indexOf(a) < raw.indexOf(b) && Date.parse(a.at) <= Date.parse(b.at);
  if (exit.signal !== "SIGTERM" || conn.some(e => e.invalidFrame || e.direction === "isolation-rejected")) return null;
  const custody = conn.filter(e => e.direction === "custody");
  if (custody.length !== 1 || !custody[0].child?.start) return null;
  const child = custody[0].child;
  const same = c => c?.pid === child.pid && c.start === child.start;
  if (!teardown.custody?.some(c => c.connection === exit.sourceConnection && same(c.child) && c.alive === false)) return null;
  const signals = conn.filter(e => e.direction === "stop-signal");
  if (!signals.length || signals.some(e => e.signal !== "SIGTERM" || !same(e.child) || !before(e, exit))) return null;
  // Every observed RPC must have one exact response; no unfinished native
  // request can be erased by a later process signal or a successful CLI stop.
  const requests = conn.filter(e => e.direction === "host" && e.message?.id !== undefined && e.message.method);
  if (new Set(requests.map(q => JSON.stringify(q.message.id))).size !== requests.length
    || requests.some(q => conn.filter(r => r.direction === "native" && !r.message?.method
      && r.message?.id === q.message.id && !r.message.error && before(q, r)
      && before(r, exit)).length !== 1)) return null;
  let threads = [...new Set(proofs.filter(p => p.connection === exit.sourceConnection).map(p => p.threadId))];
  if (!threads.length) {
    // Detached control never gains a subject Role. Only an owned Thread named
    // by a control response may link this process to its stop operation.
    if (requests.some(q => ["thread/start", "thread/resume", "turn/start"].includes(q.message.method))) return null;
    threads = [...new Set(conn.flatMap(e => e.controlObservation?.threadId ? [e.controlObservation.threadId] : []))];
    if (!threads.length || threads.some(t => !proofs.some(p => p.threadId === t))) return null;
  }
  const snapshots = [];
  for (const threadId of threads) {
    const control = teardown.controls?.find(c => !c.error && c.result
      && signals.every(s => Date.parse(c.startedAt) <= Date.parse(s.at))
      && Date.parse(exit.at) <= Date.parse(c.at)
      && (c.args?.join(" ") === "session stop --all"
        ? c.result.blocked?.length === 0 && c.result.stopped?.some(s => s.nativeSessionId === threadId)
        : c.args?.slice(0, 3).join(" ") === "task execution stop"
          ? c.result.taskId === c.args[3] && proofs.some(p => p.threadId === threadId && p.taskId === c.args[3])
          : c.args?.slice(0, 4).join(" ") === "task role session stop"
            && c.result.taskId === c.args[4] && c.result.roleName === c.args[5] && c.result.stopped === true
            && c.inspection?.result?.taskId === c.args[4] && c.inspection.result.roleName === c.args[5]
            && c.inspection.result.session?.nativeSessionId === threadId && c.inspection.result.session.status === "ended"
            && Date.parse(c.inspection.at) >= Date.parse(c.at)
            && proofs.some(p => p.threadId === threadId && p.taskId === c.args[4] && p.role === c.args[5])));
    if (!control) return null;
    const observations = raw.filter(e => {
      const o = e.controlObservation;
      return o?.threadId === threadId && o.success === true
        && e.direction === "native" && e.message?.id === o.requestId && !e.message.error
        && raw.filter(q => q.sourceConnection === e.sourceConnection && q.direction === "host"
          && q.message?.id === o.requestId && q.message.method === o.method
          && q.message.params?.threadId === threadId && before(q, e)).length === 1
        && Date.parse(control.startedAt) <= Date.parse(e.at) && Date.parse(e.at) < Date.parse(exit.at);
    });
    const read = observations.findLast(e => e.controlObservation.method === "thread/read"
      && e.controlObservation.status === "idle" && e.controlObservation.noActiveTurn === true);
    const clean = observations.findLast(e => e.controlObservation.method === "thread/backgroundTerminals/clean");
    const empty = observations.findLast(e => e.controlObservation.method === "thread/backgroundTerminals/list"
      && e.controlObservation.backgroundEmpty === true);
    if (!read || !clean || !empty || !before(read, clean) || !before(clean, empty)) return null;
    const starts = raw.filter(e => e.direction === "host" && e.message?.method === "turn/start"
      && e.message.params?.threadId === threadId && proofs.some(p => p.connection === e.sourceConnection && p.threadId === threadId));
    if (!starts.length || starts.some(q => {
      const response = raw.find(r => r.sourceConnection === q.sourceConnection && r.direction === "native"
        && r.message?.id === q.message.id && r.message?.result?.turn?.id);
      return !response || !raw.some(r => r.sourceConnection === q.sourceConnection && r.direction === "native"
        && r.message?.method === "turn/completed" && r.message.params?.threadId === threadId
        && r.message.params.turn?.id === response.message.result.turn.id
        && ["completed", "failed", "interrupted"].includes(r.message.params.turn.status)
        && Date.parse(response.at) <= Date.parse(r.at) && Date.parse(r.at) < Date.parse(read.at));
    })) return null;
    snapshots.push({ threadId, readAt: read.at, emptyAt: empty.at, controlStartedAt: control.startedAt, controlAt: control.at });
  }
  return { connection: exit.sourceConnection, child, signalAt: signals[0].at,
    signalAts: signals.map(s => s.at), exitAt: exit.at,
    status: "planned-transport-close", snapshots,
    limit: "Owned transport stopped after observed native quiescence; not account Thread deletion or historical settlement" };
}
// Deliberately tiny metadata projection, never a transcript/account payload.
export function nativeControlObservation(request, response) {
  if (!request || !["string", "number"].includes(typeof request.id)
    || response?.id !== request.id || typeof request.params?.threadId !== "string") return undefined;
  const method = request.method, result = response.result;
  if (!["thread/read", "thread/backgroundTerminals/clean", "thread/backgroundTerminals/list"].includes(method)) return undefined;
  const o = { requestId: request.id, method, threadId: request.params.threadId,
    success: !response.error && Boolean(result) };
  if (method === "thread/read" && result?.thread?.id === o.threadId) {
    const status = result.thread.status;
    const type = typeof status === "string" ? status : status?.type;
    o.status = ["idle", "active", "notLoaded", "systemError"].includes(type) ? type : "unknown";
    o.noActiveTurn = Array.isArray(result.thread.turns)
      && result.thread.turns.every(t => ["completed", "failed", "interrupted"].includes(t?.status));
  }
  if (method === "thread/backgroundTerminals/list")
    o.backgroundEmpty = Array.isArray(result?.data) && result.data.length === 0 && result.nextCursor == null;
  return o;
}
export function nativeDiagnostic(message) {
  const p = message.params;
  return {
    id: message.id, method: message.method,
    params: p ? { threadId: p.threadId, turnId: p.turnId,
      turn: p.turn ? { id: p.turn.id, status: p.turn.status, error: p.turn.error ? { code: p.turn.error.code } : undefined } : undefined,
      item: p.item ? { id: p.item.id, type: p.item.type, status: p.item.status, exitCode: p.item.exitCode } : undefined } : undefined,
    error: message.error ? { code: message.error.code } : undefined,
    omittedBody: { utf8: Buffer.byteLength(JSON.stringify(message)), sha256: hash(JSON.stringify(redactTransport(message))) },
  };
}
export function attributeNativeEvents(raw) {
  const connections = new Map(), rejected = [], events = [], proofs = [];
  for (const e of raw) {
    const key = e.sourceConnection;
    if (!key) { rejected.push({ at: e.at, reason: "missing source connection", method: e.message?.method }); continue; }
    if (!connections.has(key)) connections.set(key, []);
    connections.get(key).push(e);
  }
  for (const [connection, entries] of connections) {
    const sorted = [...entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const pending = new Map(), threads = new Map(), turns = new Map(), responses = new Set();
    const binding = sorted.find(e => e.binding)?.binding;
    const root = binding?.home ? resolve(binding.home, "..") : undefined;
    const expectedCwd = binding?.roleName === "leader" && binding.taskId
      ? join(binding.home, "runtime/task-runtimes/planning", binding.taskId)
      : binding?.roleName === "operator" && !binding.taskId ? root : undefined;
    const managed = Boolean(root && expectedCwd && sorted.every(e => !e.binding
      || e.binding.home === binding.home && e.binding.roleName === binding.roleName
        && e.binding.taskId === binding.taskId));
    for (const e of sorted) {
      const m = e.message;
      if (!managed || !m || m.id === undefined) continue;
      const id = JSON.stringify(m.id);
      if (e.direction === "host" && m.method) {
        // Duplicate unresolved ids are ambiguous, not a new owner claim.
        pending.set(id, pending.has(id) ? null : e);
      } else if (e.direction === "native" && !m.method && pending.has(id)) {
        const request = pending.get(id); pending.delete(id);
        if (!request || m.error || !m.result || Date.parse(e.at) < Date.parse(request.at)) continue;
        const q = request.message, p = q.params ?? {}, result = m.result;
        if (["thread/start", "thread/resume"].includes(q.method)) {
          const thread = result.thread;
          if (typeof thread?.id !== "string" || resolve(p.cwd ?? "") !== expectedCwd
            || thread.cwd && resolve(thread.cwd) !== expectedCwd
            || q.method === "thread/resume" && thread.id !== p.threadId) continue;
          threads.set(thread.id, { at: request.at, requestId: q.id });
          responses.add(e);
          proofs.push({ connection, role: binding.roleName, taskId: binding.taskId,
            threadId: thread.id, method: q.method, requestId: q.id, at: e.at, cwd: expectedCwd });
        } else if (q.method === "turn/start" && threads.has(p.threadId)
          && typeof result.turn?.id === "string") {
          turns.set(`${p.threadId}/${result.turn.id}`, { at: request.at, requestId: q.id });
          responses.add(e);
        }
      }
    }
    for (const e of sorted) {
      const m = e.message, p = m?.params;
      const thread = p?.threadId, turn = p?.turnId ?? p?.turn?.id;
      const proof = turn ? turns.get(`${thread}/${turn}`) : threads.get(thread);
      const owned = managed && proof && Date.parse(e.at) >= Date.parse(proof.at);
      if (e.direction === "native" && m) {
        if (responses.has(e) || owned) events.push(e);
        else rejected.push({ connection, at: e.at, method: m.method, threadId: thread, turnId: turn,
          nativeItemId: p?.item?.id, reason: "No exact owned request/response Thread/Turn proof in this connection" });
      } else if (e.direction === "host" && m?.method === "turn/start") {
        if (managed && threads.has(p?.threadId)) events.push(e);
      } else if (e.direction !== "host" || managed) events.push(e);
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { events, rejected, proofs,
    limit: "Exact observed Host/response ownership only; missing or ambiguous protocol stays unknown. Raw broadcast records remain preserved; filtering observation does not undo any real effect." };
}
