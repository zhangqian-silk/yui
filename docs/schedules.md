# Persistent time plans

A Schedule answers **when** to admit a Run of an existing scoped Job. It owns
the time rule and trigger progress, not the command, execution status or result.
Immediate execution remains `job run`; manual Runs do not move a Schedule.
All processing uses the existing Controller and the Job supervisor.

## Public CLI and API

```sh
yui schedule create --global --schedule daily-probe --job probe \
  --rule '{"kind":"cron","expression":"30 9 * * 1-5","timezone":"Asia/Shanghai"}'
yui schedule list --global
yui schedule show --global --schedule daily-probe
yui schedule disable --global --schedule daily-probe --revision 1
yui schedule enable --global --schedule daily-probe --revision 2
yui schedule update --global --schedule daily-probe --revision 3 \
  --rule '{"kind":"interval","anchor":"2026-10-17T00:00:00Z","everyMs":3600000}'
```

Create the referenced Job first using [the Job CLI](job-runs.md). Replace
`--global` with `--task task-N` for a Task-owned Schedule. Global management
requires a current authenticated Operator Session; Task callers cannot access
global or other Tasks' plans. Assignment limits are checked against the Job
on the server. A Project is a Job target, never an ownership scope.

The Controller RPC is `schedule.control`. Its input is
`{op,scope,caller,id?,jobId?,rule?,expectedRevision?}`. Supported `op` values
are `create`, `list`, `show`, `update`, `enable`, `disable`. `scope` uses the
Job `JobScope` contract. Trusted ingress must resolve/authenticate `caller`;
client-supplied scope/identity is not authorization. `create` requires `id`,
`jobId`, `rule`; all edits require the observed `expectedRevision`. `update`
requires a complete rule and optionally changes `jobId` within the same scope,
revalidating both old visibility and new execution authority. Scope is immutable.
Rule updates retain enabled status only for an already enabled plan; all other
states become disabled with the new future rule and require explicit enable.

Create/edits return the Schedule; list returns visible Schedule records.
Show returns `{schedule,lastSuccess}`. `lastSuccess` is the latest readable
**succeeded JobRun** triggered by this Schedule under its current Job, or null.
It is derived from Run history, never a separately writable Schedule field.
Retargeting does not move or erase the old Job's Run history.

## Time and trigger rules

- Once: `{"kind":"once","at":"2026-10-17T08:00:00+08:00"}`. Creation and rule
  replacement require a future instant with an explicit UTC offset.
- Interval: `{"kind":"interval","anchor":"2026-10-17T00:00:00Z","everyMs":60000}`.
  Minimum interval is 1000 ms. Occurrences are anchor + N × everyMs, N ≥ 0.
  The next occurrence is strictly after creation/edit/enable time. Manual
  execution and maintenance delays never shift the anchor.
- Cron: five fields, explicit IANA timezone, `cron-parser` 5.10.2 semantics.
  Random `H` is rejected. DST spring gaps move the nonexistent time forward
  by the offset change; repeated fall local times select the earlier instance
  once. For example New York 02:30 on March 8, 2026 becomes 03:30 (07:30Z);
  01:30 on November 1 selects 05:30Z, with the next daily occurrence November 2
  at 06:30Z. This deliberately uses the parser's policy, not a custom
  “skip gap / both folds” enumerator.

`nextDue` is persisted as UTC. Each Controller reconciliation admits at most
one occurrence per selected Schedule, with at most 100 due Schedules per pass.
Plans are ordered by oldest attempt to prevent blocked once plans starving
others. This is maintenance-resolution scheduling, not a real-time timer:
actual admission can lag the due instant by Controller load/reconciliation
interval. No independent daemon or per-plan timer is created.

After downtime, the earliest pending occurrence represents the coalesced
work; the next occurrence is strictly after the current clock/high-water fence.
There is no historical catch-up queue. A persisted UTC `processedThrough`
prevents clock rollback or rule edits from replaying old progress.
Rule updates increase `generation`; enable retains it. The internal trigger
key is `<schedule-id>:<generation>:<UTC-due>`, scoped to the Job.

Admission and advancement commit in the same Store transaction. Repeated scans
and Controller replacement retain the same Run and occurrence identity.
The transaction never spawns. The supervisor starts committed Runs and
preserves its existing unknown-effect and exact-process safeguards.
This is not an exactly-once guarantee for external side effects.

## State and authority

`enabled` allows future admission; `disabled` is explicit user/Agent disposal
of future intent; `completed` means a once occurrence was **admitted**, not that
its Run succeeded; `needs-attention` preserves blocked intent; `retired` records
Task terminal shutdown. Disabling does not cancel an already admitted Run,
and cancelling a Run does not disable its Schedule.

`lastAttempt` records `at`, `dueAt`, `outcome` (`admitted`, `overlap`, `blocked`),
optional exact `runId`, and reason. An overlap Run is the occupying execution,
not a successful execution of this occurrence. Recurring overlap skips that
coalesced tick and advances; once overlap retains its original due instant and
retries admission on a later pass without adding a queued Run.
Failed Runs stay in Job history; the next recurring tick follows the same plan.

Creation, update and enable capture the authenticated Session binding and Job
revision. They do not grant execution to a replacement Session or a changed
Job definition. Before each admission both are checked again, along with current
Job/Task/workspace prerequisites. Revocation or a changed definition stops the
plan as `needs-attention`; an authorized current manager must inspect and
explicitly enable it. Controller restart alone does not revoke the binding.
Worker-owned plans also retain the current Assignment boundary.

Unclassified admission failures roll back, stop that plan, persist the reason
and notify its Task Leader or global Operator via existing durable inboxes.
No new recovery queue, lease or automatic retry protocol is introduced.

Task stop marks enabled plans as needing attention; restarting execution alone
does not silently reactivate them. Normal Task completion refuses unfulfilled
enabled/blocked once plans: explicitly disable or fulfil them first. Repeating
plans do not block completion and are atomically retired with the Task.
Cancellation/archive retires enabled/blocked plans with their reason and
history preserved. Existing active/unknown Runs retain all earlier lifecycle
settlement guards. A reopened Task does not implicitly resume retired plans.

## Storage and downstream integration

Storage **1.9 → 1.10** appends `schedules`, keyed by `(scope_key,schedule_id)`,
and its due index. Old Job/Run bytes and published baseline checksums remain
unchanged. New Homes initialize 1.10; existing Homes require the centralized
explicit upgrade path. No real Home migration or package release is implied.

`src/schedule/schedule.ts` exports `Schedule`, `ScheduleRule`, time calculation
and validation. `src/controller/scheduleControl.ts` owns management and bounded
reconciliation; `admitJobRun` remains the only execution admission seam.
Consumers should use RPC/service responses rather than write storage directly.

Project refresh is a separate controlled Job action supplied by Task128.
Schedule does not implement refresh or Knowledge maintenance. A refresh Job
can use the same reference-only plan once that action is integrated and tested;
this document alone is not evidence of that joint integration.
InputRequest recommended-option deadlines, heartbeat, redelivery and other
internal domain timers remain with their existing owners.
