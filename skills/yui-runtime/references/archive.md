# Archive a Task

Read before an authorized archive or cleanup of retained archive resources.
This is not required merely to record publication or reopen a result.

## Archive separately

Completion does not authorize archive. A delivery Leader with original user
authorization may use [ordinary archive](../../yui-leader/references/authorization.md);
this grants no force or abandonment authority. Otherwise the Operator obtains authorization for
the exact Task, checks archive eligibility, then uses `--integrated` for verified
merged delivery or `--abandon` for deliberate non-delivery. General archive
approval never implies `--force` authority. Preserve the Task record.

Ordinary archive requires settled business, exact delivery (or authorized
abandonment), and proven stopped execution. It commits logical archive before
one foreground resource cleanup. Safe physical retention—dirty diagnostics,
missing-path recovery gaps, or remaining Git registrations—is not a reason to
force archive or rewrite old Integration outcomes. Terminal failed/superseded
Integration history stays readable; an active/conflicted attempt or unknown
execution still requires settlement.

With explicit force authorization for a completed or cancelled (retired) Task, use
`yui task archive <task> (--integrated|--abandon) --force`. Force commits the
archive and stops new Task scheduling before attempting safe foreground cleanup.
Missing/stale delivery evidence, unresolved execution and cleanup errors become
warnings with retained resource references; they do not block that commit.
Authority, lifecycle, identity and mandatory audit persistence still fail closed.

Force does not verify a merge, accept work, stop unknown execution, discard dirty
data or imply abandonment. Keep the requested disposition and original
Publication/completion evidence. Unverified local commits and resources that
cannot be safely released stay owned and traceable. Late runtime events remain
source evidence, not authority to resume or settle unknown input.

Read `task show <task> --json` for `data.archive.warnings`,
`data.archive.retainedResources` and `data.archive.cleanupEvents`. These bounded
views include counts and inspection actions; read the existing paginated
`task event list` and Task context resource inventory for omitted evidence.
A successful archive
exit means `archived=true`, not that cleanup fully succeeded. `cleanupFinished`
means the foreground pass finished, not that every resource was removed.
`allResourcesReleased` separately requires release evidence and no retained
resources. Historical warnings do not disappear after a successful later pass.
If cleanup was interrupted, the Task stays archived. Repeating archive only
reports current facts. After inspecting the exact retained owner/reason, use
`task archive-cleanup <task>` for one new bounded pass, or the reported
WorkItem/Review/Integration cleanup entry. Every pass rechecks current identity,
runtime and Git registration facts; it is not an atomic batch and does not
discard unknown material. Registry-only remnants require the existing resource
inspection route, not a global `worktree prune`. No background retry is implied.
