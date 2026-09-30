import { ControllerClientError } from "../core/controllerClient.js";
import { ManagedRuntimeDriftError } from "../runtime/managedCaller.js";
import { redactAgentErrorText } from "../runtime/agentError.js";
import { CommandExecutionError } from "../tmux/commandExecutor.js";
import { StorageRecordError, StorageConflictError } from "../storage/taskStore.js";
import { CliError } from "./cliError.js";

export type FailureContext = Readonly<{
  operation?: string;
  home?: string;
  cli?: string;
  targets?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  /** Invocation operands may contain user messages or arbitrary secrets. Never echo them. */
  privateValues?: readonly string[];
}>;

export type CliFailure = Readonly<{
  code: string;
  message: string;
  details: Readonly<Record<string, unknown>>;
  exitCode: number;
}>;

const RECONCILE = "The operation may have applied; effects are not confirmed by this error. "
  + "Do not replay a write or change its request-id. Read the original Task, Message, operation and receipt "
  + "records using their existing identities before choosing recovery.";
const INSPECT = "Run `yui doctor` and `yui controller status --verbose` with the same YUI_HOME and matching CLI. ";
const IDENTITY = "Verify the Home and CLI with `yui version`, `yui controller identity` and `yui doctor`. "
  + "Ask the Operator or user to restore the matching installation/Controller if needed; do not edit identity records.";
const SESSION = "Use the supplied Session Manifest and exact CLI entry. Read the current scoped context if permitted; "
  + "ask the Operator to inspect/re-enter the current Session if identity cannot be verified. "
  + "Do not forge environment identity, edit the Manifest, or continue writes from a replaced Session.";

/** Presentation only: no filesystem reads, subprocesses, probes, retries or state changes. */
export function describeCliFailure(error: unknown, context: FailureContext = {}): CliFailure {
  const clean = (text: string): string => sanitizeFailureText(text, context);
  const chain: { name: string; code?: string; message: string }[] = [];
  const seen = new Set<unknown>();
  const pending = [error];
  let controller: ControllerClientError | undefined;
  let session = false;
  let typedCode: string | undefined;
  while (pending.length > 0 && chain.length < 8) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof ControllerClientError) controller ??= current;
    if (current instanceof ManagedRuntimeDriftError) session = true;
    const code = errorCode(current);
    if (code !== undefined && code !== "RUNTIME_ERROR") typedCode ??= code;
    chain.push({
      name: current instanceof Error ? clean(current.name) : "Error",
      ...(code === undefined ? {} : { code: clean(code) }),
      // SyntaxError can quote the offending JSON (including tokens and messages).
      message: current instanceof SyntaxError
        ? "Input could not be parsed; raw input omitted."
        : clean(current instanceof Error ? current.message : typeof current === "string" ? current : "Unknown failure (non-error payload omitted).")
          + (current instanceof CommandExecutionError
            ? ` Exit status: ${current.exitStatus ?? "unavailable"}.`
              + (current.stderr.length === 0 ? "" : ` Stderr: ${clean(current.stderr)}`) : "")
    });
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 8));
  }
  const code = error instanceof CliError ? error.code : "RUNTIME_ERROR";
  const exitCode = error instanceof CliError ? error.exitCode : 5;
  const diagnostic = {
    ...(context.operation === undefined ? {} : { operation: sanitizeFailureText(context.operation, { environment: context.environment }) }),
    ...(context.home === undefined ? {} : { home: sanitizeFailureText(context.home, { environment: context.environment }) }),
    ...(context.cli === undefined ? {} : { cli: sanitizeFailureText(context.cli, { environment: context.environment }) }),
    ...(context.targets === undefined || context.targets.length === 0 ? {} : { targets: context.targets.map(clean) }),
    causes: chain,
    ...(controller === undefined ? {} : {
      controller: {
        code: controller.code,
        ...sanitizeFailureDetails(controller.diagnostic ?? {}, context)
      }
    })
  };
  const guidanceCode = controller?.code ?? typedCode ?? code;
  const guidance = session ? SESSION
    : error instanceof StorageRecordError ? recoveryGuidance("STORAGE_SCHEMA_INVALID")
    : error instanceof StorageConflictError ? "Read the current record and compare the intended change with its new revision before submitting a new authorized mutation."
    : recoveryGuidance(guidanceCode);
  const delivery = controller?.diagnostic?.delivery;
  const effects = controller === undefined
    ? (code === "USAGE_ERROR" ? "Correct the reported input or prerequisite; this error alone is not a rollback receipt." : RECONCILE)
    : delivery === "not-sent"
      ? "This Controller request was not sent. This does not undo any earlier command steps."
      : delivery === "response-received"
        ? "The Controller returned an error response; it does not prove rollback of earlier effects. " + RECONCILE
        : RECONCILE;
  const help = error instanceof CliError && error.helpText !== undefined ? clean(error.helpText.trimEnd()) : undefined;
  const message = [
    ...chain.map((item, index) => `${index === 0 ? "" : "Caused by: "}${item.code === undefined ? "" : `[${item.code}] `}${item.message}`),
    diagnostic.operation === undefined ? undefined : `Operation: ${diagnostic.operation}`,
    diagnostic.home === undefined ? undefined : `YUI_HOME: ${diagnostic.home}`,
    diagnostic.cli === undefined ? undefined : `CLI entry: ${diagnostic.cli}`,
    diagnostic.targets === undefined ? undefined : `Targets: ${diagnostic.targets.join(", ")}`,
    controller?.diagnostic === undefined ? undefined
      : `Controller request: ${clean(controller.diagnostic.method ?? "unknown method")} id=${clean(controller.diagnostic.requestId ?? "unavailable")} delivery=${delivery}`
        + (controller.diagnostic.socketPath === undefined ? "" : ` socket=${clean(controller.diagnostic.socketPath)}`),
    effects,
    guidance,
    "Recovery commands shown as `yui` must use the same Home and matching CLI entry above; they are not run automatically.",
    help
  ].filter((part): part is string => part !== undefined && part.length > 0).join("\n");
  return {
    code, exitCode, message,
    details: {
      ...(error instanceof CliError ? sanitizeFailureDetails(error.details, context) : {}),
      diagnostic
    }
  };
}

