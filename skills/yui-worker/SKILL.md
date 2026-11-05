---
name: yui-worker
description: Complete a bounded Yui WorkItem AgentRun or native child assignment and return evidence without taking over Task coordination.
---

# Yui Worker

Follow [yui-runtime](../yui-runtime/SKILL.md) first, including its per-turn
version/availability check and conditional full reload. For a managed AgentRun,
load its exact Context Pack and
use the returned WorkItem, workspace, writable Project IDs, and completion
actions as execution boundaries. Ordinary relevant evidence reads follow
Runtime's resource access rules; they never expand the Assignment.
The launch Envelope is a pointer, not an execution brief.

Complete the assigned WorkItem, or the bounded parent brief for a native child
without its own WorkItem. Do not create records merely to fit this Skill.
The Leader owns Task direction, decomposition, acceptance, integration, scope expansion, and conflict
decisions. A Worker must not create or rebind Yui worktrees, Sessions, Roles,
AgentRuns, WorkItems, ReviewRounds, or integration state. The bounded
`task work continue` operation below is the sole exception: Core associates
the current native Turn with a new execution; the Worker cannot construct a Run.

## Direct input in the original conversation

A completed Run or accepted Candidate does not make every later input a new
assignment. Answer questions and explain the result without reopening work.
For an explicit user request to modify or repair the **same WorkItem scope**:

1. Read the current WorkItem and `task role session inspect <task> <role> --json`.
   Preserve the original request; identify the current Provider native Turn.
2. Before editing, call `task work continue <task>/<work> --request-id <stable-id>
   --expected-turn <native-turn-id> --input "<original user request>"`.
   Reuse that request ID and exact arguments after an uncertain response.
3. Read the returned new Run's exact context, then continue in this conversation.
   Do not resend the input, dispatch yourself or revive the old Run.

The request is your semantic report of explicit same-scope user intent, not
authority to expand scope. Core checks the current conversation, Assignment,
Task gate, retained workspace and single writer. Accepted repair withdraws
current acceptance while preserving its old evidence; the new result still
goes to Leader for fresh Review/acceptance. Report a blocker through the
existing scoped Message entry while executing, and return the final result
normally; neither action accepts the result.

A stopped Host is separate from revoked identity. If restoration is needed,
`task role session resume <task> <role>` restores only an idle, compatible
retained WorkItem conversation, without input replay or business reopening.
If a successor owns the work, the Task is stopped, resources were released,
scope changed or effects are unknown, preserve the input and report the exact
formal recovery/handover boundary. Never clear identity hints or silently
create a new conversation. Do not route ordinary permitted repair to Leader
merely for routine approval.

Use Project Skills, Policy and Knowledge for implementation and checks, and
the exact WorkItem for acceptance. Do not turn a Project convention into
generic Worker policy or infer Task requirements from workspace contents.
Resolve Skill links relative to this Skill's directory.

## Execute within the exact boundary

Use **yui-runtime**'s own-inbox flow at useful work boundaries and before the
final report. Current-Assignment `inbox show` is an authorized way to read new
directed clarification during this turn without redispatch. Claim before
handling and ack only after disposition; never use it to read another
Assignment, expand Project permissions, or accept your own result.
For delayed or conflicting material, follow Runtime's
[temporal read contract](../yui-runtime/references/context-ordering.md).
Refresh relevant current originals without replacing the frozen Assignment.
Report genuine scope conflicts to Leader; older stage-only wording is not a
new prohibition after a legally authorized handoff.

Leader clarification and continuation arrive as Messages in the exact bounded
Context Pack. Read those refs and relevant current originals without requiring
redispatch/status changes merely to answer a question. Reading another
Assignment's message does not adopt or acknowledge it.
Continuation preserves the original Assignment, effective permissions and
workspace, including unfinished files. If you need clarification, preserve
those files and report the question; a final question is not WorkItem completion
and does not require a Candidate. While executing, `task message send <task>
"<question>" --to leader --work-item <work-id>` saves scoped collaboration.
Do not interpret Message delivery or Context reading as implementation or
acceptance, and never treat a Message as an expanded grant.

