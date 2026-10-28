<p align="right"><strong>English</strong> | <a href="./managed-turn-and-session-runtime.zh-CN.md">简体中文</a></p>

# Session, AgentRun and notifications

Global Session stop/replacement uses the same exact native-execution quiescence
boundary as Task Sessions. A departed Host or archived Session alone is not
proof that an accepted input ended: its retained Provider binding is inspected
and stopped before settling occupancy. Global stop evidence is retained as a
record-only system Message, without submitting another native input. Pending
notifications cannot restart an explicitly stopped Session; normal Host detach
preserves an active Session and remains reconnectable. A switch after a partial
failure still settles the retained input before selecting a new conversation.

Local stop waits for its durable cleanup obligation, not for the Home-wide
`scheduler.scan` loop to empty. A signal only requests reconciliation; the
existing physical-stop proof and cleanup transaction remain the completion
boundary. A timeout retains the obligation and blocks replacement. Selection
failure and unconfirmed startup are reported separately; neither permits
replaying an uncertain native operation.

`operator status` and Session context distinguish desired/effective launch
revisions and selected-writer state from Host observation health. Old-conversation
failures remain audit evidence, not the new Session's current failure.
An exact rejected input can be explicitly retired when obsolete; accepted,
submitting, unknown and interrupt-owned input still retain their handling path.

`controller status --json` exposes bounded observations under
`identity.runtime.observations`: authenticated requests, scheduler pending
scopes, phase/read costs and sampled event-loop lag are separate facts.
Samples use a process-monotonic clock and hashed target/request labels, with
at most 16 recent and 16 active samples plus the slowest completed sample.
In-flight request count is not queue depth, and pre-routing wait is not
measured. These observations neither identify an old incident retroactively
nor establish quiescence; restarting a Controller does not refresh live Hosts.

`observations.persistence` separates main-thread database lock/body/commit
costs from persistence-worker round trips, worker execution and worker reads.
Worker summaries travel on existing replies and retain a worker-instance ID;
status reads only cached facts, never performs a diagnostic worker RPC.
Match hashed request targets when comparing round trip and execution. The
difference includes startup, queueing, transport and main-loop delay, not a
pure queue-time measurement. Nested database/read durations overlap worker
execution and must not be added to it. Historical maxima may belong to other
requests; the latest/slowest samples retain their own timestamps.

With the default persistence worker, periodic Project-sync configuration checks,
expired Input recommendations and run-progress/stall diagnostic transactions
execute on that worker as complete read/check/write operations. Their callers
await completion; lock waiting does not block the socket thread. Existing
transaction fences and idempotent folds remain unchanged. Explicit worker-off
mode and injected adapters retain synchronous behavior. This is not blanket
isolation of all database writes: launch admission, mailbox claims, due Job
admission and other lifecycle writes still require their own boundary analysis.
Status responsiveness during these maintenance operations is not proof that
every possible Controller stall has been eliminated.

Idle Global inbox recovery and already-settled retry checks use read-only
snapshots, without reserving SQLite's writer. Creating a recovery notice or
settling an outstanding retry still rechecks the current Session/claim/input
inside the original write transaction. This removes no-op lock waits, not
contention from actual writes.

Production Controller startup (including handover promotion) retains operational
diagnostics in `runtime/controller-diagnostics.jsonl`, with two rotated files.
Each file is bounded to 1 MiB and owner-readable/writable only. An asynchronous
writer admits at most 32 queued records (16 KiB each); it never writes the
business database. Scheduler/startup errors retain a classification, fingerprint
and build-relative source frames, not raw messages, arguments or credentials.
A 250 ms memory-only sampler records new failed/slow observations (at least
1 second), active slow work or its own loop delay at most once per second.
Records carry wall time, monotonic time, PID, process-instance ID and version;
bounded phase snapshots retain hashed request/target identities. It is sampled
evidence, not a trace of every request or the exact cause of pre-routing delay.
`observations.diagnostics` reports written/dropped/pending records and write
failures. No successful diagnostic write is assumed when storage fails.
Rotation, queue overflow and abrupt termination can lose evidence; a blocked
loop cannot emit a snapshot until it resumes. No automatic restart or operation
replay is introduced. These disposable operational logs are not Task state,
acceptance, a second recovery authority or a Home schema migration.

