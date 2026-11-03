# Select the owning outcome

Read when Task identity is missing or ambiguous, creating a new Task, or deciding
whether a changed requirement belongs to an existing outcome. An exact known Task
uses its current context directly, not a catalog search.

When input names a Task (including an exact Task notice), start with its current
Context and referenced originals; do not rediscover it through Project/Task
catalogs. Otherwise use `yui task list --json` with Project/status/search
filters to locate the bounded outcome, and `yui project list` only when Project
identity is needed. Read `yui task context <candidate-task-id>` before routing.

Task listing is bounded: follow `nextCursor` with the same filters only when
more candidates are needed, never traverse all pages by default.
Attention counts cover the authorized catalog before ordinary
filters and pagination. Follow a category's `--attention` query to enumerate
its affected Tasks, clearing ordinary filters and retaining its `all` flag.
`executionSignals` are conservative raw inspection
candidates (including live Runs and open work), not a computed failure or
execution status. Inspect the selected Task's Context and original Messages
before routing or deciding; a summary/ref is not the requirement or report.

Route new input to an existing Task when it advances, corrects, narrows, or
extends the same bounded outcome and shares final acceptance, delivery, or
rollback. Development, local completion, PR/MR submission, merge and ordinary
follow-up fixes are not inherently separate outcomes. Keep their original
authorization, acceptance and Publication traceable in the owning Task.

Create a new Task for a genuinely independent outcome that can be accepted,
delivered and rolled back separately, or when the user explicitly asks for a new
Task. State the substantive new outcome or explicit instruction in its routed
context. An old Task being completed, needing revalidation, sharing files or
needing a PR is not that reason. A blocked continuation is a boundary to report,
not evidence that the result has become independent.

Repository, file overlap, technical layer, request size, and Task type do not
determine Task identity. They also do not determine WorkItem count. Let
isolated workspaces and Integration handle independent Git changes.

Keep the Task title concise and put detailed intent, constraints, and evidence
in its description or routed Message.

Resolve all known Projects before repository-backed execution. A stable Project
checkout is read-only reference state, not the Task base authority. Yui records
the Task's remote baseline when creating its managed workspace; do not route
work by copying or modifying the stable checkout.

When the user changes an existing requirement, submit the semantic delta and
its reason to the same Task. Let the Leader reassess the current design and
retire or replace only work invalidated by that change. Do not rewrite history,
restart unaffected work, or create a new Task merely because the implementation
approach changed.

Do not create WorkItems at routing time. The Leader decides execution topology
from current ownership and acceptance boundaries. A WorkItem is justified only
for a substantial independently useful requirement, not for investigation,
phases, files, tests, reviews, findings, or small repairs.
