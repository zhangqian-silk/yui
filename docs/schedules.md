# Persistent time plans

For the installed Project maintenance plan and its user overrides, see
[Built-in Project sync](project-sync.md) ([简体中文](project-sync.zh-CN.md)).

A Schedule answers **when** to dispatch a scoped Job. It either admits a Run
of an existing Job (default), or asks the Job layer to instantiate an exact
definition revision as a new Job and admit its first Run. It owns
the time rule and trigger progress, not the command, execution status or result.
Immediate execution remains `job run`; manual Runs do not move a Schedule.
All processing uses the existing Controller and the Job supervisor.

## Public CLI and API

```sh
yui schedule create --global --schedule daily-probe --job probe \
  --authorization service \
  --rule '{"kind":"cron","expression":"30 9 * * 1-5","timezone":"Asia/Shanghai"}'
yui schedule list --global
yui schedule show --global --schedule daily-probe
yui schedule disable --global --schedule daily-probe --revision 1
yui schedule enable --global --schedule daily-probe --revision 2
yui schedule update --global --schedule daily-probe --revision 3 \
  --rule '{"kind":"interval","anchor":"2026-10-17T00:00:00Z","everyMs":3600000}'
# New Job per occurrence, pinned to the currently available source revision:
yui schedule create --global --schedule isolated-probe --job probe \
  --authorization service --target '{"kind":"new-job","definitionRevision":1}' \
  --rule '{"kind":"interval","anchor":"2026-10-17T00:00:00Z","everyMs":3600000}'
# Unlike disable, revoke also denies not-yet-started service Runs:
yui schedule revoke --global --schedule isolated-probe --revision 1
```

Create the referenced Job first using [the Job CLI](job-runs.md). Replace
`--global` with `--task task-N` for a Task-owned Schedule. Public local users can
manage global plans without an Operator Session. Creating or rebinding a public
plan requires the explicit `--authorization service` choice. Current Operator
callers can also choose service authorization; omitting it on creation preserves
the Session-bound behavior. Task callers cannot access
global or other Tasks' plans. Assignment limits are checked against the Job
on the server. A Project is a Job target, never an ownership scope.

The Controller RPC is `schedule.control`. Its input is
`{op,scope,caller,id?,jobId?,target?,authorization?,rule?,expectedRevision?}`. Supported `op` values
are `create`, `list`, `show`, `update`, `enable`, `disable`, `revoke`. `scope` uses the
Job `JobScope` contract. Trusted ingress must resolve/authenticate `caller`;
client-supplied scope/identity is not authorization. `create` requires `id`,
`jobId`, `rule`; all edits require the observed `expectedRevision`. `update`
requires a complete rule and optionally changes `jobId` within the same scope,
revalidating both old visibility and new execution authority. Scope is immutable.
Rule updates retain enabled status only for an already enabled plan; all other
states become disabled with the new future rule and require explicit enable.

`target` defaults to `{"kind":"existing-job"}`. `{"kind":"new-job",
"definitionRevision":N}` requires the exact currently available source version.
A source edit never silently changes that pinned selection; explicitly update
the target and, for service plans, reauthorize. Job owns deterministic instance
identity and `instantiation` provenance (`sourceId`, `sourceRevision`, occurrence
`key`). It does not create a Task. Each new instance has its own overlap scope;
existing-job mode retains one Job's overlap behavior.

Create/edits return the Schedule; list returns visible Schedule records.
Show returns `{schedule,lastSuccess,runs}`. `lastSuccess` is the latest readable
**succeeded JobRun** triggered by this Schedule across its historical Jobs, or null.
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

Instance creation, first Run admission and advancement commit in the same Store transaction. Repeated scans
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
optional exact `jobId`/`runId`, `generation`, and reason. Old receipts retain
only what was originally known; migration does not invent those references.
An overlap Run is the occupying execution,
not a successful execution of this occurrence. Recurring overlap skips that
coalesced tick and advances; once overlap retains its original due instant and
retries admission on a later pass without adding a queued Run.
Failed Runs stay in Job history; the next recurring tick follows the same plan.

Session-authorized creation, update and enable capture the authenticated Session binding and Job
revision. They do not grant execution to a replacement Session or a changed
Job definition. Before each admission both are checked again, along with current
Job/Task/workspace prerequisites. Revocation or a changed definition stops the
plan as `needs-attention`; an authorized current manager must inspect and
explicitly enable it. Controller restart alone does not revoke the binding.
Worker-owned plans also retain the current Assignment boundary.

Service authority is a separate explicit grant stored on the Schedule. The
compiled internal `schedule` registration permits only global `system.noop`
and `project.refresh`; it does not permit Task shell execution, arbitrary code,
or additional scopes. `origin=builtin`, `caller.scope=service` and client-supplied
grant fields cannot create a service identity. Management first authenticates
the ordinary public/managed caller and checks the actual Job target.
The grant binds Home, Schedule, dispatch mode, exact definition, action, Project
and input. Admission and runner start recheck current validity; Project refresh
also rechecks after waiting for its maintenance lock. Replacing Operator Sessions
does not revoke a service grant. Source/configuration changes block the plan
with retained reasons; no silent rebind occurs.
Service Run results remain in Job history and do not enqueue an Operator wake.
Dispatch errors still use the existing attention notification when a recipient exists.

`disable` only stops future dispatch; it does not invalidate the grant of an
already admitted Run. `revoke` disables the plan and invalidates the grant,
preventing queued service Runs from starting (not cancelling effects already
in flight). An explicit `enable --authorization service` grants a fresh identity;
it never resurrects old revoked Runs. Ordinary enable/rule edits retain an
unchanged active grant. Reauthorization and source/target changes are deliberate
management operations, not automatic repairs.

Unclassified admission failures roll back, stop that plan, persist the reason
and notify its Task Leader or configured global Operator via existing durable inboxes.
If no Operator role exists, the plan/reason remains inspectable without creating one.
No new recovery queue, lease or automatic retry protocol is introduced.

Task stop marks enabled plans as needing attention; restarting execution alone
does not silently reactivate them. Normal Task completion refuses unfulfilled
enabled/blocked once plans: explicitly disable or fulfil them first. Repeating
plans do not block completion and are atomically retired with the Task.
Cancellation/archive retires enabled/blocked plans with their reason and
history preserved. Existing active/unknown Runs retain all earlier lifecycle
settlement guards. A reopened Task does not implicitly resume retired plans.

## Storage and downstream integration

Storage **1.15 → 1.16** adds explicit target and authorization kinds to existing
plans, preserving Session bindings, identities, rules, progress and old receipts.
Original Schedule bytes are archived under migration 16. It never turns historical
Session authority into a service grant. New optional Job instance provenance and
Run service-grant references use the existing tables. The published **1.9 → 1.10**
DDL and all older transitions remain unchanged. New Homes initialize 1.16;
existing Homes require the centralized
explicit upgrade path. No real Home migration or package release is implied.

`src/schedule/schedule.ts` exports `Schedule`, `ScheduleRule`, time calculation
and validation. `src/controller/scheduleControl.ts` owns management and bounded
reconciliation; Job's `instantiateJobRun` composes instance creation with
`admitJobRun`, the execution admission seam. No ScheduleRun state or second
writable execution result is introduced.
Consumers should use RPC/service responses rather than write storage directly.

Project refresh is a separate controlled Job action supplied by Task128.
Schedule does not implement refresh or Knowledge maintenance. A refresh Job
can use the same reference-only plan once that action is integrated and tested;
this document alone is not evidence of that joint integration.
InputRequest recommended-option deadlines, heartbeat, redelivery and other
internal domain timers remain with their existing owners.
