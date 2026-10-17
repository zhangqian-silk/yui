---
name: yui-leader
description: Lead one Yui Task through authorized planning, activation handoff, execution, acceptance and same-result follow-up, including reopening its completed, unarchived result for an explicit implementation or delivery request.
---

# Yui Leader

Follow [yui-runtime](../yui-runtime/SKILL.md) first, including its lightweight
`yui session skills --json` check at the start of every turn and full reload when
versions change or context is missing/recovered. Load the exact Context Pack
for an explicitly dispatched AgentRun; for direct conversation or a Task
notification, read current Task context using `yui task context <task-id> --json`.
No self-dispatch or old completed Run is needed. Read the actual Task
requirements, current Brief and relevant user/Operator Messages, not just
their summaries. Resolve links relative to the file containing them.

Current Context is a bounded working set, not all Task history. Use
`task context list <task> --store <store>` or a domain list for discovery,
then an exact detail read. A wake contains attributed change summaries and
original Message/Run pointers, not complete reports. Follow `yui-runtime`'s
`nextCursor` and `contentPage` rules: read the complete focused wake view and
relevant originals before disposition; use `wake show --history` only when
window history/diagnostics matter. Summaries never decide completion.

Before WorkItem dispatch, put the complete bounded requirements in the WorkItem
or explicitly select up to 16 relevant readable materials with repeated
`--context-ref <store/refId@digest>` on `task work dispatch`. Obtain exact IDs and
digests from current Task context list/inspect. Core freezes these selected
values after the existing caller-scope checks; mentioning a record in `--input`
does not select it or grant access. Missing, forbidden or changed references
refuse dispatch before Provider startup: correct the selection or make the
WorkItem self-contained, never ask the recipient to bypass expansion rejection.

## Select the applicable stage

Use current lifecycle, latest intent and the Session's actual planning/delivery
authority together. Draft existence, accepted planning history, Session
authority and AgentRun status are different facts. A completed planning Run
does not complete or activate a Task; an active Task does not upgrade an old
planning Session. Never infer authority from a directory, launch text,
transcript or process.

Apply terminal/gate and read-only intent boundaries before selecting delivery
or planning work; the routes below do not override those restrictions.
When old discussion text differs from new intent, apply
[current intent and temporal reads](../yui-runtime/references/context-ordering.md):
inspect exact sources before treating normal stage progression as a conflict.
An adopted same-scope development request supersedes the earlier discussion-only
stage, not independent restrictions. Never use active status or Brief alone.

- **Draft or planning-only authority:** read [Planning and activation handoff](references/planning.md).
  Use the recorded submission intent (`record`, `discuss`, `develop`) and
  routing result, not keywords in the message. Discuss and preserve the
  requested outcome; do not load execution procedures merely to finish a
  discussion.
- **Active, execution enabled, delivery authority and implementation intent:**
  read [Active execution](references/execution.md). Advance existing authorized
  work, including disposition of new results, without asking for another
  “continue” after a valid activation handoff.
- **Query, analysis or discussion only:** answer within the requested scope,
  even on an active Task. Do not turn it into edits or dispatch. A result
  notification is different: read its original results and advance the
  outstanding authorized requirement.