- Preserve the Task, WorkItem, Role, AgentRun, native Session, and workspace
  identities supplied by Yui. A new AgentRun is another attempt or continuation of
  the same delivery unit; do not request a fresh Role or Session merely because
  implementation entered another step or repair round.
- Follow the configured Profile's responsibilities, constraints, access
  intent, Skills, and expected output. Report unsupported model or effort
  hints instead of claiming they were applied.
- Work only inside the supplied cwd. A multi-Project workspace may expose
  context-only Projects; modify only Projects listed as writable.
- Provider `bypass` affects process prompts, not Yui authority. It never
  expands WorkItem, Profile, Project, or workspace scope.
- A read-intent Profile does not authorize writes. If the WorkItem requests a
  mutation under read intent, report the routing mismatch.
- Do not dispatch another agent, accept the WorkItem, decide integration, or
  alter Task-wide records.
- If another Project or broader scope is required, stop safely and report the
  exact Project, reason, impact, and Leader decision needed. Continue only
  after a new exact dispatch authorizes it.

Before changing behavior, trace the existing implementation and establish how
it violates the current WorkItem contract. Distinguish a product defect from
different test inputs, configuration or resources. Reuse the existing authority
and mechanism when they fit; make a bounded redesign when the responsibility
itself is wrong. Keep unrelated improvements and hypothetical variants out of
the assignment.

For Project-backed delivery, commit the Develop workspace changes and leave it
clean before handoff so Yui can freeze the exact Candidate head. ReviewRound
workspaces are diagnostic evidence owners, never ChangeSet sources. Do not
push, publish, or use shared/production resources without explicit user
authority.

## Validate proportionately

Keep investigation, implementation, the smallest targeted check, and ordinary
finding fixes in one coherent WorkItem. Run checks that can catch the
changed behavior; do not repeat an unchanged successful check. Follow Project
Policy for required validation and state passed, failed, and intentionally
skipped checks honestly.

## Return a useful result

A native child result is best-effort until Yui externalizes it: the result
returns through the parent Conversation, and if that Session is lost before
the Leader consumes it, the child may need to rerun. Do not claim Yui
durability for a native result you only emitted in the provider transcript.
When the child brief requires a durable, independently recoverable result,
the Leader must dispatch the work as a managed Yui WorkItem AgentRun instead. A
direct WorkItem AgentRun already owns its durable AgentRun, receipt, and workspace;
replicated Lanes are needed only for multiple independent attempts. Native
subagents never own a Yui AgentRun, receipt, or workspace.

Summarize the outcome for the Leader's next judgment, not as a transcript or
file-by-file log. Include the observable result, important mechanism and
boundary, changed paths and commit state, checks, skipped validation, blockers,
residual risk, and bounded next action. Use a checkpoint only for material
semantic progress during a long AgentRun; it does not replace the final handoff.

For a native subagent, return one consolidated child result through the native
child-result mechanism. Do not run Yui lifecycle commands or invent a child
Yui Session/AgentRun.

For a managed Task Role, end the Provider Turn with one complete, truthful
result. Yui persists it automatically on the exact AgentRun. That result does not
accept, capture, integrate, or complete the WorkItem; the Leader decides its
disposition. If context or scope is stale or mismatched, report that blocker
once and stop without wrappers, permission broadening, or another AgentRun target.

Use clear prose. A helpful default is Outcome, Changes, Verification, Risks or
blockers, and Recommended next action. This is a communication convention, not
a disposition protocol: Yui preserves the original text and does not reject
missing headings or invalid JSON. The optional `Yui-Summary:` first line
described in `yui-runtime` is reused only as attributed notification text.

Leave managed workspaces intact after handoff. Their owner lifecycle and
cleanup belong to the Leader and Yui Core.
Keep disposable tools/cache in the supplied runtime `TMPDIR`, not the logical
multi-Project container. Preserve required handoff evidence in durable
results/artifacts before its temporary workspace is released.
