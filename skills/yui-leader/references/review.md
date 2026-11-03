# Review and result disposition

Read before requesting independent Review or disposing of a Worker/Reviewer
result. Read the exact full original result before the disposition; a notification
or summary is not acceptance. This is not an implementation-stage prerequisite.

## Validate and make the review judgment

Prepare useful evidence, not a documentation gate. From effective requirements,
non-goals and decisions, distill the few observable behavioral constraints that
matter to this change, with independently grounded expectations. Do not infer
correctness from the candidate or its mocks.

For material cross-layer or asynchronous risks, trace a short real path in the
exact candidate: entry -> actual consumers -> relevant waits/atomic commit
boundaries -> observable result and failure/recovery consequences. Point to
candidate code or existing documents, not just module names or a coverage claim.
Use it to expose where the same constraint must hold across boundaries; do not
enumerate every entry or generate a combination matrix. Keep three things
distinct: constraints/scenarios and expectations, executable test references,
and actual results with candidate/environment/command. Name material unverified
boundaries; a test reference alone is not a passing result.

Small tasks can reference existing materials directly. For complex tasks, put a
short review index in Task artifacts and its commit-pinned reference in Brief.
Keep Brief an up-to-date summary, not a copy of documents or accumulated history.
Review Context carries the frozen Brief and active decisions; inspect the
actual pointer inventory when a material's delivery is uncertain. Read referenced
same-Task artifacts at their fixed commits, not HEAD. Do not assume a path in
`--input`, a WorkItem-only `--context-ref` option, or a summary grants Review
access. Recover a missing authorized reference through existing mechanisms;
do not ask the Reviewer to bypass scope. Materials guide independent inspection,
not its upper bound.

Use the smallest evidence that establishes the accepted behavior and material
boundaries. Reuse a successful check only while its candidate, command, inputs
and relevant environment remain valid; retain its exact result reference.
A different candidate is not covered by an old success: check the changed
behavior and required integration boundaries. Unknown, failed and not-run
checks remain visible. Run the Project's complete local delivery validation
on the final candidate when required; do not repeat unchanged valid success.

As part of accepting a WorkItem or completing a Task, decide whether additional
review would add useful evidence:

- inspect directly when the change is clear and existing evidence is enough;
- use one independent Worker, native child, or Reviewer when independent
  inspection materially reduces a reachable risk; or
- rely on an already completed applicable Review.

This is Leader judgment inside the acceptance decision, not a separate record,
checklist, or workflow phase. A managed Reviewer is optional unless the user,
Project or Task Contract requires it. Do not create a
Reviewer Role or ReviewRound for ceremony. Honor an existing Candidate's
snapshotted `always` policy and any immutable Task-final Review contract.
Otherwise choose whether another review adds enough evidence to justify its
cost.

Use one direct main Reviewer by default. If independent replicas materially
improve evidence, read [replicated execution](replicated-execution.md)
before dispatch or synthesis. Honor required review contracts even when a
cheaper execution path is otherwise available.
One Reviewer should use the applicable complementary perspectives in one round.
Consider independent replication for genuinely complementary cross-system risks,
not a fixed headcount or file/frontend/backend partition. Keep the same candidate
and common requirements; risk emphasis must not hide cross-layer contracts.

When several WorkItems contribute to one outcome, prefer one independent
Task-final Review after their accepted results are integrated over repeating a
complete Review for every WorkItem. Request an earlier WorkItem Review only
when that frozen Candidate has a specific risk that should be resolved before
Integration.

When a Worker or Reviewer result arrives, resolve its exact AgentRun and read the
complete original `AgentRunResult.output` before starting new work or waiting
again. Treat headings or JSON fields only as communication aids; never infer
that Core parsed or accepted them. Decide whether to accept, repair, review
again, retry execution, or ask for a genuinely user-owned decision. Route
reachable issues to the original execution owner. Fix a small Task-main issue
directly; create a Repair WorkItem only when the repair is itself a substantial
independently owned requirement.

A failed ReviewRound is an execution failure, not a repair wave. First read
its Provider retry projection: bounded infrastructure recovery may already own
the successor. Otherwise inspect its exact Round, AgentRun, candidate, Core failure, and
`task next-action` facts, then choose the smallest recovery that preserves the
frozen boundary. Do not invent a retry loop or silently replace the Reviewer
Session. For replicated execution, choose whether to retry a failed Producer,
settle that Lane, or synthesize selected available results. Retry a failed
main synthesis through its exact AgentRun, preserving its selected source snapshot.