Scheduler caches load families lazily and use transaction-maintained Task
read revisions. Another Task or Global message does not invalidate an unchanged
Task history; updates, deletions and external writers still do. Compound folds
pin a read snapshot, uncommitted writes cannot publish a reusable cache token,
and only 16 recent Task projections are retained. Cache entries never authorize
dispatch or replace exact mutation-time checks.

A newly created global Operator conversation requests the native title
`Yui · Operator · MMdd`, using Yui's configured time zone. The request is made
only after the provider returns the exact new conversation identity; restore
and reconnect paths never replay it. Providers without a post-create rename
capability keep the usable Session and expose a diagnostic instead of treating
metadata failure as Session-creation failure.

## Authority

Task, WorkItem, Message, Decision, Artifact and Project Knowledge preserve
durable work. Session identifies a native conversation and its captured
authority. AgentRun records an explicitly requested execution and original
result. AgentHost is a disposable attachment, not the owner of Task truth.

A current, non-revoked Leader Session can read Context and save scoped Task
facts, including a formal InputRequest, without an active Run. Its exact
Session is the request's origin; an actual Run is included when present.
The question survives that execution ending and remains open until answered
or cancelled. Worker and Reviewer commands retain exact
Assignment checks. Session replacement, Role binding, Task scope and resource
grants are checked at their respective boundaries. An active Run pointer is not
proof that an unrelated command in the same Session came from that Run.

Native chat, Goal continuations and ordinary Leader notifications do not
automatically create Runs. Explicit dispatch loads one exact Run Context Pack.

## Context

### Current caller and durable handling

Desktop and TUI use the same current-Session authority. A Desktop command carrying
only `CODEX_THREAD_ID` resolves its owner from the selected Home's current and
historical Session records, then verifies the current Role/Agent binding, revocation and
captured workspace. Codex's native ID takes precedence over an inherited transport
ID, so a native child carrying inherited Yui hints cannot borrow its parent's identity.
An unknown provider ID alone is an ordinary public caller; partial Yui identity,
known historical identities and conflicting hints fail closed. A wrong Home with
Yui hints is rejected. A thread known only in another Home cannot be distinguished
from an ordinary thread without those hints; Yui does not scan other Homes.
Environment variables and a Manifest locate
context, not continuing authority. A replaced Session retains only its bounded
self-diagnostic reads, not inbox or mutation permission.
See [authorization responsibilities and matrix](authorization.md) for the public
surface, discovery semantics and resource boundaries.

`yui inbox list` exposes the current identity, delivery evidence, handling state
and blockers separately. Reads never consume input. Automatically accepted
Global messages, delivered Leader windows and the current Assignment's
continuation messages still need `claim` and explicit `ack --reason` after their
originals and effects have been handled. Claiming delivered input does not resend
it. Pending/unknown acceptance cannot be taken over; an accepted Global input or
Leader window can be explicitly settled by its rightful successor without
changing its original delivery target. Include useful result/effect receipt
references in the reason. Task completion still requires handling user inputs,
not merely a native terminal.

Receipts remain on the existing Message/TaskWake records. Both notification
paths pin mutable Draft revisions by existing `message.updated` event IDs,
not timestamps; a later revision cannot inherit an old acknowledgement.
Claimed Message content and fixed window references cannot be silently replaced.
Duplicate accepted notifications do not re-submit that revision. If a handler
crashes or ack fails after an external effect, inspect the original claim and
effect receipt, finish only unfinished work, and retry the same acknowledgement.
No lease expires and no installation upgrade or context compaction resets
handling. This reuses storage 1.7 payloads without adding a message system,
schema transition or an arbitrary external exactly-once guarantee.

```sh
yui task context <task> --json
yui task context list <task> --store <store> [--cursor <cursor>]
yui task context delta <task> --after <coreCursor>
yui task context inspect <task> --store <store> --ref <id>
yui task run context <task/run> --json
yui task run context expand <task/run> <ref-id> --store <store> --mode full --json
```

