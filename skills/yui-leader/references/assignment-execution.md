# Assignment execution and input timing

Read before creating/acting on an Assignment or sending its continuation/control.
Ordinary direct implementation does not require this manual or the other
[execution operations](execution.md).

### Choose input timing without changing intent

Submission intent (`record`, `discuss`, `develop`) and delivery timing are
different facts. Input controls do not activate a Task, expand an Assignment,
or elevate a planning Session. Keep the submission contract when using `send`;
choose queue, steer or interrupt from the user's intent and current facts:

```sh
yui task message queue <task> "<continuation>" --request-id <id> --to <role> --work-item <work-id>
yui task message steer <task> "<current-turn correction>" --request-id <id> --to leader --expected-target <turn>
yui task role interrupt <task> <role> --expected-target <turn> [--then-message <task/message>] [--request-id <id>]
```

Queue waits for the next legal opportunity. Steer addresses only the exact
current native Turn; Worker/Reviewer steer also needs its existing WorkItem or
ReviewRound. Bare interrupt stores a control request, not a new Message.
`interrupt-requested` is not a terminal or proof that background resources
stopped. Then names an already-saved input and reserves its next opportunity
only within the original Session/writer boundary.

Read `task role session inspect` first. Unsupported and proven-unsubmitted
steer may be composed with interrupt when the user's intent permits stopping;
accepted, pending or unknown steer must not be resent through another action
or request id. Never silently cancel, replace a Session or downgrade to queue.

Global inputs use `role message queue|steer <role>` and `role interrupt <role>`
with their own owner, not a fabricated Task/Run. See
[Runtime](../../yui-runtime/SKILL.md) for scope and controlled-console boundaries.

Managed dispatch freezes the Assignment for its assignee. For ordinary
clarification, feedback or a continuation of that same work, send a Message:

```sh
yui task message send <task> "<clarification or continuation>" --to <role> --work-item <work-id>
yui task message send <task> "<review clarification>" --to <role> --review-round <round-id>
```

Busy execution queues the Message. Its terminal triggers continuation in the
same compatible Session and workspace; do not fabricate a failure, submit an
unfinished Candidate, or change WorkItem status merely to answer a question.
Read Message delivery and the exact resulting AgentRun separately from business
acceptance. A Message never expands scope, applies desired configuration, or
changes a Review's frozen candidate. An ownership change preserves the original
recipient; transfer still-pending input only with explicit `task message handoff`.
Late input to terminal work or an obsolete Review remains visible with a bounded
nondelivery reason. Use the existing formal operation for new scope or Review.

For unknown delivery or Session replacement, read
[runtime recovery](../../yui-runtime/references/recovery.md). Preserve the original
input; do not replay uncertainty or treat it as a global Task lock.

### Leader-owned WorkItem

Use this only when the result merits separate management/acceptance. Omit
`--role` for direct execution: the Leader owns coordination and performs the
work without a managed executor Assignment. `--role leader` instead selects the
Leader Role as a **managed AgentRun executor**; it is not how to label direct
ownership. Do not self-dispatch merely to gain execution authority.

For a writable Project result, create and inspect its WorkItem-owned workspace
before editing. The Leader can work there directly; isolation does not require a
Worker. Task main, WorkItem Develop, and Review workspaces remain distinct owners.

```sh
yui task work create <task> "<separately accepted result>" \
  --project <project> --objective "<outcome>" --accept "<criterion>"
yui task work isolate <work-id>
yui task work update <work-id> running
# Implement and verify in the returned WorkItem workspace; commit and leave it clean.
yui task work update <work-id> done --summary "<result and evidence>"
```

`done` freezes a direct Candidate, not an AgentRun result or acceptance.
Inspect it, then integrate the exact isolated result before acceptance:

```sh
yui task integration start <task> --work-item <work-id> \
  --project <project> --strategy <ff|cherry-pick|merge|manual>
# Inspect the attempt and finish it through Integration's normal checks/continuation.
yui task work accept <work-id> --summary "<decision and evidence>"
```

Read [Integration](integration.md) for checks, continuation, and recovery.
Keep the same unit through ordinary fixes.
A read-only or Gitless result with no writable Projects needs no Git isolation;
submit its actual evidence and accept it explicitly. Existing exact Task-final
metadata-only Candidates retain their contract; do not establish a special Review
contract merely to avoid the ordinary writable WorkItem isolation boundary.

For a native child, pass a bounded brief and applicable Profile constraints
through the provider's child tools. A small investigation needs no synthetic
WorkItem. If the child implements an existing Leader-owned WorkItem, keep that
WorkItem roleless, supply its exact workspace and scope, and mark it running.
Native children inherit only current parent authority and gain no Yui Role,
AgentRun, Session or broader workspace. Their
results are best-effort until Yui externalizes them; use a managed Task Role
when independent durability matters. Inspect the returned result before
submitting `done` or recording failure progress. `done` creates a Candidate;
`work accept` records the separate acceptance. WorkItem responsibility remains
open through execution failure and becomes accepted only on that decision.
A Profile's runtime source applies when
materializing a Task Role, not when launching a native child. The child
inherits the Leader Agent; apply a Profile model or effort only when the native
tool actually supports and confirms that override.

### Managed Task Role

```sh
yui task role add <task-id> <role> --profile <profile>
yui task role show <task-id> <role>
yui task work create <task-id> "<outcome>" --role <role> \
  --project <project> --objective "<bounded outcome>" --accept "<criterion>"
yui task work dispatch <work-id> --input "<decision-complete brief>"
```

Add `--after` only for a real dependency. Likely file overlap is not by itself
a dependency. A Worker may read the complete authorized Task context but may
write only its WorkItem Projects and workspace. Dispatch prepares that isolated
workspace and freezes the Assignment; inspect the completed original AgentRun
result before submitting its exact Candidate, integrating, and accepting.

Profiles carry portable behavior plus either a dynamic Global Worker runtime
source or an explicit Agent with optional model and effort. Applying a Profile
to a Task Role resolves and freezes the complete binding; later Profile or
Global Worker changes do not rewrite that Role. Before dispatch, use
`config profile show` and `task role show` to read the exact behavior, Agent, model,
effort, Profile, and workspace. Do not reconstruct or guess launch
configuration. Use the WorkItem assignee directly unless replicated execution
was deliberately selected.

Managed Task main, WorkItem, ReviewRound, and Integration workspaces have
different owners. Never edit stable Project checkouts, managed refs, Yui state
files, or another owner's workspace. A Task's recorded base is durable; do not
silently replace it merely because its remote branch later moves.
