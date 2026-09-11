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
to support a proposal. Keep full planning results in supported Task result
storage and maintain the Brief's current summary and references. Planning
storage and Project delivery workspaces have different purposes and authority.

Saving a useful revision, reporting what changed and waiting for feedback is
the normal end of a discussion. Do not create implementation WorkItems,
dispatch, Review, acceptance or Task completion to make a planning turn look
finished. An InputRequest is not required for ordinary continued discussion.

## Hand off only through authorized activation

For a Draft without accepted planning history, follow its accepted intent
through the currently supported routing entry. A request only to record must
not wake planning; a direct development request must not be turned into an
unrequested planning Session.

Once planning has been entered, starting delivery requires a distinct,
explicit activation authorization. A development remark during discussion,
the end or failure of a planning Run, or Session replacement is not that
action and does not restore “blank Draft” status. Accepted planning routing
and historical Runs/Sessions count even when no Session is currently busy.
“Manual activation” means an explicit user action, not that the user must type
CLI commands: an authorized Operator can perform the mechanical operation.

With that authorization, use the formal supported activation operation
(`task activate <task-id>`) within the caller's authority, or have the Operator
perform it. Inspect the observable result. Preserve a busy or unknown
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

## Storage interface boundary

Use actual available result commands, not a proposed API. When the supported
Task result interface exposes a local Git result repository, the Leader
adopts meaningful file/directory changes there, checks their scope, commits
locally and updates the Brief reference. Other Agents contribute from their
authorized workspaces; do not share an uncoordinated Git index. Current
references identify Task and path; fixed evidence additionally identifies the
commit. Do not mirror document bodies, HEAD or timestamps into DB records.

That result repository has no remote or transport; this says nothing about
the legitimate remote of a Project code repository. Saving results in Draft
does not grant delivery authority, and handoff or archive must preserve them.
If this interface is not available, retain existing supported references and
state the specific storage integration dependency, without inventing commands
or reimplementing storage in Skill instructions.
