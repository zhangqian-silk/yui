# Job definitions and exact execution Runs

A Job is a stable, scoped definition. A JobRun is one execution, with its own
ID, configuration revision, trigger, immutable execution specification,
process or exact Agent execution identity, artifacts and terminal result. Changing a definition never
changes an admitted Run. No Schedule is needed for immediate execution.

## CLI and ownership

### Optional Agent execution

An Agent configuration selects a logical target, never a permanent native
Session: `{kind:"operator"}`, `{kind:"task",taskId,roleName,ownerRunId?}`, or
`{kind:"job",agentId}`. Non-Leader Task targets require the current Assignment's
exact `ownerRunId`; this does not create or delegate a Task. Task-owned Jobs
cannot target Operator or another Task. Job-owned Agents reuse ordinary Global
Role transport but have only their own Job's read/report authority, not
Operator or Project authority.

```sh
yui job define --global --job analyze --title "Saved analysis" \
  --input '{"kind":"agent","target":{"kind":"job","agentId":"codex"},"input":"Analyze the saved evidence."}'
yui job session-create --global --job analyze
yui job run --global --job analyze --request-id first
yui job run-context --global --job analyze --run <run-id>
yui job run-evidence --global --job analyze --run <run-id>
yui job session-inspect --global --job analyze
```

`session-create` prepares the logical Role; the normal Host creates its Session
on delivery. Launch messages contain exact context pointers. The executing Agent
uses `run-claim`, reads `run-context`, then `run-report --result <JSON>` with the
normal `JobBusinessResult` envelope (`schemaVersion`, exact `sourceRun`,
`outcome`, `summary`, `evidence`). Reports require that caller's current accepted
native Turn to own the original message. The Provider observation path retains
actual attempts and terminals even when no report is returned. Delivery, native
terminal and explicit business result remain separate facts. `run-confirm`
only collects existing evidence; it never replays work.

Default execution is serial per Job, reusing its Role Session across Runs.
Explicit `concurrency:"isolated"` is supported only for Job-owned Agents and
creates a distinct Role/workspace for each Run; sibling Run contexts remain
inaccessible to that executor. Existing Provider single-writer and bounded
classified retry rules still apply. Agent Jobs currently use explicit
manual/retry admission; a Schedule service grant for engineering actions is
not authority to execute an Agent.

`run-cancel` records a cooperative request on that exact Run. It does not
interrupt a shared Operator/Task Role or imply that work stopped. Check
`cancelRequestedAt` before effects and report the actual outcome. An unfinished
business Run can use `run-continue --expected-attempt <prior-attempt-id>` only
after its exact native terminal; this
adds an original continuation message to the same Run, not a new failed-Run
retry. Repeating the same expected attempt returns the existing successor
without submitting another message. Inspect prior effects first: terminal does not undo them.

For a Job-owned Session, `session-stop --expected-session <native-id>` requests
existing lifecycle cleanup only after the current native Turn is terminal.
It returns acceptance, not proof of stop. Inspect until the original Session
is ended, then `session-new --expected-session <native-id>` preserves its
history and clears the current Session for the next normal launch.
Isolated Jobs also require `--run <run-id>` on Session operations.
Unknown delivery and unproven old writers block replacement/continuation;
replacement never resubmits input. Definition snapshots, Run requirements,
explicit results and fixed artifact references survive independently of the
transcript. Shared targets use their existing Role lifecycle, not Job-owned
Session operations. CLI and `job.definition` RPC expose the same operations.
Changing the executor kind requires a new Job ID; revisions can change its
configuration without hiding another executor's original history.
Task-owned Agent Jobs participate in Task completion/ordinary archive settlement.
Archive also requires exact native-terminal evidence; an explicit business
report alone never proves quiescence. Idle Job-owned Role Sessions and their
separate scratch workspaces are retained, not silently deleted by Task archive.

### Engineering execution

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
persistent Schedule grant: public `source:schedule` admission is rejected.
The separate [Schedule management API](schedules.md) offers an explicit
revocable service grant without an Operator Session; existing plans retain
their Session authority until deliberately rebound.
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

## Formal file artifacts

Jobs can save formal material without a Task or Session. The existing
`job.definition` RPC also accepts `artifact-save`, `artifact-list`,
`artifact-read`, `artifact-preview` and `artifact-register`, with the same
`scope`, definition `id`, exact `runId` and authenticated `caller` boundaries.
The CLI resolves that caller; do not supply or fabricate one:

```sh
yui job artifact-save --global --job probe --run <run-id> \
  --artifact '{"relativePath":"reports/result.md","content":"# Result\n\nEvidence","message":"Record result"}'
yui job artifact-list --global --job probe --run <run-id>
yui job artifact-read --global --job probe --run <run-id> \
  --reference '<exact reference object returned by save/list>'
yui job artifact-preview --global --job probe --run <run-id> \
  --reference '<exact registered reference object>' --offset 0
yui job artifact-register --global --job probe --run <run-id> \
  --reference '<exact already-saved reference object>'
```

