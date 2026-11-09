# Acceptance and completion

Read before accepting a Candidate or attempting Task completion, not on every
execution turn. Read [Review](review.md) when a managed result actually requires
disposition, and [Integration](integration.md) before integrating isolated Git
changes; neither is mandatory for unrelated direct implementation.

## Accept, integrate, and complete

A Worker or Reviewer AgentRun result is evidence, not acceptance. Inspect the
result, diff, checks, and current Candidate before deciding.

Group confirmed findings by root cause. Use the traced paths to check other
reachable consumers/boundaries within scope and repair affected instances
together, not just the reported checkpoint. Refresh the short material index
and repair evidence where they changed, without accumulating round-by-round
history. For ordinary full re-review, preserve the current complete
candidate and requirements; add repair delta, prior finding dispositions and
still-valid evidence. Delta is an attention aid, not the full-review boundary.
Do not conflate this with an explicitly authorized equivalence Delta Recheck.
Neither finding counts, fixed round counts nor a majority vote decides acceptance.

If a result is insufficient, reject it with bounded feedback and redispatch
the same WorkItem and Role while scope remains valid. Before accepting isolated
Git changes, read [Integration](integration.md) to capture and
integrate the latest Candidate. Do not edit managed refs or bypass Yui's
compare-and-swap boundary.

After an authorized PR/MR operation, follow
[publication recording](../../yui-runtime/references/publication.md).
External delivery and Task completion remain separate facts.
Keep authorized follow-up delivery of this result in this Task and its legal
managed workspace: synchronize, resolve necessary conflicts, validate, perform
only the authorized external operations, and record their exact evidence.
Do not refer ordinary delivery to a new Task. When remote delivery is part of
the current requirement, a local commit or completed Run does not satisfy it;
report a real blocker rather than declaring that requirement complete.

After a ReviewRound is terminal, the Leader or authorized Operator owns
`task work review cleanup <task>/<round>`. Preserve dirty diagnostic evidence
and resolve it explicitly; do not ask a Reviewer to clean its own runtime
after its final report. Cleanup can remain advisory at completion. Ordinary
archive requires settled business and stopped execution, not complete physical
release; safe resource retention is reported separately. Explicitly authorized force archive preserves
unresolved resources and diagnostics under the shared
[archive contract](../../yui-runtime/references/archive.md). The Leader
does not gain independent archive authorization. An original explicit user
archive request can authorize the Controller-owned ordinary archive described
in [source-authorized capabilities](authorization.md).

Complete only when the Task outcome is satisfied, required checks and review
contracts are settled, WorkItems are accepted or deliberately retired, latest
isolated results are integrated, and user inputs are resolved:

```sh
yui task complete <task-id> \
  --summary "<outcome, validation, and remaining risk>"
```

Completion records the exact Project heads. Archive is a separate,
user-authorized action, never an implication of completion or publication.

Completion is offline by default. `--refresh-remote` only refreshes remote
freshness observations; neither path rebases or starts Integration checks.
For observation alone use `task base status <task> [--refresh]`. If upstream
changes need integration, choose it explicitly before completion:
`task upstream integrate <task> (--latest|--project <project>)` requests rebase
and the configured checks/CAS. Consume its exact Integration/Job and partial
results; a prepared candidate is not an advanced Task HEAD.
An established final Review is still prepared/dispatched by completion without
renewed approval. Inspect the returned stage and exact ReviewRound/Run: a
Review-pending, running or blocked result is not Task completion.

If completion reports `pending-user-input`, new user intent has not yet reached
the current notification window. End this native turn so the next notification
can be delivered, then read the original messages and reassess the outcome.
Do not spin on completion, drop messages, or manufacture another Run to proceed.
A current Leader Session can create a formal InputRequest during an ordinary
notification; no active AgentRun is required.
