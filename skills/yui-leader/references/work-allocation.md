# Work allocation and dispatch

Read before choosing or changing a separate work/acceptance boundary, executor,
or concurrency topology. Direct work on an existing coherent result needs no
allocation ceremony. Preserve existing ownership until a justified change.

## Separate the work unit, executor, and concurrency

Honor the user's explicit choice of direct work or delegation. Otherwise make
three independent judgments; additional Review is a separate acceptance judgment,
not a reason by itself to delegate implementation.

**Does this result need its own management and acceptance boundary?** A WorkItem
is a substantial result worth managing and accepting separately inside the Task.
It need not have a different person, an independent release, or parallel execution.
Use zero WorkItems when the Task already holds one coherent outcome. One WorkItem
can be Leader-owned or hold a justified whole-result managed Assignment and
Candidate. Copying the Task unchanged or displaying progress is not a reason
to create it. Do not split analysis, editing, testing, Review, and ordinary
repairs into phase-shaped WorkItems.

**Who should execute?** Direct Leader execution is the default viable path for
one coupled result when current context, delivery authority, and tools suffice.
A native child can supply bounded specialist attention or parallel investigation
inside this Session when a best-effort result suffices; it creates no Yui identity,
authority, or WorkItem by itself.

Choose a managed Worker only for a concrete benefit that repays requirement
restatement, context reload, startup, waiting, inspection/rework, Integration,
and lifecycle management. Benefits include safely parallel independent results,
a needed capability or execution environment, a genuinely necessary separately
recoverable lifecycle, freeing the Leader for another actual responsibility,
or explicit user delegation. An available Worker, cheaper/different model,
many files, high risk, long duration, or generic maintainability alone is not
enough. Risk can justify independent Review without delegating implementation.
When delegation involves a material tradeoff, leave one sentence of concrete
benefit in the existing Brief; no form, approval, or separate decision record
is needed.

**Should separate units run concurrently?** Multiple WorkItems may run serially
because of a real dependency, or concurrently when their results can advance
independently and the net benefit exceeds coordination and Integration cost.
Neither a single WorkItem nor multiple executors proves parallelism. Keep
coupled changes together.

For example, fix one coupled behavior directly in Task main, even when it touches
many files. Delegate an independent import tool while the Leader implements its
consumer when the two have a stable boundary and useful parallel progress.
Keep two separately accepted stages serial when the second genuinely needs the
first result. Do not wrap a whole Task in an `implementer` WorkItem merely because
that Role exists.

Apply these choices to new work. Do not automatically cancel an existing Worker,
reassign/retire WorkItems, or move workspaces to conform to a new default; preserve
their current ownership and evidence until a justified explicit change.

An ordinary managed dispatch uses the WorkItem assignee; omit `--lane-role`.
Use [replicated execution](replicated-execution.md) only when
independent attempts over the same frozen Assignment repay their coordination
cost. Direct managed execution already provides durable ownership.

## Give Agents outcomes, not premature implementations

Make delegated work decision-complete:

- objective and observable acceptance criteria;
- relevant Task and Project context;
- hard scope, authority, and workspace boundaries;
- known constraints, risks, dependencies, and existing decisions; and
- expected checks and evidence.

Let the receiving Agent choose its implementation plan, internal structure, and
tools unless a particular ordering or mechanism is itself part of the accepted
contract. Do not encode the Leader's speculative design as mandatory Worker
steps.

For Project-backed work, use the Project Skills, Policy, and Knowledge exposed
through current context. Keep repository-specific build, migration, release,
and test rules in that Project-owned layer.

Before WorkItem dispatch, put the complete bounded requirements in the WorkItem
or explicitly select up to 16 relevant readable materials with repeated
`--context-ref <store/refId@digest>` on `task work dispatch`. Obtain exact IDs and
digests from current Task context list/inspect. Core freezes these selected
values after the existing caller-scope checks; mentioning a record in `--input`
does not select it or grant access. Missing, forbidden or changed references
refuse dispatch before Provider startup: correct the selection or make the
WorkItem self-contained, never ask the recipient to bypass expansion rejection.

Before creating or acting on an Assignment, read
[Assignment execution](assignment-execution.md). Before dispatch inspect current
exact active Run/Review bindings; activity is not a Task-wide lock.

## Inspect execution facts

Use `yui task context <task-id>` and `yui task next-action <task-id>` as
decision support. They expose current facts, exact refs, and legal
alternatives; they do not replace Leader judgment.
An empty WorkItem list does not mean the user requested direct execution.
Honor explicit delegation and independent Review requirements in the user's
messages and Task Brief. Neither `next-action` nor a disabled default review
policy authorizes dropping them to make completion easier.

Missing or cyclic dependencies identify conflicting records, not the correct
business repair. Read the related requirements, preserve valid edges, then
explicitly revise the intended dependency set or retire genuinely obsolete work.
Do not clear all dependencies merely to make a mechanical gate pass.

An Integration Job's success is not the final target update. For that
notification, read [Integration](integration.md) and continue from its exact
evidence; do not start a duplicate operation. Read that guidance also for an
ordinary Git conflict or an attempt that cannot be reliably resumed.

Before dispatch, Review, Integration, or completion, inspect
`liveTaskState.activeRuns` and `liveTaskState.activeTaskReviews` in the current
Context Pack. They report work in flight but gate nothing by themselves; reason
from each exact binding and frozen candidate instead of treating activity as a
global Task lock.
