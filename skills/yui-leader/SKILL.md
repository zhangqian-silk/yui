---
name: yui-leader
description: Lead one Yui Task through authorized planning, activation handoff, execution and acceptance, choosing responsibilities and a useful stopping point from its current stage and user intent.
---

# Yui Leader

Follow [yui-runtime](../yui-runtime/SKILL.md) first. Load the exact Context Pack
for an explicitly dispatched AgentRun; for direct conversation or a Task
notification, read current Task context through the Manifest's Session CLI.
No self-dispatch or old completed Run is needed. Read the actual Task
requirements, current Brief and relevant user/Operator Messages, not just
their summaries. Resolve links relative to the file containing them.

## Select the applicable stage

Use current lifecycle, latest intent and the Session's actual planning/delivery
authority together. Draft existence, accepted planning history, Session
authority and AgentRun status are different facts. A completed planning Run
does not complete or activate a Task; an active Task does not upgrade an old
planning Session. Never infer authority from a directory, launch text,
transcript or process.

Apply terminal/gate and read-only intent boundaries before selecting delivery
or planning work; the routes below do not override those restrictions.

- **Draft or planning-only authority:** read [Planning and activation handoff](references/planning.md).
  Discuss and preserve the requested outcome; do not load execution procedures
  merely to finish a discussion.
- **Active, execution enabled, delivery authority and implementation intent:**
  read [Active execution](references/execution.md). Advance existing authorized
  work, including disposition of new results, without asking for another
  “continue” after a valid activation handoff.
- **Query, analysis or discussion only:** answer within the requested scope,
  even on an active Task. Do not turn it into edits or dispatch. A result
  notification is different: read its original results and advance the
  outstanding authorized requirement.
- **Completed, cancelled, retired or archived, or execution gate disabled:**
  explain/query authorized facts only unless a specific further action has
  been authorized and is legal. A conversation does not reopen, reactivate or
  resume execution. If new implementation is requested, identify the needed
  lifecycle/authority action for the Operator; do not manufacture a Run.

These are instruction routes, not new lifecycle states or a scheduling
protocol. Where facts disagree or authority is missing, preserve intent and
report the exact boundary rather than choosing a more permissive route.

## Maintain useful durable context

The DB Brief is the current summary, not a full plan or a history of messages.
After meaningful progress, use `task brief update` with only intended fields;
read `task event list` before deliberately restoring an older value. Keep
references to substantial plans, prototypes and reports in that summary.
Decisions contain the actual decision, reason and necessary boundaries, not
the entire proposal. Label recommendations as recommendations, not user
decisions.

Use the Task's currently supported result storage for full deliverables,
separate from Project delivery workspaces. Saving planning results does not
activate the Task or grant Project write authority. Inspect the available
interface before naming a command or path; a proposed storage interface is
not an executable capability. Do not create a parallel store or duplicate
full documents into Brief/Decision to work around an unavailable interface.
Preserve existing result references and record the bounded integration need.

Add a Milestone only for an independently meaningful outcome, a Message only
for a new conclusion another reader needs, and Project Knowledge only for a
stable cross-Task lesson. Do not create records for every exchange, dispatch,
heartbeat or unchanged wait. Ordinary fact edits need no self-wake.

## Close the current turn

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
