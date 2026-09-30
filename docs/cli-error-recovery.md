# CLI failure diagnosis and recovery

This inventory covers the current CLI entry point, command-family catches and
asynchronous output paths. It is not a promise to infer every unknown cause.
An error is evidence about a failed step, not a rollback receipt for a command.

## Reading a failure

Ordinary exceptions retain the existing `ok`, `code`, `message`, `details` JSON
envelope and exit codes: usage 2, missing Task/Role/Agent 3, data 4, runtime 5.
Text and JSON share the same cause, effect and recovery explanation, including
command help previously omitted from JSON. Existing detail fields remain,
with an additive `details.diagnostic` projection. Controller identity queries
continue exposing the Controller code at the JSON envelope's `code`.

Diagnostics identify the command path, resolved Home, CLI entry, recognizable
record references and, when transport reached that stage, method/request ID and
socket. Raw argv, request/response bodies and arbitrary Error properties are
not dumped. Sensitive fields, credential-shaped text, known secret environment
values and invocation operands are redacted. JSON parser source excerpts are
omitted; causes are bounded to eight entries and each diagnostic string to
12,000 characters. A clipped cause is not complete evidence. Redaction cannot
infer the meaning of arbitrary unlabelled third-party prose.

Recovery examples using `yui` mean **the same YUI_HOME and matching absolute CLI
entry**, not whichever binary happens to be on PATH. A managed Agent uses its
Manifest's entry and existing authority. A missing permission belongs to the
user or Operator; error text grants no new authority.

## Coverage and disposition

