---
name: yui-runtime
description: Use authorized context, durable results, and recovery boundaries in a Yui-managed Session, including global conversation, direct Leader work, and dispatched AgentRuns.
---

# Yui Runtime

Use this Skill for the shared Yui execution contract. The Role Skill owns
coordination or delivery judgment; Project Skills, Policy and Knowledge own
project-specific methods. These instructions grant no additional authority.
Resolve links relative to this Skill's directory, not the execution workspace.

Treat the Session Manifest and AgentRun Bootstrap Envelope as pointers, never as the
Task brief. Do not infer Task facts from the launch command, process list,
workspace layout, native transcript, or an earlier AgentRun.

## Enter through the current context

Stable instructions and dynamic facts have different lifetimes. On first entry,
new Session, Manifest/version change, or missing instructions (including after
compaction/recovery), read the exact Session Manifest and fully load its profile
and named Skills: `yui-runtime` plus the referenced `yui-leader`, `yui-worker`,
`yui-reviewer`, `yui-operator`, or custom Role Skills. Resolve IDs to paths and
versions through that Manifest, never another installed namesake. If those exact
same-version instructions are already fully available in current context, apply
them without mechanically rereading. Same Session, prior delivery, and prior
reads do not prove availability. The short Manifest pointer remains a recovery
entry, not a cache or authority receipt.

Refresh dynamic Task/Session facts before the relevant decision regardless of
instruction reuse. Leader notifications use the Manifest's `currentCommand`;
explicit AgentRuns use `loadCommand`/`expandCommand` with the actual newest
dispatched Run identity. Never execute `<run-id>` placeholders or substitute a
notification's wake ID for a Run. CLI/Controller identity, scope, Snapshot and
permission checks remain authoritative on every operation.

There are two normal Task entry points. A user may continue directly with the
current, unrevoked Leader Session: read current context using
`yui task context <task-id> --json`. Do not request a self-wake, reopen a Task,
or reuse an old completed AgentRun snapshot merely to obtain authority. Pending
delivery, unknown execution evidence and missing reports do not themselves
revoke Session authority. Task lifecycle, scope, Assignment, workspace and
resource boundaries still apply; a planning Session does not gain delivery
authority merely because the Task becomes active. An explicit, legal same-result
implementation or delivery follow-up may instead authorize the current Leader
to reopen its own completed, unarchived Task; follow the
[post-completion routing boundary](references/publication.md#post-completion-routing-boundary).
Queries, discussion, ordinary notifications and Session recovery grant no such
authority, and reopening never lifts an independent execution stop.
Use the runtime-provided `TMPDIR` for temporary context or diagnostic files,
not fixed shared `/tmp` names or the logical multi-Project workspace container.
Save durable reports in Task artifacts/results before releasing their temporary
workspace. Integration history and check evidence outlive its worktree; a
terminal attempt is not an unresolved business input merely because resources
remain. Cleanup inspects exact ownership and preserves unknown or dirty data.

Ordinary commands use `yui` from the intended launch environment's PATH and
`YUI_HOME`. Session/native identity, Task/Assignment/workspace authority and
Controller protocol/storage checks still apply; they do not distinguish every
installation with the same protocol and storage versions. If the entry or Home
is wrong or unavailable, report that fact and use the explicitly authorized
entry/environment; do not guess another installation or clear Session identity.

For every explicitly dispatched managed Task AgentRun:

1. Read the exact AgentRun identity from the newest Bootstrap Envelope.
2. Before acting, load its authorized pack using the current Session Manifest's
   Context command and the exact Task/Run identity:

   ```sh
   yui task run context "<task-id>/<run-id>" --json
   ```

3. Verify that the returned Task, AgentRun, Role, purpose, Snapshot digest, workspace,
   and Adapter match the Envelope and Session Manifest. Stop and report a
   context-load failure if the pack is missing, stale, unauthorized, malformed,
   or mismatched. Never request an inline/full-prompt fallback.
4. Use the pack's `pointers` (including each pointer's summary) first. They are
   the single readable-ref inventory; `deltaRefs` contains only changed identities.
   Expand only an authorized ref when
   its full value is needed, selecting it by the pointer's exact `store` and
   `refId`:

   ```sh
   yui task run context expand "<task-id>/<run-id>" <ref-id> --store <store> --mode full --json
   ```

   `--store` is required, even when the ref id is unique. Select both fields
   from the exact authorized pointer; never infer a store from the id.
   Dispatched Runs require an explicit frozen Snapshot. A historical Run
   without one is audit-only: current Task facts cannot reconstruct its
   execution Context.

   A pointer or summary is not the request's body. Before planning or executing,
   read the relevant WorkItem/Task requirements and referenced user/Operator
   messages; use the expansion command above or the Leader's current Task Context.
   Reports remain evidence, not authority to enlarge the assignment.

