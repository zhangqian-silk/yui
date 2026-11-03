# Planning and activation handoff

Use this for Draft discussion, planning-only Sessions and the boundary into
delivery. The [Leader entry](../SKILL.md) owns shared context maintenance and
turn reporting; [Runtime](../../yui-runtime/SKILL.md) owns authority.

## Discuss and preserve the outcome

If the user asked only to create/store a Task, preserve the requirements and
stop: do not start a planning Session. Once discussion is authorized, clarify
requirements, inspect authorized current facts, compare options and revise the
technical approach as the conversation develops. Distinguish unresolved
questions, recommendations and accepted decisions.

Planning can include research explicitly authorized by the user and permitted
by the Session, Project and resource boundaries. Discussion is not delivery
authorization: do not modify Project code or run implementation tests merely
to support a proposal. Subject to Runtime's read-only intent boundary, keep
authorized planning results in supported Task result storage and maintain the
Brief's current summary and references. A read-only analysis returns its result
in the response, not planning storage. Planning storage and Project delivery
workspaces have different purposes and authority.

Saving a useful revision, reporting what changed and waiting for feedback is
the normal end of a discussion. Do not create implementation WorkItems,
dispatch, Review, acceptance or Task completion to make a planning turn look
finished. An InputRequest is not required for ordinary continued discussion.

## Hand off only through authorized activation

User/Operator submissions use `--intent record|discuss|develop` on
`operator submit` or an unaddressed `task message send`. The default is
`discuss`; Core does not infer intent from message text.

- `record` saves the message without waking the Leader.
- `discuss` on an unplanned Draft records the planning route and wakes planning.
- `develop` on an unplanned Draft saves the requirement and activation intent,
  then enters delivery through formal activation, without first starting planning.
- `develop` after planning has been entered saves the input but does not wake
  or activate; the routing result is `planned-needs-manual-activation`.

Read the returned routing/feedback and current context before taking the next
action. Active submissions do not downgrade or reactivate the Task; ordinary
terminal-Task submissions are refused, not saved for later execution or used to
reopen it. A stopped execution gate is not permission to
resume. `--request-id <key>` on submissions preserves the original result on a
matching retry, not permission to replay uncertain work or change its content.
For expressly requested continuation of a completed result, use the existing
[authorized reopen and submission path](../../yui-runtime/references/completed-followup.md),
not Draft activation or an implicit transition inferred from `--intent develop`.

Once planning has been entered, starting delivery requires a distinct,
explicit activation authorization. A development remark during discussion,
the end or failure of a planning Run, or Session replacement is not that
action and does not restore “blank Draft” status. Accepted planning routing
and historical Runs/Sessions count even when no Session is currently busy.
“Manual activation” means an explicit user action, not that the user must type
CLI commands: an authorized Operator can perform the mechanical operation.

With that authorization, inspect any existing activation request before creating
one with `task activation request <task-id> --request-id <id> --environment <plan>
--source-message <message-id>`. If the new authorization arrived directly in
the native conversation and has no saved Message, use `--source-text` with the
exact user input instead. Core records this as caller-attributed source text in
the immutable activation event, not a new Message or another delivery. Never
substitute a Brief paraphrase, fabricate user authorship, or resend the input.
Keep the same source and request ID on retries. Read the returned source event
when diagnosing a mismatch. Update Brief with the new intent and source refs
before ending the planning turn; do not rewrite old user messages.
Choose the plan from the authorized resources; retain the request id for retries.
The Controller adopts an eligible request. `task activate <task-id>` is the
foreground adoption operation for an existing request, not a request-free shortcut.
A planning Session requests activation and finishes its turn; it must not
synchronously wait for its own native turn to become quiescent.

Inspect the observable result. Preserve a busy or unknown
operation's exact request and follow
[Runtime recovery](../../yui-runtime/references/recovery.md); do not
self-dispatch, interrupt, kill or replace a Session to bypass the handoff.
New discussion during a pending handoff does not authorize a competing
planning Session. A failure calls for an explicit diagnosis and authorized
recovery, not automatic downgrade or replay.

Continue the durable requirements once the Task is formally active and a
delivery-authorized Session/workspace is ready. Do not demand another
“continue.” An old planning Session remains planning-scoped: preserve its
successor context and end its turn rather than promoting itself.

Before saving or citing a Task artifact, read [Task artifact operations](artifacts.md).
