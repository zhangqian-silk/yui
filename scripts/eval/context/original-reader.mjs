// Fixture-bound, one authorized CLI page per invocation; no cache or retry.
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { hash } from "../core/io.mjs";
export const readerLimits = Object.freeze({ maxOutputBytes: 65536, maxMs: 20000, maxDocumentBytes: 2097152 });
export class OriginalReadError extends Error {
  constructor(code, message) { super(message); this.name = "OriginalReadError"; this.code = code; }
}
const check = (value, code, message) => { if (!value) throw new OriginalReadError(code, message); };
const id = v => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const object = v => v && typeof v === "object" && !Array.isArray(v);
function cursorValue(raw, source) {
  check(typeof raw === "string" && raw.length <= 16384 && /^[A-Za-z0-9_-]+$/u.test(raw), "cursor", "Invalid cursor");
  const bytes = Buffer.from(raw, "base64url");
  check(bytes.toString("base64url") === raw, "cursor", "Noncanonical cursor");
  const c = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  check(Object.keys(c).length === 3 && c.source === source && digest(c.digest) && integer(c.offset),
    "cursor", "Wrong source/digest/offset");
  return c;
}
export function readOriginalPage(request, dependencies = {}) {
  const { binding, environment = process.env, clock = () => performance.now() } = dependencies;
  const started = clock();
  check(object(request) && Object.keys(request).every(k =>
    ["kind", "runId", "messageId", "cursor", "maxOutputBytes", "maxMs"].includes(k)), "input", "Unsupported request");
  const maxOutputBytes = request.maxOutputBytes ?? readerLimits.maxOutputBytes, maxMs = request.maxMs ?? readerLimits.maxMs;
  check(integer(maxOutputBytes) && maxOutputBytes >= 1024 && maxOutputBytes <= readerLimits.maxOutputBytes
    && integer(maxMs) && maxMs > 0 && maxMs <= readerLimits.maxMs, "budget", "Invalid lower-only budget");
  const task = environment.YUI_TASK_ID, scope = environment.YUI_SESSION_SCOPE;
  check(binding && isAbsolute(binding.cli ?? "") && isAbsolute(binding.home ?? "")
    && environment.YUI_HOME && resolve(environment.YUI_HOME) === resolve(binding.home)
    && ["task", "global"].includes(scope) && id(environment.YUI_ROLE) && environment.YUI_AGENT_ID === "codex"
    && id(environment.CODEX_THREAD_ID ?? environment.YUI_NATIVE_SESSION_ID)
    && (scope === "task" ? id(task) : !task), "owner", "Missing or inconsistent inherited managed identity");
  check(id(request.messageId) && (scope === "task" ? /^message-/u : /^global-message-/u).test(request.messageId),
    "input", "Exact Message ID required");
  let args, source;
  if (request.kind === "run-message") {
    check(scope === "task" && id(request.runId), "input", "Run pointer requires Task and exact Run");
    args = ["task", "run", "context", "expand", `${task}/${request.runId}`, request.messageId,
      "--store", "task-message", "--mode", "full"];
    source = `run:${task}/${request.runId}/task-message/${request.messageId}`;
  } else if (request.kind === "task-message") {
    check(scope === "task" && request.runId === undefined, "input", "Task Message pointer required");
    args = ["task", "message", "show", `${task}/${request.messageId}`];
    source = `task:${task}/message/${request.messageId}`;
  } else {
    check(request.kind === "inbox-message" && scope === "global" && request.runId === undefined,
      "input", "Only explicit Global inbox Message pointers; Task wakes are not Messages");
    args = ["inbox", "show", request.messageId];
    source = `inbox:global::${environment.YUI_ROLE}/${request.messageId}`;
  }
  const cursor = request.cursor === undefined ? undefined : cursorValue(request.cursor, source);
  args = ["--json", ...args, ...(cursor ? ["--cursor", request.cursor] : [])];
  const remaining = () => { const ms = maxMs - (clock() - started);
    check(ms > 0, "budget", "Time budget exceeded"); return Math.max(1, Math.floor(ms)); };
  let r;
  try {
    const call = { cli: binding.cli, args, environment, timeoutMs: remaining(), maxBytes: maxOutputBytes };
    r = dependencies.transport ? dependencies.transport(call)
      : (() => { const result = spawnSync(call.cli, call.args, { env: environment,
        timeout: call.timeoutMs, maxBuffer: call.maxBytes, shell: false });
      return { code: result.status, error: result.error, stdout: result.stdout, stderr: result.stderr }; })();
  } catch (e) {
    if (e instanceof OriginalReadError) throw e;
    throw new OriginalReadError("transport", "CLI transport failed; no retry");
  }
  remaining();
  check(!r.error && !r.signal && r.code === 0, "cli", "CLI refusal or unknown delivery; no fallback/retry");
  check(Buffer.isBuffer(r.stdout) && Buffer.isBuffer(r.stderr ?? Buffer.alloc(0))
    && r.stdout.length + (r.stderr?.length ?? 0) <= maxOutputBytes, "budget", "Output exceeds explicit cap");
  const stdout = new TextDecoder("utf-8", { fatal: true }).decode(r.stdout), envelope = JSON.parse(stdout);
  check(envelope?.ok === true && object(envelope.data), "cli", "Missing successful CLI data");
  const value = envelope.data.context ?? envelope.data, p = value.contentPage;
  if (p) {
    check(p.source === source && digest(p.digest) && (!cursor || cursor.digest === p.digest)
      && p.offset === (cursor?.offset ?? 0) && p.encoding === "json"
      && typeof p.text === "string" && p.text.length > 0 && p.text.isWellFormed()
      && integer(p.totalCharacters) && integer(p.totalBytes) && p.totalBytes <= readerLimits.maxDocumentBytes
      && p.totalCharacters <= readerLimits.maxDocumentBytes && p.totalBytes >= Buffer.byteLength(p.text)
      && p.offset + p.text.length <= p.totalCharacters && typeof p.complete === "boolean",
    "page", "Wrong page source/digest/offset/text/length");
    const end = p.offset + p.text.length;
    if (p.complete) {
      check(p.nextCursor === null && end === p.totalCharacters, "page", "Incomplete terminal page");
      if (p.offset === 0) check(hash(p.text) === p.digest && Buffer.byteLength(p.text) === p.totalBytes,
        "digest", "Single-page document hash/length mismatch");
    } else {
      const next = cursorValue(p.nextCursor, source);
      check(end < p.totalCharacters && next.digest === p.digest && next.offset === end, "cursor", "Wrong next cursor");
    }
  } else {
    check(!cursor, "page", "Continuation unexpectedly became inline");
    const message = request.kind === "run-message" ? value.value : value;
    check(request.kind !== "run-message" || value.ref?.store === "task-message"
      && value.ref.refId === request.messageId, "original", "Wrong Run ref");
    check(message?.id === request.messageId && typeof message.body === "string" && message.body.isWellFormed()
      && (scope === "task" ? message.taskId === task : message.taskId === undefined
        && message.roleName === environment.YUI_ROLE), "original", "Wrong owner or missing original body");
  }
  remaining();
  // Exact entire stdout, including whitespace and every record field; no
  // normalized wrapper, internal full-document loop, projection or load receipt.
  return { stdout, args, source };
}