Task Context is a bounded authorized working set with a current core cursor.
Delta pages immutable events through a fixed upper bound; inspect expands a
current record and can require an exact digest. Runtime observations state their
own coverage and do not become another durable snapshot.

Entry Context samples current facts; it is not a complete historical inventory.
List one authorized record family, then inspect the relevant originals. Large
details use `contentPage` and `--cursor`; concatenate all exact text chunks before
parsing. Global `session context` likewise separates bounded pending/recent
discovery from `role message show`. See the
[CLI information contract](cli-information-contract.md) for budgets, scope,
continuations and the complete-original reading protocol.

Run Context freezes Assignment, source references, effective configuration and
workspace boundaries. A Role edit does not rewrite an existing Assignment.
Reading either Context does not acknowledge input or create execution authority.
Every managed input points to the exact Session Manifest and CLI entry. The
Run Pack is a reference directory: read the relevant requirement and message
bodies before acting, rather than treating a successful load as the deliverable.
Planning Packs expose no Project write scope or Task-completion permission.

The Manifest pointer is a recovery locator, not a read receipt. At the start of
every turn run `yui session skills --json` through the Session's CLI/Home. It
checks current paths, internal `VERSION` files and readability, without reading
Skill bodies or walking/snapshotting resources. Builtins use the running
installation's `skills/<id>` entry; configured Skills use `YUI_HOME/skills/<id>`.
These paths do not contain a Session/content digest. After changing installation
locations the check resolves the current installation, not an old recorded path.
For Global Sessions the Manifest's `skillCheckCommand` is its self-contained
`session context <role>` read, which also returns current Skill metadata and works
after moving to Desktop without the launch shell's environment. An older Global
Manifest's existing `loadCommand` provides the same check.

Load current `yui-runtime`, applicable Role/custom Skills and necessary references,
plus the Manifest's profile, on first entry, a version change, recovery, or missing/
compacted/uncertain context. Reuse only when versions are unchanged and the full
instructions remain available now. Yui stores no "already read" state and does
not claim to inspect the model's context. Historical packages remain audit only;
missing/corrupt snapshots do not prevent valid Session resume or input delivery.
Missing current files report their exact path and recovery action. Session
identity, scope, writer fences and real CLI/Home incompatibility still reject.
Always refresh dynamic facts. Leader notifications use
`currentCommand`; dispatched AgentRuns use the actual Run ID with
`loadCommand`/`expandCommand`, never their placeholder templates.

Every new Run, including planning, Review and continuation, binds an explicit
frozen Snapshot before dispatch. Context reads validate its full identity and
content digest, then read its stored values without rebuilding current Task
records. Synthesis reads the selected Producer results from that Snapshot.
Writable Projects come from the Run's captured effective authority; live
activity is a separate observation, not part of the frozen contract.
Expansion always requires both `store` and `refId`, even for a unique id.

New Task execution requires an initial Snapshot. Missing evidence does not make
a retained Run unreadable: inspection, failure settlement and explicit retirement
remain available to Leader/Operator, and unrelated work can proceed. Submission
and exact frozen-context reads fail locally when that evidence is absent or has
drifted. An explicit ordinary retry creates a new Run and Snapshot from current
authorized facts, without reconstructing the old snapshot; Review and synthesis
reuse still require exact frozen evidence. Subsequent observed/steered input may
omit its own Snapshot because it does not establish a new Assignment.
Storage uses the 1.0 baseline. Missing optional execution evidence remains a
run-scoped condition and does not become a Home-wide blocker.

Operational failures are scoped to their owner, not treated as proof that the
whole Controller must stop. Optional resource reaping and continuation metadata
checks report failures without blocking normal scheduling. Provider retry
admission is isolated per Session; continuation observation is isolated per Task.
Job and Global input errors identify their Task/Job or Role and retain the
original cause. Committed observations stay committed; failed observations do
not acknowledge input, imply quiescence, or authorize another send or deletion.
Use the existing status, stop/cancel, retire, acknowledge and explicit retry
operations for the affected owner. Structural storage corruption, authority
failure and unconfirmed external effects still require diagnosis at their
respective boundaries, not a catch-all default or synthetic successful result.

