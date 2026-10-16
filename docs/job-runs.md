# Job definitions and exact execution Runs

A Job is a stable, scoped definition. A JobRun is one execution, with its own
ID, configuration revision, trigger, immutable execution specification,
process identity, artifacts and terminal result. Changing a definition never
changes an admitted Run. No Schedule is needed for immediate execution.

## CLI and ownership

Commands operate through the Controller's `job.definition` RPC:

```sh
yui job define --global --job probe --title "Local probe" \
  --input '{"kind":"builtin","action":"system.noop","input":{}}'
yui job run --global --job probe --request-id first
yui job runs --global --job probe
yui job run-get --global --job probe --run <exact-run-id>
yui job logs --global --job probe --run <exact-run-id>
yui job run-cancel --global --job probe --run <exact-run-id>
```

Use `--task task-N` instead of `--global` for a Task Job. Its configuration is
`{kind:"shell",owner,projectId,head,workspace,env,steps}`, with the same managed
workspace, Project, Assignment and delivery-Session requirements as `job start`.
The Project target is not the ownership scope. Definitions can be inspected
with `job show`, listed with `job list`, and revised with `job update --revision
<observed-revision> --title ... --input ...`. A definition ID is required on
creation; replaying an identical creation is idempotent. Scope cannot be updated.

Global Job management requires the current authenticated Operator Session.
Other GlobalRoles cannot inspect or manage Task Job definitions either, matching
the existing Task Context authorization boundary.
Users can request it through Operator. Literal `caller.scope=user` is not a
credential on the existing Controller socket. Task Sessions cannot inspect,
create, modify or run global Jobs. The initial global action is `system.noop`,
a fixed local no-op implemented by the same standalone runner. It accepts only
empty input and no Project; it does not call a model or external service.
`project.refresh` belongs to its separate feature. Arbitrary global commands,
environments, workspaces and Agent calls are not accepted.

`job run --request-id` is a stable trigger identity within the scoped Job.
Replay returns the original Run; reusing that identity after a configuration
change or with a different retry target is a conflict. A new key after a
terminal result admits a new Run. Queued, running or unknown-effect executions
return `{created:false,reason:"overlap",run:<existing>}` rather than queueing.
Returning an existing Run (including replay or overlap) requires permission to
read that exact Run's original Assignment. If a definition was retargeted and
the caller cannot read the earlier Run, admission fails with `UNAUTHORIZED`
without exposing its snapshot or creating another Run.
Unknown outcomes are never automatically replayed, even after acknowledgement.
Explicit retry uses `--retry-of <exact-failed-cancelled-or-timed-out-run>`.
Cancellation addresses a Run, not a future Schedule. Log reads return up to
64 KiB per completed/checkpointed step; a currently uncheckpointed step is not
included.

The existing `job start` remains the one-shot Task entry point. It creates a
definition and one Run, and its `job` response is still the **Run**. Existing
`job get/cancel/acknowledge --task ... --job ...` address exact Runs, not
definitions or “latest”. `jobs list/retry` is unchanged: it manages Leader
wake/recovery records and is not this Job module.

## Storage and existing consumers

Storage **1.8 → 1.9** appends two tables without modifying the published
baseline: `job_definitions` and `global_job_runs`. `durable_jobs` remains the
authoritative Task Run table, with `definitionId`, `definitionRevision` and
`trigger` added to each payload. This retains every Task-local Run ID and
artifact location. Global Runs have `scope:"global"` and no `taskId`, Task or
Assignment. They use the same execution state machine and supervisor; their
terminal notices enter the Operator mailbox, never a Task Leader mailbox.

The centralized transactional migration maps each old DurableJob to one
definition with the same local ID and one preserved Run. Equal commands are
not grouped. Original payload bytes are retained in `storage_migration_archive`
under migration 9 / family `durable_jobs`; old results, process evidence and
Integration references retain their identities. Frozen Context snapshots are
not rewritten. Ordinary readers accept only current storage; there is no
dual-format reader. A failed migration rolls back without advancing storage.
Actual Home upgrades require their own authorization and backup; this change
does not authorize or perform one.

IntegrationAttempt and verification consumers still use
`getDurableJob(taskId, exactRunId)`. Existing Task Context `job` entries,
execution audit, readiness/archive checks and HTTP preview tickets likewise
refer to exact Runs. Definitions alone never count as active execution or block
Task completion. Started Runs and retained unknown process evidence keep the
existing Task lifecycle and physical-cleanup boundaries. The management UI
is a separate feature; its consumers must not replace exact refs with latest.

## Extension seams for Schedule, Project refresh and management UI

- `src/job/jobDefinition.ts`: `JobDefinition`, `JobScope`, `JobConfiguration`
  and `JobTrigger`. Definition revision is optimistic concurrency, not a Run
  status. Project targets stay in configuration.
- `src/controller/jobDefinitionControl.ts`: `admitJobRun(store, home, scope,
  definitionId, caller, trigger, now, retryOf?)` returns `RunAdmission`.
  It authenticates current scope, rechecks domain prerequisites, finds exact
  trigger replay and excludes overlap inside the Store transaction. Schedule
  can call it inside its own `store.transaction` with advancement in that same
  transaction; no process starts until commit and supervisor reconciliation.
  A rollback discards both. `source:"schedule"` is an internal seam, not an
  accepted manual RPC assertion. Schedule must supply a legitimate current
  authority; it must not invent a Session or reuse a revoked identity. Any
  additional durable scheduled-intent authorization belongs to that feature.
- `src/job/builtinJob.ts`: controlled action compilation. Add a narrowly
  validated builtin here; snapshot its target/input and compile runner steps
  from trusted code, never caller-supplied shell. Revalidate before spawn.
  A non-Git action uses an explicit all-zero `head` sentinel, never a Project
  commit or Integration proof.
- `JobRun = DurableJob | GlobalJobRun` shares transitions, heartbeat, timeout,
  cancel, checkpoints, exact OS identity and unknown-effect recovery. Store
  methods preserve distinct scope storage; neither table mirrors the other.
- `createJobDefinitionControl` backs CLI JSON reads/mutations. A future
  authenticated Web ingress must resolve its own caller and enforce these
  service boundaries; it must not forward arbitrary browser-supplied identity.

No cron parser, due-time calculation, background queue, independent daemon,
cross-Task dependency engine or release behavior is introduced here. Subsequent
persistent changes must append after 1.9, not claim the same migration number.