- **Completed, unarchived, explicit same-result implementation or delivery request:**
  the current matching Leader may call `task reopen <task-id>` for its own Task,
  then continue that bounded request without a mandatory Operator handoff or
  another “reopen” confirmation. Read the
  [post-completion routing boundary](../yui-runtime/references/publication.md#post-completion-routing-boundary)
  first, inspect the reopen result, and reassess current Session/workspace
  authority and the execution gate before delivery. Reopening is lifecycle
  management, not a planning Session's promotion to delivery.
- **Cancelled/retired, archived, execution gate disabled, or no new execution authority:**
  explain/query authorized facts only unless a specific further action is
  authorized and legal. The Leader cannot restore cancelled/retired intent;
  archived Tasks cannot reopen. An independent stop needs its separately
  authorized start/cleanup path; reopen does not lift it. Queries, discussion,
  ordinary notifications and Session recovery do not authorize reopening or
  resumption. Identify a genuinely missing lifecycle/authority action for the
  Operator; do not manufacture a Run or reopen merely to obtain authority.
  Publication recording/adoption is not a way to start terminal-Task execution.

These are instruction routes, not new lifecycle states or a scheduling
protocol. Where facts disagree or authority is missing, preserve intent and
report the exact boundary rather than choosing a more permissive route.

A `task-reopened` notification can arrive before its follow-up Message. Read the
prior completion and current Messages; if only lifecycle changed, wait for the
new request. Do not rerun accepted work, infer external authority, or immediately
complete again. Once the scoped request arrives, continue it in this Task without
asking for another “continue”; preserve the original acceptance evidence.

Handle a failed Worker/Reviewer launch through the shared
[configuration recovery guidance](../yui-runtime/references/recovery.md#configuration-and-model-name-failures).
Read its original failure and scoped metadata before choosing a correction;
the failed target need not be running for you to act.

## Maintain useful durable context

Apply **yui-runtime**'s own-inbox flow before acceptance or completion and at
useful work boundaries. A Leader inbox contains its exact notification windows
and messages for its current managed Assignment, not every Task Message.
For a window, read its full focused wake and relevant originals; for an
Assignment message, read its complete original. Dispose of results explicitly,
then ack the exact entry. Inbox acknowledgement
never accepts a Candidate or completes the Task.

The DB Brief is the current summary, not a full plan or a history of messages.
After meaningful progress, read `task brief show` and use
`task brief update --if-current <writeGuard>` with only intended fields;
read `task event list` before deliberately restoring an older value. Keep
references to substantial plans, prototypes and reports in that summary.
When a delivered correction resolves a recorded blocker or changes the next
action, update the Brief's focus and Leader summary while the Task is still
open. Before completing a Task, reread its Brief: if it still describes a
resolved blocker, superseded plan, or waiting state, correct those fields
before `task complete`. The completion summary is the terminal conclusion;
do not copy it into Brief merely to create a second completion record. Brief
maintenance is not a new completion gate, and routine unchanged steps do not
need an update.
Also reconcile the summary at requirement changes and phase handoffs; carry the
exact activation/input references. Core projects current lifecycle and source
diagnostics without rewriting historical messages. A stale-guard rejection
requires reading the new input and reconciling, not retrying the old text.
Decisions contain the actual decision, reason and necessary boundaries, not
the entire proposal. Label recommendations as recommendations, not user
decisions.

Save full deliverables as files in the Task's local Git artifact repository,
not in Brief/Decision or a parallel store. Use `task artifact save` or
`artifact.save`; read [Task artifact operations](references/planning.md#task-artifact-operations)
before saving or citing results in any stage. A save commits one selected
path and returns `taskId + commit + relativePath` for fixed evidence. Update
the Brief reference after a meaningful saved revision; keep the document
body, HEAD and timestamps out of DB mirrors. Saving a planning result neither
activates the Task nor grants Project write authority. Artifact scripts and
HTML are data, not permission to execute or preview them.

Add a Milestone only for an independently meaningful outcome, a Message only
for a new conclusion another reader needs, and Project Knowledge only for a
stable cross-Task lesson. Do not create records for every exchange, dispatch,
heartbeat or unchanged wait. Ordinary fact edits need no self-wake.

## Close the current turn

### Adjust Project delivery scope without erasing work

When explicit user intent or an original delegation allows a Project to leave
the final delivery, read that original Message and `task remote-delivery`.
Record the bounded decision with
`task project delivery <task> <project-id> --requirement excluded --reason <reason>
--source-message <message-id> --purpose <verbatim-authorization>
--if-current <scopeDecision.id|none>`.
Interpret whether the original really authorizes this scope change; a matching
quote alone is not semantic permission. Do not exclude a Project to conceal an
unmet commitment. Ask only for a genuinely missing scope decision, not a second
approval when existing user intent or delegated judgment already covers it.
Use the same operation with `--requirement required` and the latest decision ID
to restore normal checks. Reconcile a stale guard instead of overwriting newer
intent. These append-only decisions also work on completed, unarchived Tasks
without reopening, rewriting acceptance, or rerunning work.

Unchanged Projects need no exclusion. Required changed/unknown Projects still
need exact verified delivery. Excluded Projects retain their binding, code
changes and Publication facts and are not counted as merged or verified merely
because they are excluded. Scope is not execution, write, archive or deletion
authority: open commitments and unknown execution still need settlement, and
unique commits or dirty resources remain protected. With separate archive
authorization, use ordinary archive/preflight and report retained resources;
do not recommend force merely because an authorized Project is excluded.

For external delivery, choose any available authorized CLI/API and follow
[Publication evidence](../yui-runtime/references/publication.md). Record exact
tool observations through `publication verify --observation`; gh/glab are optional
adapters, not mandatory trusted brands. Do not repeat a sufficient exact
verification merely to use a different tool. Tool inspection is your judgment;
candidate acceptance, immutable evidence and ordinary archive safety still apply.

- **Planning:** save meaningful revisions, summarize the discussion and await
  feedback. This is a complete turn; it needs no WorkItem, Review, InputRequest
  or Task completion just to stop.
- **Active delivery:** apply the result-disposition and close instructions in
  [Active execution](references/execution.md). Continue within authorization,
  complete only when acceptance is satisfied, or wait for a real durable
  event. Ask only for a genuinely missing user choice, authority or external
  fact; routine engineering coordination is not a user decision.
- **Queries and terminal stages:** answer the bounded question and stop
  without starting work or recording fictitious lifecycle progress.

Every explicitly dispatched managed AgentRun returns one truthful original
final report under Runtime's contract, including a planning Run whose result
is a saved proposal awaiting feedback. Ordinary chat and notifications are
not implicit assignments and need no separate execution report. Run terminal,
result acceptance, Task completion, remote delivery and user-authorized
archive are distinct facts. Do not poll managed Roles or emit unchanged
waiting Messages; future durable events supply the next notification.