Current Task reads also expose untargeted user/Operator messages to the Task's
current Worker and Reviewer Sessions, including requirements added after their
Run snapshot was frozen. Use `task message list/show` or Task Context inspect
to read those original records. This does not rewrite the frozen Assignment or
grant delivery authority. Directed messages, other Roles' results and other
Tasks remain outside the caller's scope unless its Assignment authorizes them.

## Dispatch and notification

An explicit dispatch persists execution intent before native submission.
Ordinary Leader wake instead claims a fixed TaskWake/mailbox batch and submits
a notification through the same Host/Endpoint. Confirmed acceptance consumes
only that batch; later input remains pending. A notification requires no final
execution report and does not force steer into a busy native conversation.

Leader-local edits preserve durable events but do not create self-wakes.
Other sources' input remains durable while the Leader is busy or unavailable.
Operator notifications likewise carry TaskEvent/InputRequest read pointers,
not duplicated Task narrative.
Human input, explicit execution entry and activation failure are delivered
promptly through the existing wake mechanism. Worker results retain their
aggregation window. Busy native input still preserves pending messages.

Normal and retry notifications share the same bounded presentation: factual
change labels, attributed optional author summaries, and original read entries.
An author can begin a Message/report with `Yui-Summary: <one line>` (summary
at most 512 UTF-8 bytes). It remains in the original record; no schema migration,
summary store, read-acknowledgement or extra model call is involved. Missing or
oversized summaries fall back to facts without clipping qualifications.
Summaries never grant authority, accept results or mark reviews approved.

### Operator backlog and periodic recovery

Task completion/cancellation/retirement, publication records/adoption and input
requests enqueue Operator attention in the same transaction as their durable
event. Existing Run failure routing keeps its retry and supervisor guards.
The ready mailbox is the incremental recovery source: a lost scheduler signal
or Controller restart does not require a Leader report or a scan of historical
Tasks. The existing periodic pass retries outstanding mailbox work; an unchanged,
settled mailbox creates neither a Message nor a model call.

At most one unsent engineering notice is queued. Further facts coalesce in the
mailbox until that notice is accepted or conclusively not delivered. Each handoff
claims at most 64 source signals and reads exact records, retaining the unclaimed
suffix. Global delivery reads at most 64 pending Messages per Role per pass;
conclusively stale originals retain their nondelivery evidence, with later pages
handled by subsequent passes. Reserved interrupt-then inputs remain discoverable
beyond that ordinary page. FIFO user inputs and unknown-effect fences are not
reordered to make notifications appear healthy. SQL aggregates still inspect
matching stored rows; these bounds limit materialized records and per-pass
delivery work, not the size of the persisted mailbox or database.

A full reconciliation may ask the original Host to republish an already observed
terminal for the exact Session, authority, attempt and native Turn. For a Desktop
direct Turn, that Host must have retained both the exact start and terminal under
the unchanged writer fence; `direct:<nativeTurnId>` and the native Turn are both
required. This bounded latest observation does not make the input client-owned.
During an Inbox persistence failure, the Host additionally retains every
unpersisted original fact, including starts and full terminals, until the
existing Inbox accepts it. Later direct turns must not overwrite those bytes.
This uses the existing Inbox and canonical observer, including the original result.
It does not submit input, query another native client, restart a Host, or infer
quiescence from elapsed time/idle state. Normal terminal processing signals again
after releasing Host occupancy. Unknown acceptance remains isolated unless exact
evidence settles that input. Explicit stop/replacement and external writers remain
hard boundaries. Full Task and Global reconciliation also covers an unsettled
final input with no queued successor. A filesystem repair retries observations,
not native execution; process loss before persistence remains a disclosed gap.

