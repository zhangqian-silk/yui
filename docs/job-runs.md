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
yui job run-result --global --job probe --run <exact-run-id>
yui job run-evidence --global --job probe --run <exact-run-id>
yui job run-confirm --global --job probe --run <exact-run-id>
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

Global Job management accepts public local callers or the current authenticated
Operator Session. A public caller uses `scope:user` with no managed identity
fields. The normal CLI first resolves native conversation identity against the
selected Home: unknown provider conversations remain public, while known
managed, historical, partial or revoked identities never fall back to user.
The local Controller socket is a single-user Home boundary, not a remote
authentication endpoint; `scope:user` is not a token granting Task or shell access.
Other GlobalRoles cannot inspect or manage Task Job definitions either, matching
the existing Task Context authorization boundary.
Public immediate admissions bind the exact Home, Run, definition revision,
target/input and trigger; they need no Agent configuration, Operator, Session
or empty Task. They do not enqueue an Agent wake on completion. This is not a
persistent Schedule grant: public `source:schedule` admission is rejected and
Schedule management retains its existing Session authority until its own change.
Task Sessions cannot inspect,
create, modify or run global Jobs. The initial global action is `system.noop`,
a fixed local no-op implemented by the same standalone runner. It accepts only
empty input and no Project; it does not call a model or external service.
`project.refresh` is the controlled Project maintenance action below. Arbitrary global commands,
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
Operator-admitted terminal notices enter the Operator mailbox, never a Task
Leader mailbox. Public immediate Runs are read directly without Agent delivery.

The centralized transactional migration maps each old DurableJob to one
definition with the same local ID and one preserved Run. Equal commands are
not grouped. Original payload bytes are retained in `storage_migration_archive`
under migration 9 / family `durable_jobs`; old results, process evidence and
Integration references retain their identities. Frozen Context snapshots are
not rewritten. Ordinary readers accept only current storage; there is no
dual-format reader. A failed migration rolls back without advancing storage.
Actual Home upgrades require their own authorization and backup; this change
does not authorize or perform one.

Storage **1.14 → 1.15** adds `businessResult` to terminal Run payloads and public
immediate authority bindings to new Runs. Original terminal payload bytes are
archived under migration 15; the migration derives only the recorded outcome
and a versioned reference to the unchanged process result. It never parses logs,
invents domain data, rewrites Integration references or changes active Run
identities. Ordinary readers use only the current contract.

## Business outcome and evidence

`run-result` returns the admitted snapshot, `acceptedAt`, `startedAt`,
`confirmedAt`, current `status` and nullable `result`. Acceptance is not start;
start is not confirmation. The snapshot is derived exclusively from the immutable
Run fields, never a mutable current Job definition. Scope, executor (`shell` or
controlled `builtin`), target and trigger are separate concepts. Current permitted
combinations remain Task shell and global builtin; there is no extensible empty
executor/plugin configuration or arbitrary global shell.

`JobBusinessResult` has `schemaVersion:1`, exact `sourceRun:{scope,runId}`, an
`outcome`, human-readable `summary`, optional JSON `data`, and `evidence`.
Each evidence reference carries `kind`, `owner`, `sourceRun`, a SHA-256 `version`
of the referenced bytes, and `locator`. These are evidence references, not a file
artifact library; future file artifacts must preserve their own owner/version
and source Run rather than treating a path as identity. Results are bounded to
256 KiB. Shell results describe the process contract only; they cannot infer
domain success from arbitrary log text. `system.noop` reports its controlled
action. Project refresh reports observed commits/tracking and domain failures.

`run-evidence` returns the exact operation receipts, PID/start identity,
checkpoint, `processResult` and artifact location. The existing Run `result`
field remains the original process evidence for Integration and existing readers;
`businessResult` and `status` represent business outcome. A successful process
does not prove a builtin business effect: missing/invalid business receipts yield
`unknown-needs-attention` and block overlap/retry. Historical results contain
only what their saved evidence proved, without invented structured data.

The Project action writes `business-result.json` separately from stdout.
Failure to save it after an effect is unknown, not an automatically retryable
failure. A database collection failure leaves the original receipt and active Run
available for later collection. `run-confirm` authenticates the exact Run and
collects only retained ready/exit/checkpoint/business evidence; it never admits,
spawns, retries or cancels an action. Repeated confirmation is idempotent.
Terminal outcomes remain immutable; acknowledging an unknown is not success
and does not authorize replay. There is no caller-supplied outcome override.

IntegrationAttempt and verification consumers still use
`getDurableJob(taskId, exactRunId)`. Existing Task Context `job` entries,
execution audit, readiness/archive checks and HTTP preview tickets likewise
refer to exact Runs. Definitions alone never count as active execution or block
Task completion. Started Runs and retained unknown process evidence keep the
existing Task lifecycle and physical-cleanup boundaries. The management UI
retains exact references rather than replacing them with latest.

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

The independent [Schedule module](schedules.md) adds time rules and transactional
due admission after this 1.9 foundation. It does not introduce an independent
daemon, cross-Task dependency engine or release behavior.

## Controlled Project refresh

A public local caller or authenticated Operator can explicitly install one maintenance definition
per registered managed Project, inspect it, and request independent Runs:

