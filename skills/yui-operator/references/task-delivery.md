# Same-Task and serial delivery

Use this when the user asks to submit, merge or correct existing Task results.
The owning Task remains the default home of the result, even after local
acceptance. This is Agent coordination using current facts and atomic commands,
not a new delivery workflow or persistent scheduling state.

## Establish the current boundary

Read each selected Task's current Context, full original request and relevant
Messages, completion evidence, existing Publication/PR identity and dependencies:

```sh
yui task context <task> --json
yui task message show <task/message>
yui task publication list <task> --json
yui task remote-delivery <task> --json
yui task role session inspect <task> leader
```

Local reads do not refresh a provider. When an authorized external read is needed,
inspect the exact existing PR and commits before creating or retrying anything.
Unknown delivery or external effects are not permission to repeat the operation.
Use [Runtime recovery](../../yui-runtime/references/recovery.md) for exact
notification/Session uncertainty, not a private retry or polling loop.

Separate lifecycle, execution gate and Session authority:

- An active, execution-enabled Task can receive ordinary Leader input. Inspect
  the submission receipt and subsequent notification/result; admission is not
  implementation.
- A Draft still follows [planning and activation](../../yui-leader/references/planning.md).
  An old planning Session does not gain delivery authority from activation.
- An explicitly stopped Task needs authorized `task execution start <task>`
  after exact cleanup, not another message or Session replacement to bypass the
  stop. Starting execution is available only for open Tasks.
- A completed, unarchived Task has separate local acceptance and remote delivery
  facts. An explicit user request to continue the same result authorizes the
  necessary `task reopen` before submitting that bounded request. Follow the
  [authorized two-step path](../../yui-runtime/references/publication.md#post-completion-routing-boundary);
  do not require a second mechanical “reopen” confirmation.
- Cancelled/retired intent is not active work. An archived Task cannot be reopened;
  retained workspaces and historical Sessions do not authorize execution.
- Session loss or replacement is not a new result or an automatic lifecycle
  change. Recover only within the Task's current authority, preserving its intent.

Use the existing reopen and submission operations, not an invented auto-reopen
option or a new delivery Task. Reopening and saving input have separate receipts;
inspect current state after a failure and retain the original request identity.
Only a real missing authority, resource or unresolved execution boundary calls
for escalation. Do not reopen for a query, implicitly restore cancelled intent,
use archived workspaces, restart a separate execution stop, or claim rejected
input was saved.

## Advance one owning Leader at a time

Choose a sensible order from the user's order, real dependencies and current
target-branch facts. For a serial multi-Task delivery request:

1. Send only the current Task's Leader a durable request naming the authorized
   external effects, repository and target branch, source result/PR, relevant
   earlier merge evidence, limits and expected proof. Development alone does not
   authorize push/PR/merge; merge does not authorize release, production update or
   archive. Resolve genuinely missing authority before requesting those effects.
2. The Leader handles synchronization, necessary conflict resolution, relevant
   validation and the authorized normal push/PR/merge in its own legal managed
   workspace. It records confirmed operations promptly through
   [Publication](../../yui-runtime/references/publication.md), retaining original
   acceptance and reviewing/adopting a changed candidate when applicable.
   Do not register the same PR again under another Task to manufacture coverage.
3. On the durable result/update, read the original report in full and inspect
   the exact Publication, source/merge commits and target. Use authorized
   `task publication verify <task>/<publication>` when needed; then check
   `task remote-delivery <task> --json` for verified merge and coverage of the
   owning Task's accepted result, not just a merged PR label.
4. Only after that evidence satisfies this Task's requested delivery, send the
   next Leader its request with the now-confirmed predecessor facts. If blocked,
   retain the order and pending intent in existing durable context and report the
   specific boundary. Do not launch the dependent delivery or emit unchanged
   waiting messages; future durable updates supply the next opportunity.

After any necessary authorized reopening, either of these is an ordinary durable
Leader submission for the active Task; choose one, do not send both:

```sh
yui operator submit "<delivery request with authority and boundaries>" \
  --task <task> --intent develop --request-id <id>
yui task message send <task> "<delivery request with authority and boundaries>" \
  --intent develop --request-id <id>
```

Omit `--to leader` for this ordinary Leader input. Explicit `--to` addresses an
existing WorkItem/ReviewRound Assignment, not the Task's general conversation.
Keep the exact request ID on a retry of the same submission and inspect its
receipt; a new ID is not a remedy for unknown acceptance.

For three ordered Tasks, this means request A, verify A, request B against A's
confirmed delivery, verify B, then request and verify C. It does not mean sending
three messages immediately and hoping the Leaders serialize themselves.