| Error family / existing surface | Gap or existing behavior | Current handling and recovery |
| --- | --- | --- |
| Discovery missing, malformed JSON, metadata/ownership, Home/socket or protocol mismatch (`core/controllerClient`, `core/protocol`) | Missing file was described as proof of a stopped Controller; several validation failures had only “invalid”. | Preserve code and safe original cause; distinguish metadata, shape, version and identity failures. Missing discovery leaves process state unverified. Doctor/status first; start only if stopped, authorized restart only after ownership inspection. Never print the discovery token or raw JSON. |
| Connection refused, stale/missing socket, `EACCES`/`EPERM` | Generic unreachable advice could lead directly to start. | Record `not-sent` at the socket boundary; preserve syscall cause. Permission/sandbox denial routes to authorized access, not service restart or chmod. No inference that an unreachable process has exited. |
| Timeout, connection error after write, truncated/invalid response | Public CLI gave little/no recovery advice or request identity. | Record `unconfirmed`, method, request ID and socket. The request may have applied. Inspect original Task/Message/operation receipts; do not replay, change request-id or treat timeout as quiescence. Raw response bytes stay private. |
| Controller error response: auth, identity/protocol, invalid params, not found, busy/draining/handover, service/job/internal | Transport and application failure were not distinguished in presentation. | Record `response-received`; preserve the remote code. Auth/identity routes to matching Home/CLI inspection, usage to help, busy to the current operation. An error response does not establish rollback. Unclassified service/job/internal errors use an honest diagnostic fallback. |
| Startup/readiness and shutdown (`controller/clientRuntime`) | Readiness had a startup PID and nested cause, but top-level CLI discarded that cause. Detached spawn could emit an unhandled asynchronous error. | Display the cause chain and retained startup PID. Catch default Controller spawn errors at the existing promise boundary. Timeout does not prove exit; inspect the existing process before another action. No change to on-demand startup, lock waiting or bounded polling. |
| Managed preflight (`runtime/runtimeCoherence`, `runtime/managedCaller`, CLI Manifest checks) | Some storage and version failures were untyped; Manifest failures lacked a legal re-entry path. | Reuse storage/Controller error codes and the managed-identity error type. Preserve validation and scope gates. Read scoped context where allowed; Operator inspects/re-enters current Session. Never edit Manifest/environment identity or assume an old Session regained authority. |
| Storage schema/version and record/CAS failures | SQLite errors had invocation evidence but no common action; collecting build identity at error rendering added extra reads. | Use already-known invocation identity without a scan. Doctor for storage classification; setup only for intended empty Home; supported upgrade only after diagnosis. Preserve invalid data. Read the new record revision before deciding a fresh CAS mutation. No migration or repair runs from diagnostics. |
| Config/argument/record validation (`commands/config*`, agent/role/project/task parsers, capability/job/resource commands) | Existing `CliError` messages/help and codes were usually useful; JSON dropped help. | Retain those classifications and exits, include help in both formats, direct callers to the existing help/show/list/context commands. Unknown exceptions retain causes and explicitly do not guess a root cause or safe retry. |
| Dependency / subprocess execution (`tmux/commandExecutor`, runtime launch diagnostics) | Stable command errors discarded native spawn causes; stderr could be hidden at CLI. | Preserve native cause and bounded sanitized stderr/exit status. Doctor and configured executable/PATH inspection. `posix_spawnp failed` alone is not an execute-bit diagnosis. No installation, permission change or retry is performed. Existing launch classifications remain unchanged. |
| Task execution stop and publication verification wrappers | Wrapper text could lose nested failure identity. | Keep the confirmed progress statement and underlying cause. Physical cleanup failure is not confirmation of quiescence; publication observation failure is not a new publication attempt. |
| Project refresh, workspace/archive cleanup and Integration/upstream partial results | These already retain blockers, exact resource/result identities, completed projects and remaining work. | Keep their domain result/receipt contracts and ownership fences. CLI cleanup exceptions retain details and cause; cleanup and upstream failure messages use the shared explanation. Do not substitute generic repair or delete resources on arbitrary Git errors. |
| Queue/steer/interrupt (`emitControlFailure`, receipt formatters) | Already distinguish retained input, rejection, unknown delivery and confirmed control. | Retain stdout, exit 2 and their existing envelope; sanitize errors without replacing receipt-specific guidance. No retarget, request-id change or fallback action is added. |
| Release/update/upgrade (`commands/releaseCommands`, `cli/update*`, `cli/upgradeCommand`) | Domain reports already describe stages, actions, backups, partial effects, reconciliation and unknown ownership. | Preserve those domain reports and exits instead of forcing them into the ordinary exception envelope. Release/upgrade failed reports pass the CLI redaction boundary. Update retains its text-only interface and explicit `--json` refusal. Existing maintenance/retry/restoration protocols are unchanged. |
| Doctor and other diagnostic reports (audit, telemetry, resource inventory) | Reports deliberately contain missing/unverified/failed observations rather than throwing. Doctor's unreachable branch incorrectly suggested start. | Fix Controller guidance using the shared failure projection; preserve status and Doctor text/JSON exit semantics. Other observation reports keep their source/freshness/failure fields. No pre-command Doctor or `--deep` is introduced. |
| Asynchronous runtime callbacks and CLI warnings | Runtime callbacks used raw text even under `--json`; warnings could expose unsanitized causes. | Runtime errors use the shared projection, marked advisory; warnings are sanitized and JSON-shaped in JSON mode. They do not change the foreground exit status. Best-effort cleanup/optional reads remain best-effort; absent evidence is not fabricated. |

The shared projection selects guidance only from existing error types/codes,
not English message matching. Transport evidence is ephemeral diagnostic data,
not a new durable state, retry classifier, protocol version or source of Task
truth. In particular, `controllerCallMayHaveApplied` and its existing callers
retain their conservative behavior.

## Verification and limits

The focused tests cover the shared text/JSON contract, exits and existing
details, cause/secret handling, offline reads, permission denial and startup
timeout identity. One disposable Unix-socket server covers pre-send failure,
timeout, invalid response and explicit error response, verifying one request
per call and teardown of owned sockets and Home. It never starts a model or
uses account quota.

The remaining command-family inventory is source inspection plus existing
core regressions, not a one-test-per-error matrix. A response error cannot
prove transactional rollback; a transport request ID is correlation evidence,
not necessarily a durable domain idempotency key. Errors flattened by an
upstream component cannot reconstruct discarded evidence. No production Home,
real macOS installation, paid provider, remote publication or live user
Controller is exercised by this work.