`yui session context <role> --json` includes bounded `backlog` diagnostics: pending
count, oldest timestamp, target and attempt identities, blocking reason and
recovery guidance. Live age is in `backlogObservation`, outside the paged source
digest. `in-flight-or-unobserved-terminal` deliberately does not label a
long-running accepted Turn as stuck. An unavailable/older Host or missing retained
terminal produces one record-only runtime-attention Message per exact attempt;
inspect it through the existing message list/show commands. No recovery Agent,
private timer, migration or new acknowledgement state is introduced. If the
Provider itself never reported a terminal, or the original Host lost its evidence,
automatic reconciliation cannot prove completion: restore the compatible observation
path or explicitly stop/replace only with the required native quiescence evidence.
This change does not backfill arbitrary pre-existing historical events, adopt old
Hosts, or authorize production upgrades/restarts.

Controller restart preserves live Hosts; it does not replace their loaded code.
A supported surviving Host writes raw observations to the immutable Inbox even
while the Controller is down; the restarted Controller applies them under current
Session fences. A frozen Manifest's CLI/storage mismatch is a context-read failure,
not proof that the Host publisher failed: this publisher uses the Inbox/RPC, not
that CLI. An Endpoint checkout generation is not a complete Host build identity.
The runtime-attention evidence distinguishes an unavailable control channel,
rejected control (including implementations without reconciliation), and a missing
exact retained terminal, with reported Endpoint/event-delivery observations.
The status `controlCapabilities` advertisement gates additive v1 commands.
Missing `reconcile-turn` support yields `unsupported` without sending the
invalid request. The original Inbox remains usable; no alternative native
input or guessed terminal is generated. `hostImplementation` identifies code
captured when the Host loaded, not the current install or Endpoint generation.
Compatible build changes do not block exact native Session resume after an
authorized safe release. They never change the user's launch configuration.
Missing delivery diagnostics mean unreported, not healthy. Unsupported live code
cannot be repaired by another Controller restart or guessed adoption; inspect the
original evidence and explicitly authorize any necessary lifecycle recovery.

`task wake show <task> <wake>` now defaults to inputs/results and explicit
references, including older referenced originals. It omits unrelated diagnostic
events and merely started Runs; `--history` restores full fixed-window discovery.
Both views retain the fixed window, deduplication, exact detail commands and
bounded `contentPage` continuations. Read decision-relevant originals in full.

| Evidence | Disposition |
| --- | --- |
| Busy with proven non-acceptance | Preserve input; a new transport attempt may use the same Session |
| Native acceptance | Never resend; wait for the exact terminal if this is an execution |
| Transport write only | Retain transport evidence; do not claim native acceptance |
| Explicit rejection | Retain the original cause and settle the corresponding admission |
| Unknown acceptance/effect | Retain the attempt and conflicting-resource fences; do not replay or switch Session |

Missing receipt after a crash is not proof of non-acceptance. Structured
`SESSION_BUSY` is evidence; text containing “busy” is not a retry contract.

## Continue existing work

```sh
yui task message send <task> "Continue with the clarified requirement" \
  --to <role> --work-item <work-item>
yui task message handoff <task/message> --to <successor-role>
```

Review clarification uses `--review-round` instead of `--work-item`.
Message retains recipient, work association and owner Run. When the Role is
busy, saving returns without interrupting it. Once it becomes available, a
bounded ordered batch can create a continuation Run atomically associated with
those messages. The existing Assignment, effective permissions, workspace and
unfinished files remain; the snapshot adds authorized messages and the preceding
original result. Duplicate terminals cannot assign the messages twice.

Ownership changes, incompatible Sessions, terminal work and obsolete Review
candidates retain visible nondelivery reasons. Explicit handoff only targets an
already-dispatched successor for the same work. Replicated Producer/synthesis
lineage is not silently rewritten by a message.

Rejected Leader notifications retain their original input and failure diagnosis.
Deterministic startup failures do not automatically retry; only typed runtime
contention remains deferred. New messages and a Controller restart do not replay
the rejected claim. After correcting the cause, explicitly retry its exact wake:

```sh
yui task wake show <task> <wake>
yui task wake retry <task> <wake> --reason "<what was corrected>"
```

Retry returns the rejected batch and later queued input to the existing mailbox;
it does not rewrite the old wake as accepted or replace a Session. Current runtime
authority and readiness checks still apply. Model/effort validation rejections show the
native model options and a command to inspect the full current catalog.