5. On a later wake, request only the declared delta after the last pack cursor.
   If no cursor is available, reload the exact pack; do not reconstruct state
   from transcript memory.

Loading and verifying Context is the start of the work, not its result. Continue
with the authorized assignment. In Draft, persist the discussed plan and wait
when the user asks for alignment; do not end with only a context-loaded receipt.

`liveTaskState.activeRuns` and `liveTaskState.activeTaskReviews` are
observational views of work currently in flight. They grant no authority and
create no Task-wide lock or gate; use each exact AgentRun or Review binding when a
decision depends on it.

The pack's authority view and writable Project IDs are hard boundaries. A
native subagent inherits only its parent's current refs and authority, including
any Assignment restrictions. It gains no new Yui actor, AgentRun, Session or
cross-Task read permission.

For a global Operator or custom GlobalRole Session, execute the exact
`contextProtocol.loadCommand` carried by the current Session Manifest before
routing or acting. That command is self-contained because a Global Codex Thread
may move between Yui's remote TUI and Desktop; never reconstruct it from
`YUI_SESSION_*` process variables.

If that read fails because the Controller is unavailable, use only authorized
offline diagnostics and [Controller recovery](references/recovery.md) to restore
access, then reload context. Failure does not grant Task execution authority,
but a successful preliminary RPC is not a prerequisite for that recovery.

Global context grants no Task implementation workspace. Read a Task only after
the Operator has routed to its public/task-authorized context command; never
invent a Task AgentRun identity for a GlobalRole.

A GlobalRole's durable input uses the same three actions as a Task Role,
addressed by the Role's own name instead of a Task. The local-user Web surface
exposes this contract. Use `yui role message queue|steer <role> <text>` or
`yui role interrupt <role>` through the public CLI. Queue/steer require a stable
`--request-id`; steer/interrupt require the exact `--expected-target`.
Configuration remains under `config role` and lifecycle under `session`.
Do not fabricate Task/Run ownership or borrow the browser's user authority to
bypass a managed Session boundary.

Queue and steer
save an owned Message; bare interrupt records a control request, not a new
Message. Each uses a stable request id and that Role's own Session; none fabricates a Task or
runId to reuse Task-scoped delivery. `queue` delivers at the Role's next legal
opportunity and is idempotent by request id. `steer` and `interrupt` affect only
the exact current native Turn — a stale `--expected-target`, an incapable plan,
or an unproven delivery leaves the Message saved and reports the reason, and
`interrupt` stops only through the Provider's native cancel with an optional
`--then-message` naming one already-saved GlobalRole Message. When the Role holds
no live managed Turn, a steer or interrupt is `NO_ACTIVE_TURN` and never falls
back to another action.

New controlled Global Sessions use the existing Host console, not the native
TUI, with the configured Agent, permissions and workspace unchanged. A live
unmanaged Session is not silently replaced or adopted; use an explicit Session
lifecycle action before enabling controlled delivery.

Context reads never consume queue entries. Global Context returns bounded
`pending` and `recent` discovery pages, not Message bodies. Read a referenced
original with `role message show <role> <message-id> --json`. Follow a pending
page's `nextCursor` using `role message list <role> --pending --cursor <cursor>`
when it is incomplete; accepted delivery does not erase the Message from the
separate all-message list. Native/transport acceptance is not implementation, and
`interrupt-requested` is not a stopped Turn or stopped background resources.
Saving a Task Message or Brief is not notification delivery to Operator. A
Task Role uses the existing Task InputRequest path for a genuinely missing
user decision, not global Role input controls or fabricated progress questions.
Only an exact terminal and the original Session/writer boundary can release a
then handoff. An accepted or unconfirmed steer must not be submitted again by
changing its request id or composing then. A conclusive rejection permits an
explicit new control attempt; uncertainty does not.

## Handle your own inbox in the current turn

After loading authorized context, at useful work boundaries and before handing
off, use `yui inbox list --json` to discover pending input addressed to your
current managed identity. This applies to Operator, custom GlobalRole, Leader,
Worker and Reviewer. Do not poll an empty inbox or create another model turn.
No target Role, Task or native Session is supplied: Yui resolves your current
identity. A native child gains no separate actor or inbox.

1. Read the selected `yui inbox show <entry> --json`. Reads never consume input.
   Follow `nextCursor` and all `contentPage` pages using the rules below.