Save input also accepts `expectedHead` for optimistic concurrency and
`encoding:"base64"` for static PNG/JPEG/WebP. The shared repository accepts
text up to 8 MiB and decoded images up to 4 MiB, with dimension/format
validation; Job reference paths are limited to 512 characters.
The **Job CLI/RPC save payload is additionally limited to 256 KiB of encoded
JSON; read/preview responses allow 512 KiB** to include the added reference and
presentation metadata. Both count JSON escaping/base64 inside the Controller's
1 MiB envelope. The CLI checks saves before
transmission. Larger producer-saved or delegated Task material may still be
registered by its small exact reference: use paged preview for large text,
or the owning Task's surface for larger images. No file is truncated.
Preview otherwise shares the Task preview rules: whole Markdown up to
256 KiB, paged text (12,000 characters with `nextOffset`), static raster
metadata/base64, and no SVG or executable HTML. HTML is text data, never
executed; clients must use the existing safe renderer.

Save/register returns `{status:"registered",reference}` only after the file is
committed **and** the Run reference is recorded. If the commit exists but
publication fails, it instead returns
`{status:"saved-unregistered",reference,error,recovery}`. This is partial
success, not a published result. Inspect the exact Run and `artifact-list`,
then explicitly register the retained reference. Never retry the business
action to repair missing material registration. A lost RPC reply is unknown:
inspect first. Git save failures preserve written working files and existing
commits; expected-HEAD conflicts write nothing.

A reference is:

```json
{
  "kind": "artifact",
  "owner": {"kind": "job", "scope": {"kind": "global"}, "jobId": "probe"},
  "sourceRun": {"scope": {"kind": "global"}, "runId": "<exact-run-id>"},
  "version": "<full Git commit>",
  "relativePath": "reports/result.md",
  "digest": "<SHA-256 of file bytes>"
}
```

Unlike process-evidence `version` (SHA-256), an artifact's `version` is a full
Git commit; its separate `digest` checks content. Reads require a registered
exact reference, never HEAD, an ambient Task, or a bare filename. A Run's
`artifacts` is an append-only list: later saves cannot replace earlier entries.
The original `businessResult`, `result`, outcome and terminal evidence remain
unchanged when material is collected after execution.

Repositories live under
`YUI_HOME/job-artifacts/global/<job-id>/<run-id>/` or
`YUI_HOME/job-artifacts/task/<task-id>/<job-id>/<run-id>/`.
Each Run has a distinct worktree and scoped commit lock, so even the same
definition/path in concurrent Runs or different scopes cannot overwrite one
another. They reuse the Task repository's local-only Git, path/symlink guards,
size limits and commit protocol. Task repositories stay at their existing
`task-artifacts/<task-id>` paths; all old commit-pinned Candidate, Review and
completion references remain valid.

`artifact-list.artifacts` lists **published** references.
`repository.saved` describes the retained current Git snapshot for diagnosis
and explicit registration; it is not publication. `repository.workingChanges`
distinguishes uncommitted files. `job runs` and `run-result.artifacts` retain
history; `job show`/`list` derive `results.latest` and
`results.latestSuccessful` independently from readable Runs. A later failure
does not hide the last success. Same-name versions are the entries with that
`relativePath` across these Run histories, not a separately writable final file.

For delegated Task material, an authorized Leader or Operator explicitly
registers `owner:{"kind":"task","taskId":"task-N"}` with the selected original
commit/path/digest and the consuming Run's `sourceRun`. Registration must pass
both the Run's existing Assignment checks and the source Task's authorization.
An Assignment reader cannot mint this selection. Subsequent Run readers may
read **only that selected immutable object**, not the Task's HEAD, other
files, or writes. The file stays in the Task repository; no copy or authority
transfer occurs. The old same-Task `git:<commit>:<path>` shorthand is not
accepted as a cross-entity reference. Task delegation admission itself belongs
to its separate feature; this is the selected-material seam.

Storage **1.16 → 1.17** declares the optional append-only Run references and
Job-owned repository layout. It preserves existing payload bytes, process
history, Task repositories and frozen references, and invents no historical
artifacts. This is not a package-version release or an automatic Home upgrade.

Formal repositories and referenced objects are retained by default. Replacing
a Session, removing execution workspaces/logs, disabling a Schedule or ordinary
Task archive does not delete them. There is no automated artifact GC or delete
command. Manual cleanup requires separately authorized inspection of exact
owners and references; do not remove repositories/commits still referenced by
Runs, Candidates, Reviews or completion evidence. Retain uncertain ownership
and unregistered/dirty evidence for diagnosis. This does not turn logs,
heartbeats, checkpoints, Knowledge or Project state into formal artifacts.

## Extension seams for Schedule, Project refresh and management UI

- `src/job/jobDefinition.ts`: `JobDefinition`, `JobScope`, `JobConfiguration`
  and `JobTrigger`. Definition revision is optimistic concurrency, not a Run
  status. Project targets stay in configuration.
- `src/controller/jobDefinitionControl.ts`: `admitJobRun(store, home, scope,
  definitionId, caller, trigger, now, retryOf?, service?)` returns `RunAdmission`.
  It authenticates current scope, rechecks domain prerequisites, finds exact
  trigger replay and excludes overlap inside the Store transaction. Schedule
  can call it inside its own `store.transaction` with advancement in that same
  transaction; no process starts until commit and supervisor reconciliation.
  A rollback discards both. `source:"schedule"` is an internal seam, not an
  accepted manual RPC assertion. Schedule must supply a legitimate current
  authority; it must not invent a Session or reuse a revoked identity. Any
  service reference is internal only and must match a current stored Schedule
  grant; RPC never accepts it. `instantiateJobRun` owns deterministic instance
  creation from an exact definition revision and composes the same admission
  inside the caller's transaction. Instance creation, first Run and Schedule
  advancement either all commit or all roll back.
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