Pre-Run launch failures and native Provider rejections both retain a
`runtime.agent-error` fact. Notification delivery references that original error
instead of creating a second copy of the cause. `task event show` supplies the
scoped capability-query pointer in both human and JSON output; `wake show`
links the same fact. An unavailable Leader notifies the existing Operator
channel once; Worker/Reviewer failures use the existing Leader channel. No new
recovery Agent is started, and there need not be a Run or Session to record the
failure.

Failure context records native metadata selectors and the requested model/effort.
Unrecorded configuration stays unavailable; it is never reconstructed from current
Roles. Opaque audit bytes are not read as current configuration.
Reading a failure's model options does not validate Task permissions,
Review state, workspace entries or the current Session bootstrap protocol.
The three failure ingresses retain their native fencing/classification, while
record creation and deduplication share one writer and supervisor notices use
the existing event-routing boundary.

Unknown Leader notifications preserve their wake and input window:

```sh
yui task wake show <task> <wake>
yui task wake resolve <task> <wake> --reason <quiescence-evidence>
```

Resolve releases the claim after native-effect fences are clear. It neither
replays the notification nor invents acceptance or completion. Independent
Role work and legal local facts are not a Task-wide recovery lock.

Wake status records notification delivery, not Message implementation. For
ordinary Leader notifications, `consumed` means native acceptance. Native Turn
completion and Task delivery need their own runtime evidence and durable results.
A rejected wake stays `dispatched` with its claim until explicit retry or Session
replacement; an explicitly released historical wake can remain `dispatched`
without a claim. Unknown acceptance cannot use `wake retry`.
Session replacement preserves queued input for a new wake and current Context;
it does not retroactively mark an old wake accepted. Late receipts cannot settle
the successor's batch. While Session cleanup is pending, new input remains queued.
Inspect the wake, `notification.delivery` events, current mailbox and Session
together; do not require one final response per historical wake.

Current wakes are notification-only. Run completion cannot consume a wake, and
the first notification window starts at Task creation. Retired Run-linked wake
records remain in Task events with their original ID and payload, not as a
second active wake format.

## Input timing: queue, steer and interrupt

Submission intent (`record / discuss / develop`) decides how a requirement is
routed. Input timing decides when an already-authorized input reaches a Role;
it does not activate a Task, expand an Assignment or upgrade planning authority.
Save-only input uses `message send --intent record`; `--wake-policy` is removed.
Unkeyed Draft Message edits preserve submission intent. `record` and `develop`
edits never start planning or create/retry activation; `discuss` edits use the
same activation/planning routing as a discussion submission. A pending or failed
activation therefore keeps the edited discussion waiting.