```sh
yui job define --global --job project-refresh-project-7 --title "Refresh Project 7" \
  --input '{"kind":"builtin","action":"project.refresh","projectId":"project-7","input":{}}'
yui job show --global --job project-refresh-project-7
yui job run --global --job project-refresh-project-7 --request-id refresh-001
yui job runs --global --job project-refresh-project-7
yui job run-get --global --job project-refresh-project-7 --run <exact-run-id>
yui job logs --global --job project-refresh-project-7 --run <exact-run-id>
```

These examples configure intent; installation, migration and Project registration
never install or run a default Job or Schedule. Task Sessions cannot use this
entry point. The Job remains global; `configuration.projectId` identifies its
target, not an owning Task. Duplicate refresh definitions for the same Project
are refused with the existing Job ID; `job list --global` also discovers it.

Empty action input explicitly binds the current catalog's Project ID, path,
ownership, lifecycle, remote URL and stable/development branches into
`input.targetDigest`. The digest is generated from authoritative configuration,
not a caller-supplied checkout path. Each Run retains this immutable input.
Admission, pre-spawn authorization and the domain action after lock acquisition
recheck the current target. Missing/retired/external Projects and changed targets
fail closed. After inspecting an intentional configuration change, use
`job update --revision <observed-revision>` with the same action and empty input
to bind it explicitly. Run/retry never silently rebinds an old definition.

`project refresh <project>` and the Job call the same Project domain service and
maintenance lock. The existing manual external-Project behavior is unchanged;
automatic writes require active **managed** ownership. Both require matching
stable and development branches. Git checks clean/untracked state, exact branch
and HEAD; fetch isolates FETCH_HEAD, unrelated tracking refs and maintenance;
only verified fast-forward and compare-and-swap tracking updates are allowed.
There is no reset, rebase, guessed checkout, user remote rewrite or semantic
Knowledge/Skill update. Lock waiting is bounded and never retries the Git action.

The existing detached Job runner invokes a fixed Project-domain executable.
That action reads current catalog/Run authority through a read-only Store and
writes Git only through the shared service. The generic runner remains
artifact-only. Runtime-owned PATH, HOME, SSH agent socket and Git config
locations are passed for Git discovery/authentication; callers cannot supply
commands or environment. Interactive Git prompts are disabled, and the action
has a ten-minute timeout. At most four supervised Project refresh attempts
are started concurrently; one Project's failure does not stop another.
Cancellation/timeout uses the existing process-group and unknown-effect contract.

For UI consumers (Task129), the action label is `project.refresh`, target is
`configuration.projectId`, and `job show/list` adds a **derived** `refresh`
projection with `lastAttempt` and `lastSuccessfulRefresh` exact Run references,
revision, trigger, status and timestamps. It is not separately stored.
A projection includes only refresh Runs for the definition's exact Project and
target digest; changing action or rebinding a remote/path/branch does not inherit
another target's successful observation. Full history remains in `job runs`.
A failed or unknown attempt never advances success. The Run supplies trigger
source, status, terminal error and artifact identity. `job logs` returns bounded
step output: successful refresh JSON contains `projectId`, `trigger`, observed
time, verified remote commit and `refresh.fromCommit/toCommit/tracking`.
Git-stage failures include `details.refresh` with observed partial HEAD/tracking
effects and any retained temporary ref. Earlier refusals have no successful
remote observation. Missing exit evidence, timeout or cancellation must not be
presented as successful synchronization; inspect retained evidence before retry.
The Run's all-zero `head` is not a Project revision; use the action's observations.

Action input uses the existing JobDefinition configuration; structured output
uses the 1.15 business result alongside unchanged process evidence/logs.
Schedule should reference this same
global definition and use its existing admission seam, never a second Project
automation state. The isolated core scenario covers interval-triggered refresh
Runs, missed-period coalescing and disable behavior against a local Git remote.
This does not enable a cadence for any real Project.

## Local Web management

The Task's **Jobs** tab manages only that Task. **Settings → Jobs & schedules**
manages global definitions. Both use the same component and public services.
Create/edit a definition, run it immediately, select an exact historical Run
and read its snapshot/results/logs, or request cancellation of that Run.
Task shell configuration uses the same explicit managed-workspace specification
as the CLI; global creation offers only `system.noop` and `project.refresh`.
Creating or reading a Job never executes it.

The HTTP routes are `/api/tasks/:taskId/jobs|schedules` and
`/api/settings/jobs|schedules`. GET takes `op`, `id` and optional `runId`; POST
takes the corresponding public operation fields, with `requestId` for manual
Run admission. Routes fix scope. Browser-supplied `caller`, `scope` or trigger
authority is rejected. The loopback token authenticates the local-user ingress,
and writes additionally require an exact same Origin. The adapter resolves the
current Operator Session from the server store on every call; if none is
available, management reports that prerequisite rather than fabricating one.
Its accepted Jobs/Schedules retain the normal Operator binding/revocation
semantics. Managed RPC callers retain their existing authentication and cannot
borrow this local-user adapter.

Schedule forms support once, anchored interval and five-field cron with an
explicit timezone. Displayed next due and last success come from the service.
Disable affects future admissions, cancellation affects one exact Run, and a
manual Run does not move the cadence. Once `completed` means admitted, not
successful. Errors retain the draft; an unknown write is not automatically
resent. Refresh only reads facts and keeps the selected Run exact. No new
tables, scheduling loop, Project switch, implicit refresh or deletion semantics
are introduced.