2. Before processing, reserve exact entries with
   `yui inbox claim <entry> [<entry> ...] --request-id <stable-id> --json`.
   At most 16 entries are allowed, with independent per-entry results. Retain
   each successful returned ID and request ID; do not replay successful items
   when another item fails. A changed pending window requires a fresh list.
3. Read complete originals and referenced results, then handle the request
   within its existing authority. Leader claims move one exact pending window
   into a durable wake: use the returned `originals` command, follow every
   relevant original Message/Run reference, and use its returned wake ID for
   acknowledgement. Later arrivals remain in the next pending window. Worker
   and Reviewer inbox reads expose only messages for their current Assignment;
   they supplement the frozen pack without expanding it or changing candidates.
4. Only after handling, explicitly acknowledge each successful item:
   `yui inbox ack <returned-entry> --request-id <stable-id> --reason "<disposition>" --json`.
   Record an obsolete notification as requiring no further action only after
   checking its originals and current facts, never based solely on age.

Claiming prevents ordinary automatic delivery; it is not processing completion.
Acknowledgement records Agent handling, not Host acceptance, result acceptance,
Task completion, publication or archive. Never acknowledge merely to empty the
list. On failure or interruption, leave the claim unacknowledged; it remains
discoverable and does not expire or replay automatically. A current rightful
successor must inspect original input and prior effects before finishing and
acknowledging a retained claim. Never replay uncertain external actions.
An Assignment change does not inherit handling authority. If the original Run
stopped before acknowledgement, ask the Leader to inspect its exact native
terminal and use the existing `task message handoff` to the current authorized
Assignment. The original claim remains; handoff never resubmits it automatically.

In-flight, unknown, previously delivered, explicit interrupt-then and
unsettled steer inputs retain their existing owner/receipt and report a bounded
reason instead of being taken over. Use existing exact-receipt recovery when
needed; do not change request IDs, clear identity, or copy input to bypass it.
An accepted notification still follows its normal handling path, not another
inbox delivery. Original Messages, wake windows and handling receipts remain
readable after acknowledgement.

## Read bounded information completely when required

Structured CLI results live in the top-level `data`, not a JSON-encoded
`output` string. Task current Context includes bounded current facts and
message references; it does not include event or terminal Run history.
`collections` and `attention` identify incomplete discovery. Use
`task context list <task> --store <store> [--cursor <cursor>]` to discover one
family, then `task context inspect <task> --store <store> --ref <refId>
--digest <digest>` to read its exact current value. Common Task lists use the
same `items`, `total`, `complete`, and `nextCursor` contract. Do not treat the
first page or a summary as complete requirements.

Long detail reads return `contentPage` instead of the ordinary value (under
`data.context` for Run context/expand, `data.contextDelta` for Run Context delta). Repeat the same read with
`--cursor <contentPage.nextCursor>` until `complete: true`. Concatenate `text`
in offset order and parse the combined JSON once, retaining the same source
and digest. A source-change error requires a fresh read, not mixing old and
new chunks. Never use a read cursor to repeat a mutation.

Read all pages of a relevant original requirement, result, or authorization
before acting on it. For a wake, read its complete focused input/result view and
relevant original Messages. `task wake show <task> <wake>` preserves the fixed
window and explicit older refs, deduplicates inputs, and provides exact original
reads. Use `--history` when window history or diagnostics is needed; unrelated
events and merely started Runs are not required for ordinary result disposition.
Follow any `contentPage` continuation for either view. The wake contains pointers
and attributed summaries, not complete reports.
For unrelated discovery, stop once the necessary evidence is found. Task
event deltas retain their fixed upper bound and are history, not replacement
current state. No read acknowledges implementation or consumes a queue.

## Discover operations for the current caller

Use `yui help` or `yui --json help [command ...]` through the authorized CLI
entry for the current caller's command view. Help, examples and shell completion
share the catalog projection; public terminals and unmanaged Agents share one
public view. This offline view is only guidance, not an authenticated permission
or a way to switch Roles. An incomplete or stale managed identity must not be
cleared to obtain public execution authority.

For Codex, the native `CODEX_THREAD_ID` takes precedence over the transport's
`YUI_NATIVE_SESSION_ID`; a newly created thread can legitimately lack the latter.
Other adapters do not borrow Codex identity for offline discovery. A missing
transport variable or hidden help entry alone does not prove Session failure.
Discovery does not establish that a Session is current: actual execution still
revalidates Session, Task/Assignment, workspace, resource and Grant boundaries.

