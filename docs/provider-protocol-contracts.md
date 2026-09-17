# Supported Provider parsing contracts

This is the evidence for Yui's consumed protocol fields, not a version allowlist
or a model catalog. Unknown protocol state must not become successful execution.
Fields Yui does not consume may evolve without requiring an exhaustive schema
validator at this boundary.

## Evidence

The 2026-09-17 audit used the installed native producers without making a model
request, contacting an account API, starting a shared daemon, or reading user
conversations:

- Codex CLI **0.153.4**: `codex app-server generate-ts --experimental --out <scratch>`.
  Generated `v2/ThreadReadResponse.ts`, `ThreadResumeResponse.ts`,
  `ThreadStartResponse.ts`, `Thread.ts`, `Turn.ts`, `TurnStatus.ts`,
  `ThreadStatus.ts`, `ThreadItem.ts`, `UserInput.ts`, `TurnStartResponse.ts`,
  `TurnSteerResponse.ts`, the Turn/Goal notification types and
  `ThreadListResponse.ts` establish the fields below.
- Claude Code **2.1.270**: the installed package's shipped Hook/stream schemas and
  corresponding serialization code. In particular the shared Hook input,
  `MessageDisplay`, `Stop`, `SubagentStop`, `StopFailure`, result union and
  `active_goal` schema/serializer establish the fields below. These are producer
  evidence, not an assumption that Claude uses Codex's Goal vocabulary.
- Yui's actual consumers: `CodexAppServerRuntime` → structured Provider Session
  → `publishStructuredProviderTerminal` → runtime inbox/Controller result
  processing. Hook observations use the Driver and the same fenced observation
  contract. The transcript cursor is process-local in `AgentRuntimeObserver`;
  its persisted usage checkpoint is a separate, unchanged contract.

Online documentation retrieval was unavailable during this audit. The local
generated/shipped protocol evidence and deterministic fixtures do **not** prove
live Provider execution. Recheck the native producer when changing this boundary;
do not add guessed aliases to accommodate an unverified fixture.

### Configuration discovery evidence and version scope

The configuration-source follow-up on 2026-09-17 confirmed the installed package
versions above by reading their package manifests, without launching either
Provider Session. An additional offline `app-server generate-ts --experimental`
run used a disposable native Home and produced `ConfigRequirementsReadResponse`,
`ConfigRequirements`, `ModelProviderCapabilitiesReadResponse`, `AskForApproval`
and `SandboxMode`. A missing requirements envelope is not the documented
`requirements: null`; a missing `webSearch` is not an explicit false. The
`AskForApproval` union also contains structured `granular` policies, which Yui's
scalar picker cannot represent: valid structured entries narrow the choices
without causing the entire metadata query to fail or inventing a scalar alias.
Doctor now names the versions **audited producer versions**, not "latest tested
versions": generated types and shipped protocol evidence are not live execution.
The existing adapter admission floors remain Codex **0.150.1** and Claude
**2.1.207**. This audit does not establish a higher minimum, prove every version
above the floor, or establish that an older admitted version necessarily fails.
Doctor checks required CLI flags; native discovery reports its own failures.
ACP continues to negotiate protocol support, not a product version allowlist.

The official OpenAI Configuration Reference was also retrieved through the
documentation service during this follow-up:
`https://learn.chatgpt.com/docs/config-file/config-reference#configtoml`.
It documents the three sandbox modes and now describes `untrusted` approval as
unsupported, while the locally generated 0.153.4 type still includes it. Neither
fact alone proves account acceptance, and current documentation is not retroactive
evidence about every older supported producer. Yui retains its explicit adapter
configuration syntax, labels offline choices as static/unverified, and only
offers help-reported, adapter-supported approval values on the observed path
(further narrowed by native configuration requirements). It does not rewrite a
user's stored approval policy.

Model aliases are never supplied by static discovery. Claude's settings-source
list remains the adapter's declared `user`/`project`/`local` contract, not a claim
that a help parse or account query confirmed it. Missing permission enums are
unavailable; custom native inputs stay explicit. Live model metadata, static
inputs and unavailable fields may coexist, with their reasons and warnings
preserved across cache and failed-query presentation. No real-model/account
validation was performed for this follow-up.

## Codex App Server