A Message with a submission key, queue/steer request, or interrupt-then handoff
has immutable content: submit a new Message with a new request ID to change it.
This preserves the original retry comparison and receipt without adding a
second stored representation of input. Updating to the identical body is a
no-op, with no event, queue change or Controller notification. Current stored
user/operator Messages always have an intent; changing that intent also requires
a new explicit submission.
The [authenticated Web controls](architecture/capabilities-and-resources.md#cli-and-web)
use the same three operations as the CLI.

| Action | Effect | What it does not prove |
| --- | --- | --- |
| `queue` | Saves a Message for the recipient's next legal opportunity, idempotently by request ID | Reading Context or accepting delivery is not implementation |
| `steer` | Saves a Message and attempts native steering of the exact current Turn | Unsupported, stale or unconfirmed steering is not a queued continuation |
| `interrupt` | Records a control request and asks the Provider to cancel the exact current Turn | A stop request is not a terminal or proof that background resources stopped |

Inspect the Session before selecting a live target:

```sh
yui task role session inspect <task> <role>
yui task message queue <task> "<continuation>" --request-id <id>
yui task message steer <task> "<correction>" --request-id <id> --to leader --expected-target <turn>
yui task role interrupt <task> <role> --expected-target <turn> --request-id <id> [--then-message <task/message>]
```

Ordinary Leader `queue` input omits `--to`. An explicit `--to <role>` (including
`leader`) addresses an existing Assignment and requires `--work-item` or
`--review-round`; a Message cannot establish that Assignment. `steer` still
requires an explicit Role and exact live target.
Reusing a request ID with different content or a different target
is a conflict. `steer` and `interrupt` never silently retarget, replace a Session,
kill a process or fall back to another action. No live managed Turn yields
`NO_ACTIVE_TURN`; stale targets and unsupported control remain explicit outcomes.

Bare interrupt creates no Message. Optional `--then-message` names an already-saved,
eligible input and reserves its next opportunity only after an exact terminal,
within the original Session/writer boundary. It is not a fourth action or a way
to replay accepted, pending or unknown steering. A conclusive non-delivery can
permit an explicit new control choice when the user's intent authorizes it;
uncertainty cannot.

Global Roles use the same three actions with their own owner and Session,
without inventing a Task or Run. The local-user Web surface exposes them through
the shared Global Role handler. The public CLI exposes
`yui role message queue|steer <role> <text>` and `yui role interrupt <role>`.
Queue/steer require `--request-id`; steer/interrupt require `--expected-target`.
These commands retain the caller's existing Session authority; do not fabricate
a Task/Run or borrow the browser's user authority. Configuration remains under
`config role`, lifecycle under `session`. New controlled Global Sessions use the Host console.
The current controlled Codex Operator and Task Leader can also open a native
TUI view from Web Terminal. Its authenticated loopback relay attaches to the
Host's existing App Server connection and exact Thread. Complete text prompts,
steer and interrupt reuse Host admission and settlement; native server requests
retain their original request/Thread/Turn identity. Configuration overrides and
new/forked Threads are rejected. Web uses the existing terminal writer lease;
other browser windows remain read-only until the writer detaches. Closing this
view does not stop the Host or Provider. Conversation and native history remain
views of the same Provider facts, not a second Task message store.
A live unmanaged Session is not silently adopted; an explicit Session lifecycle
action is needed first.

## Exact results

The native terminal settles only the matching execution. Known native Turn IDs
must match; a serialized stream may use proven local attempt correlation.
Message UUIDs are not native Turn IDs. Unrelated native chat in the same Session
cannot complete the pending Yui request.

The terminal transaction saves one AgentRunResult and a reference Message.
`resultRef: { type: "agent-run-result", runId: "run-12" }` expands the original
report rather than copying it. Candidate and ReviewRound retain provenance;
Core does not derive semantic acceptance from prose.

Cancellation requests do not prove physical quiescence. Exact terminal evidence
preserves partial output and settles the original execution only. Host exit
does not imply shared Provider or descendant processes have stopped.

## Draft planning and activation

`EffectiveLaunchSnapshot.executionAuthority` captures `planning | delivery`.
It is not recalculated from the Task's current lifecycle. Planning permits
local planning facts, not delivery dispatch, candidate adoption, integration or
delivery workspace Jobs.

The initial Draft planning dispatch creates a planning Run and binds only its
initial message batch. Acceptance or an exact terminal consumes that batch;
failure does not repeatedly recreate the same planning execution. Subsequent ordinary
messages in the existing planning Session remain notifications. Operator submit
and direct Task messages both reach that Session. Draft plan/WorkItem edits
preserve execution history; external edits notify the Leader, while its own
planning edits do not create a self-wake.

New Draft Roles use a Task-specific planning directory under
`<YUI_HOME>/runtime/task-runtimes/planning`, separate from durable control data and delivery trees.
A planning Run can use `task activation request` to persist intent and return an
`afterPlanningRun` reference immediately. Its terminal releases the request for
Controller admission; cancelled intent is not resurrected.
The Leader can also request activation during ordinary discussion without an
AgentRun: the Controller adopts its durable intent once the native input is
settled. No synthetic Run or extra user “continue” is required.

For bound Git Projects, `--environment empty` means no additional environment:
the Projects still receive managed worktrees. `scratch` selects a Task-owned
directory. `local` requires a registered local Resource and its grant; a Project
ID is not a local Resource ID.

`task activate` is foreground adoption of an existing request, not an alternative
way to create activation intent. A request-free Draft is rejected before resource
preparation; the command does not invent an environment plan or request ID.

Resource preparation precedes the atomic adoption of Task status and workspace
ownership. A failed adoption records a failed request and notifies the Leader
with durable facts; it does not repeatedly prepare resources on unchanged
failure. The Leader chooses an explicit retry or corrected request. Successful
activation likewise leaves a delivery notification for the Leader.
Activation never mutates the live Session into delivery authority. A changed
launch must pass the existing Session replacement/environment boundary.
Planning authority is a CLI guarantee, not a hostile-code filesystem sandbox.

## Inspection and lifecycle

```sh
yui task run list <task>
yui task run show <task/run> --json
yui task message show <task/message>
yui task role session inspect <task> <role>
yui task execution start <task>
yui task execution stop <task> --force --reason <reason>
```

`task run retire` accepts only `--expected-progress-at` for its progress fence;
the former `--progress-at` alias is removed. Retiring an active Run still requires
its exact progress, Agent/Adapter and, when bound, native Session identity;
the renamed entry does not relax quiescence or retirement authority.

Task execution start/stop controls Task admission, not Task acceptance.
Stop first fences new Yui work, then interrupts each exact owned native input
and confirms its terminal before removing the attachment. This also covers
ordinary Leader notifications without Runs. Unknown native state blocks cleanup;
stopping a proxy alone never proves a shared Turn ended. Start preserves durable
progress and admits new input after the old occupancy is settled.
Draft planning can be paused/resumed, and a failed planning Run retries with
planning authority. An authorized user/Operator can stop an idle Draft Session
through `task role session stop`; it need not activate the Task merely to recover.
`task role session new <task> <role> --reason <reason>` persists an explicit
replacement request. Reuse is a preference, not a requirement to prove the old
conversation unrecoverable. The request is legal while an AgentRun is active,
the Session is ended, or previous cleanup is pending. A Leader may also request
its own replacement and end its current turn.

For a Draft Leader whose planning Run has already ended, the replacement
initialization notification admits the selected fresh Session after confirmed
cleanup. It does not create another business Run, activate the Task, or adopt a
delivery workspace: the successor retains planning-only authority and reads
current Task context and retained inbox originals before handling them. Ordinary
Draft notifications and unscoped native hooks cannot use this admission.
A rejected startup retains the notification for explicit `task wake retry`
after correction, or another legal Session replacement; unknown input acceptance
never becomes permission to replay.

`task role session stop` can also stop a running Role without first changing
its Run status. It retains the native conversation for possible reuse. Pending
Messages remain intent and may start a continuation after the stop; use Task
execution stop when the whole Task must remain paused. For self-replacement,
use the asynchronous `session new` request rather than a synchronous self-stop.

The existing runtime cleanup path stops the exact native execution, closes this
Role's remaining engineering attempts as cancelled, retains Session/Run history
and workspaces, and selects a fresh conversation. Other Roles and Task acceptance
remain unchanged. The Leader receives a new context notification; it decides
which Worker/Reviewer attempts to retry. Pending input references survive the
replacement, including records older than the new notification's time window.

An absent Host does not remove the recovery entry point. Codex can be inspected
and interrupted through a disposable native control connection without starting
a model. Dedicated Claude process custody is persisted independently of the
Host. Real unconfirmed execution still prevents conflicting resource reuse;
cleanup failure is a durable diagnostic routed to the supervisor, not a reason
to invent acceptance or delete the Task. A preallocated ID alone is not proof
a conversation exists.
Codex may retain `systemError` after a failed native Turn. That label alone
neither proves activity nor authorizes cleanup: Yui checks the latest native
Turn's terminal metadata and drains background execution before replacing the
Session. Unknown or still-running native work remains protected.

Released Leaders retain scoped diagnostic reads of their own Task and context,
but cannot mutate it or read another Task. Operator diagnostics and Controller
restart do not first require a healthy Controller; explicit restart can stop
only the exact same-Home process using PID/start identity when RPC is unavailable.
Operator storage diagnosis/upgrade also reaches the dedicated migration entry
without first requiring the Home to already have the target storage version.
Completion, cancellation and archive have distinct authority and resource
boundaries. Storage changes use the single [upgrade contract](sqlite-control-plane-design.md).
