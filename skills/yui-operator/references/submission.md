# Submit intent without starting unrequested work

Read before creating/submitting a Task request or requesting Draft activation.
A routing operation is not implementation or resumption by the Task Leader.

Treat Task creation and Task submission as separate user-authorized actions.
When the user asks only to add, create, register, or record a Task, create the
Draft and write all known requirements into its metadata, then stop. Do not
submit a `discuss` or `develop` Message, request activation, start a Leader
Session, or create execution resources. A detailed or immediately actionable
requirement, or the user's desire for its eventual completion, is not permission
to start it. Report that the Task is a Draft and has not started, and explain
that the user can explicitly ask to discuss/plan it or to develop/implement it.

Start the corresponding route only when the user's current request contains
that additional intent: discussion or planning authorizes `discuss`;
development, implementation, fixing, continuing execution, or immediate
progress authorizes `develop` or the applicable lifecycle continuation. Do not
weaken explicit intent merely because the request also says “create a Task.”
The examples below are separate operations, never an automatic
create/submit/activate sequence.

Discussion does not authorize delivery; follow the Leader's
[planning and activation boundary](../../yui-leader/references/planning.md) before
activation. Queries, record-only input and discussion do not authorize
reopening. An explicit request to continue the same completed result can
authorize the necessary reopening; first read
[same-Task delivery](task-delivery.md), not Draft activation.

```sh
yui operator submit "<related request and delta>" --task <task-id> --intent discuss
yui task create "<independent outcome>" \
  --project <project> --base <project>=<ref>
yui operator submit "<request and routing context>" --task <new-task-id> --intent develop
yui task activation request <new-task-id> --request-id <id> --environment <plan>
```

Inspect an existing request before creating another. `task activate <task-id>`
can adopt an eligible request in the foreground; it never activates a Draft
without a recorded request and environment plan.

After the user has authorized a submission, choose its intent explicitly; it is
never inferred by the CLI from the message text. `discuss` (the CLI default when
`operator submit` is already being invoked) routes the Draft to planning;
`record` saves the message without waking the Leader; `develop` asks an unplanned
Draft to activate now, and reports the exact next step when it cannot (already
planned → request activation explicitly; execution stopped → start it first).
The CLI default is not permission for the Operator to invoke submission after a
creation-only request. Pass `--request-id <key>` to make a submission idempotent:
retrying the same key returns the original message and routing instead of
creating a duplicate, and the same key with different text is refused as a
conflict.

For quote-sensitive text, nested JSON or long bodies, read
[Safe body transport](body-transport.md) before constructing the submission.