export function renderCliFailure(failure: CliFailure, json: boolean, jsonCode = failure.code): string {
  return json
    ? JSON.stringify({ ok: false, code: jsonCode, message: failure.message, details: failure.details })
    : `${failure.code}: ${failure.message}`;
}

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

function recoveryGuidance(code: string): string {
  switch (code) {
    case "CONTROLLER_NOT_RUNNING":
      return INSPECT + "A missing discovery record is not proof of process exit. If confirmed stopped, run `yui start` through the user or Operator.";
    case "CONTROLLER_UNAVAILABLE":
    case "CONTROLLER_DISCOVERY_INVALID":
      return INSPECT + "Process state is unverified. Inspect the reported process/socket ownership before an authorized `yui controller restart`.";
    case "CONTROLLER_ACCESS_DENIED":
    case "EACCES":
    case "EPERM":
      return "Inspect filesystem ownership and the sandbox/OS permission boundary. Ask the user or Operator for authorized access; do not alter permissions automatically.";
    case "CONTROLLER_PROTOCOL_MISMATCH":
    case "CONTROLLER_IDENTITY_MISMATCH":
    case "UNAUTHORIZED":
      return IDENTITY;
    case "CONTROLLER_TIMEOUT":
    case "CONTROLLER_DELIVERY_UNKNOWN":
    case "INVALID_RESPONSE":
      return INSPECT + "Correlate the request with durable records before recovery; a timeout is not proof that the process exited.";
    case "CONTROLLER_HANDOVER_FENCED":
    case "CONTROLLER_HANDOVER_TIMEOUT":
    case "CONTROLLER_DRAINING":
    case "SESSION_BUSY":
      return "Read the current Controller/Session status and existing operation. Let its owner settle the active work; do not start a competing operation.";
    case "STORAGE_UNINITIALIZED":
      return "Verify YUI_HOME first. For an intended new empty Home, the user or Operator can run `yui setup`; do not initialize over existing evidence.";
    case "STORAGE_SCHEMA_INVALID":
    case "STORAGE_SCHEMA_UNSUPPORTED":
    case "STORAGE_FORMAT_UNSUPPORTED":
      return "Run `yui doctor` using this Home and matching CLI. Preserve the database. Use `yui upgrade` only for a diagnosed supported version transition; invalid data needs Operator diagnosis, not reinitialization.";
    case "COMMAND_NOT_FOUND":
      return "Inspect `yui doctor` and the configured tool executable/PATH. Have the user or Operator restore the required dependency; no installation was performed by this diagnostic.";
    case "COMMAND_FAILED":
    case "COMMAND_TIMED_OUT":
      return "Inspect the command cause, exit status and dependency checks with `yui doctor`. A spawn failure alone does not establish missing execute permission; timeout does not prove external effects were undone.";
    case "USAGE_ERROR":
    case "INVALID_PARAMS":
    case "INVALID_REQUEST":
    case "MESSAGE_TOO_LARGE":
    case "METHOD_NOT_FOUND":
      return "Use the command's `--help` and correct its arguments/configuration within the existing authority. Do not bypass scope or validation checks.";
    case "TASK_NOT_FOUND":
    case "ROLE_NOT_FOUND":
    case "AGENT_NOT_FOUND":
    case "NOT_FOUND":
    case "DATA_ERROR":
      return "Verify the named record, prerequisites and current Home using the corresponding show/list/context command. Do not invent or recreate missing state from this error alone.";
    default:
      return "The root cause cannot be confirmed from this error alone. Preserve the operation identity and safe cause details; "
        + "inspect its current records/status and command help, then ask the responsible Agent or Operator to diagnose. No automatic repair or safe retry is implied.";
  }
}