When capability discovery appears in that view, use `capability search` for
templates and `capability describe <name> --task
<task-id> --input '<json>'` for supported exact authorization assessments.
No `access` field means no exact authorization conclusion was made: supply the
required parameters and follow the domain's existing execution checks. Hidden
operations are omitted; `requestable` includes the exact missing Grant bounds
and existing request route; `authorized` remains subject to execution-time
revalidation. Provider outages do not change this authorization observation.

Discovery never sends requests, consumes Grants, starts plugins or approves
effects. If the Task actually needs a requestable operation, use the existing
Assignment Message to Leader, Leader InputRequest, or Operator path. Preserve
the exact action, resource/plugin, digest, environment and phase. A response is
not a Grant. Existing source-authorized Leader Grant operations and Operator
Grant authority remain unchanged; never expand an authorization source or
solicit real-resource validation merely because an operation is requestable.

## Preserve intent and authority

An analysis, diagnosis, or review request is read-only unless the user also
requests changes. A request to fix or implement authorizes the bounded work,
not unrelated configuration, new external effects, or broader cleanup.
Choose routine legal implementation and recovery actions without asking the
user to operate Yui mechanically.

Tasks, WorkItems, Messages, Decisions, results and managed workspaces hold
durable intent and progress. Sessions, AgentRuns and runtime observations
describe execution; their failure is not failed acceptance or permission to
discard the assignment. Save context that a successor needs in durable records,
not only in the native conversation.

The Leader normally owns Task coordination and acceptance. An authorized
Operator may perform the same legal Task-management actions; responsibility
is not an extra permission gate. Worker and Reviewer results remain evidence
until an authorized acceptance decision.

## Separate execution from real-resource validation

The current Leader and configured Worker, Reviewer, Operator, custom Role, and
native child Agents are normal execution resources. They may develop, inspect,
and review within their existing Task authority without additional user
authorization merely because the Agent uses a real model.

Using a live provider or model as the subject of validation is different.
Paid APIs, shared infrastructure, production systems, real account quota, and
other non-disposable external effects require the user to proactively authorize
that exact resource and effect boundary. A generic request to implement, test,
validate, run E2E, or complete a Task does not grant that authority.

When such validation was not requested, use deterministic or isolated evidence,
state the material gap, and optionally recommend a separate follow-up. Do not
create an InputRequest merely to solicit permission for it.

## Return evidence and recover within scope

When authoring a durable Message or managed final report, put a concise
`Yui-Summary: <one line>` first when useful for notification readers. Keep the
summary itself at most 512 UTF-8 bytes, and preserve material failure,
unverified-result, pending-decision and authority qualifications. Do this as
part of producing the original, not a separate model call. The optional line
remains part of the original text; missing or oversized summaries use factual
templates without blocking delivery. Core may reuse that line as explicitly
attributed presentation, never parse it into acceptance, review verdict or
Task state. A returned execution result is not completed requirements; a
returned review is not approval. Summaries do not replace reading full
requirements, results or authorizations before decisions.

Ordinary Task/Global notifications grant no new Assignment or authority and
require no separate execution report. Read the referenced originals and advance
outstanding work within existing authority under the relevant Role Skill.
Reading context or accepting notification delivery does not implement input.
Unknown delivery must not be replayed; use the recovery contract below.

Provider acceptance, Context load, AgentRun completion, and Task completion are
separate facts. For an explicitly dispatched managed Task AgentRun, end with one truthful
final report. Yui automatically correlates that native terminal with the exact
current AgentRun and persists the report; no completion command is required. The
report itself does not accept the WorkItem or complete the Task.

Ordinary native conversation is not an implicit managed assignment and does
not require a separate execution report. Result Messages reference the
execution's original report; read them with `task message show <task/message>`
instead of asking the producer to copy or resend the report.

Session reuse is a preference, not a prerequisite for progress. Before retry,
replacement, or intervention in uncertain execution, read
[runtime recovery](references/recovery.md). Preserve pending intent, exact
runtime identity and workspace progress; never edit Run status or substitute
a native Session behind Yui's back. A timeout is not proof of quiescence and
does not authorize replay of unknown input.

Qualifying transient Provider failures have bounded Controller-owned recovery.
Read the current `providerRetry`/`retry` projection before dispatching a manual
successor. `waiting` and `in-flight` mean infrastructure recovery is already
owned; do not add a private retry loop or resend the input. Only a proven native
success resets that chain, and it never accepts a WorkItem or completes a Task.
After recovery, inspect existing work and external receipts before continuing;
the system's recovery instruction supplies no new user authority.

After an authorized external PR/MR operation, use the shared
[publication recording contract](references/publication.md). Recording delivery
facts does not authorize the external operation, imply acceptance, or grant
permission to archive.