| Surface | Consumed current contract |
| --- | --- |
| Thread start/read/resume | Nested `thread`; mandatory exact `thread.id`. No direct-object fallback or request-ID substitution. |
| Thread read/resume status | Tagged `{type: idle, active, systemError, notLoaded}`; `turns` is an array, including an empty array when history is not populated. |
| Turn state | `inProgress`, `completed`, `interrupted`, `failed`; an included Turn must have its own exact ID and known status. |
| Turn start / steer response | Start uses `turn.id`; steer uses direct `turnId`. They are different method contracts. |
| Native Turn notifications | `threadId` and nested `turn.id/status`; started is `inProgress`, completed has a terminal status. |
| Native tool items | `item.id` on started/completed, direct `itemId` on text deltas. Tool status must be known; command/file `declined`, nonzero command exit and dynamic-tool `success: false` are failures. |
| Input / output items | `userMessage.content[]` contains typed `UserInput`; only `type: text` contributes human text. `agentMessage.text` is the unmodified report. |
| Goal | `threadId`, camel-case fields/statuses from the generated Goal schema; get can return explicit `goal: null`, update carries a Goal, clear is a distinct event. |
| Descendant list | `data[]`, with the native ancestor filter; a bounded page remains partial evidence. `parentThreadId` is real; guessed `ancestorThreadIds` is not read. |

The current `text_elements` spelling on text input is intentional. Image, audio,
skill and mention inputs remain legal; they are not reinterpreted as human text.
Empty history, nullable Goal/token budget, and absent output on a terminal remain
distinct from malformed identity/state. Full native failure payloads remain
available to error interpretation. Generic string IDs are supported; neither
UUID-only validation nor identity normalization is introduced.

Removed guesses include `running`/`active`/`in_progress` Turn status aliases,
`agent_message`/`user_message`, generic role/message layouts, arbitrary
string-or-array content fallbacks, and cross-method ID fallbacks.
An invalid read/resume fails explicitly; an invalid live notification is
diagnosed and ignored without clearing the owned input or publishing a terminal.
Foreign conversations remain ignored; another client's valid Turn retains its
own identity and cannot settle Yui's input.

## Claude Code

Hook common input supplies `session_id` and optional `prompt_id`.
`MessageDisplay` additionally has a real event-specific `turn_id`, `message_id`
and `index`; the event-specific Turn field is not a universal fallback.
Tool Hooks use `tool_use_id`; `PermissionRequest` has no required tool-use ID and
uses the owned Hook occurrence for wait identity. Subagent Hooks use `agent_id`.
Optional `last_assistant_message` is the report, not `summary`/`message`.

`SubagentStop` has no outcome/status field and also runs on interrupted queries.
It can report a child's text and stop boundary, but never infers succeeded from
an absent field. `Stop`/`SubagentStop` may include `background_tasks` and
`session_crons`; only explicit empty lists establish an empty background
snapshot. An absent list is not empty. The invented
`background_tasks_complete` field is not consumed. `StopFailure` preserves
`error`, optional `error_details` and optional `last_assistant_message`, not
unproduced terminal/retry control flags.

There is no `active_goal` object in the supported Hook inputs. The stream event
is `{type: "active_goal", session_id, uuid, value}`: `value` is null or carries
`condition`, `iterations`, `set_at`, `tokens_at_start` and optional `last_reason`.
It supplies active/cleared evidence only. Yui timestamps its observation; it
does not turn the goal's creation time into a last-update timestamp or invent
paused/completed states, token budgets or native Turn identity.

Stream results require the exact `session_id`, a message `uuid`, boolean
`is_error` and the current subtype union: `success`, `error_during_execution`,
`error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.
A `success` subtype may still carry `is_error: true`. Result UUIDs remain message
deduplication identities, never native Turn IDs. Unknown/incomplete results
retain the serialized owned input and produce a diagnostic, not success.

## Cursor and storage boundary

The observer accepts only its current cursor, including continuity epoch and
sampled file identity. Its own unavailable-before-first-read cursor remains
legal. Unsupported cursors raise an explicit error, which the Controller
projects as unavailable; they are not silently replayed from the beginning.
File truncation/replacement and durable checkpoint recovery are unchanged.

No persistent layout, aggregate, record or configuration schema changed.
There is no storage version transition in this change. Existing centralized
migrations and historical observations remain intact. ACP interoperability,
custom model selection and model catalog live/cache/unavailable semantics are
outside this parser cleanup and unchanged.