export function sanitizeFailureText(text: string, context: FailureContext = {}): string {
  const secrets = [
    ...(context.privateValues ?? []),
    ...Object.entries(context.environment ?? process.env).filter(([name]) =>
      /token|secret|password|passwd|cookie|credential|api_?key|private_?key/i.test(name)
    ).map(([, value]) => value ?? "")
  ].filter(value => value.length > 0).sort((a, b) => b.length - a.length);
  let safe = text;
  for (const value of secrets) {
    // Short invalid operands must not replace every character of a diagnostic.
    const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    safe = value.length < 4
      ? safe.replace(new RegExp(`(?<![\\w])${escapedValue}(?![\\w])`, "g"), "[REDACTED]")
      : safe.split(value).join("[REDACTED]");
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) safe = safe.split(escaped).join("[REDACTED]");
  }
  safe = redactAgentErrorText(safe)
    .replace(/(\b(?:token|credential|body|prompt|content|input)(?:["']?\s*[=:]\s*))("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@[^\s/]+/gi, "$1[REDACTED]@host")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "?");
  return safe.length > 12_000 ? safe.slice(0, 12_000) + "…[truncated]" : safe;
}

/** Keep existing detail fields, but never dump secret/payload fields or Error internals. */
export function sanitizeFailureDetails(
  details: Readonly<Record<string, unknown>>,
  context: FailureContext = {}
): Record<string, unknown> {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return sanitizeFailureText(value, context);
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return undefined;
    if (depth > 32 || seen.has(value)) return "[omitted]";
    seen.add(value);
    const result = Array.isArray(value) ? value.map(item => visit(item, depth + 1))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key, /token|secret|password|passwd|cookie|credential|authorization|api.?key|private.?key|environment|^env$|^body$|^payload$|^prompt$|^argv$|^args$/i.test(key)
          ? "[REDACTED]" : visit(item, depth + 1)
      ]));
    seen.delete(value);
    return result;
  };
  return visit(details, 0) as Record<string, unknown>;
}
