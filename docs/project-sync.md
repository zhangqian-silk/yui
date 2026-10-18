# Built-in Project sync

The Controller installs one `project-sync-<project-id>` Job and Schedule for each
registered Project. It reconciles on startup and the existing Schedule pass, so
registry changes are reflected on the next pass. There is no second timer,
Task, Agent or Operator Session in the normal path.

Eligible Projects are active, managed, have a configured remote, matching stable
and development branches, and their canonical Home checkout. External, retired,
removed or otherwise ineligible Projects have a visible reason and no automatic
execution. The runner rejects symlinks and linked/shared worktrees. Safe refresh
retains its maintenance lock, current-target checks, noninteractive fetch,
remote verification and fast-forward-only behavior. Dirty or diverged checkouts
are not reset or rebased.

## Timing and controls

The default is every six hours, first due six hours after installation. This also
applies to eligible existing Projects when the new Controller first runs.
Missed intervals coalesce into at most one admission, followed by the next
occurrence strictly after the Schedule fence. Existing overlap/unknown-effect
protection remains in force; no missed-period batch is replayed.

Settings → Jobs & schedules shows the built-in label, Project, automatic preference,
effective state/reason, next due, recent check, last successful refresh, exact Run
history and business result. Global management is local-user authenticated and
does not require an Operator Session. Task shell management retains its existing
Session boundary.

Use the ordinary Schedule CLI (read its revision before changing):

```sh
yui schedule show --global --schedule project-sync-project-1
yui schedule disable --global --schedule project-sync-project-1 --revision 1
yui schedule enable --global --schedule project-sync-project-1 --revision 2
yui schedule update --global --schedule project-sync-project-1 --revision 3 \
  --rule '{"kind":"cron","expression":"0 */6 * * *","timezone":"Asia/Shanghai"}'
yui job run --global --job project-sync-project-1 --request-id check-now-1
yui job runs --global --job project-sync-project-1
yui job run-result --global --job project-sync-project-1 --run <exact-run-id>
```

Revision numbers above are illustrative. Supported overrides are a recurring
interval of at least one minute or five-field cron with an explicit timezone.
Once rules and retargeting built-in Jobs/Schedules are not supported. Disabling
persists user intent separately from effective eligibility; restart, registry
reconciliation and target changes do not turn it back on or reset its rule.
Revoke also switches this preference off. Enabling explicitly issues a fresh
grant after checking current prerequisites. Rule edits while off remain off.

Run now is an explicit manual action, allowed while automatic sync is off when
the target is eligible. It does not change the due time. Disabling/revoking
built-in sync invalidates not-yet-started automatic Runs, including those waiting
for the maintenance lock; it cannot undo Git effects already in progress.
Each Run retains its exact target digest, definition revision, trigger and result.
The latest failed check is never replaced by the last successful check.

## Ownership and recovery

A custom same-Project `project.refresh` Job wins: it is not changed, adopted or
automatically reauthorized. The built-in plan shows that Job's identity and
does not admit work. To switch deliberately, retarget the custom Job away from
that Project using the ordinary Job update operation, then manage the built-in
Schedule. Custom IDs in the reserved `project-sync-` namespace are not adopted;
the installer reports the collision.

The `builtin` marker is provenance, not authority. A compiled Project-sync service
registration issues exact Home/Schedule/source-bound grants only for current
eligible registry targets. Registry target changes replace the definition and
grant, never retarget an old Run. Removed/ineligible targets revoke automatic
authority and preserve history; eligibility recovery uses the retained user
preference and rule. Ordinary dispatch failures stay visible for explicit
inspection/enable, not automatic speculative retries. Business failures keep
their Run evidence; a later normal Schedule occurrence is a new check.

Storage 1.17 → 1.18 is additive, preserving existing custom records and history
byte-for-byte. It does not start Git work during migration. Upgrading or enabling
this behavior on a production Home is a deployment decision, not implied by
development tests. Validation uses disposable local repositories and isolated Homes.
