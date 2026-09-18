<p align="right"><strong>English</strong> | <a href="./release-workflow.zh-CN.md">简体中文</a></p>

# Authorized release operations

A release workflow is an explicitly chosen, authorized sequence of
external release effects — pull requests, CI confirmation, merges, version
tags, npm publishes, fresh-install smoke tests, CLI updates, Controller
replacements, Project migrations, and post-verification. It is a specialized
external-effect facility, not Yui's Task planning or Agent execution model.
The Agent selects a predeclared plan, and the facility drives that plan
from durable state: every transition is persisted before the next external
call, so a crash, timeout, or revoked grant never leaves the release guessing.

Two task-level record families back it:

- **CapabilityGrant** (`capability-grant-N`) — the authority. A named granter
  scopes a grant to actions, parameter bounds, an expiry, a use count, and an
  irreversibility ceiling.
- **ReleaseWorkflow** (`release-workflow-N`) — the plan and its progress: an
  exact source (repository + pinned commit, optionally an artifact), an
  immutable ordered step plan, and one persisted record per step.

The engine (`src/release/releaseWorkflowEngine.ts`) owns persisted transitions and the workflow lock; the
`yui task workflow` and `yui task grant` commands drive it. Every external
system sits behind `ReleaseWorkflowPorts`
(`src/release/releaseWorkflowPorts.ts`). Disposable SQLite and deterministic
external ports exercise recovery without real GitHub, npm, git, Controller,
or model effects.

## Final historical bridge: 0.16.2

| Release | Home storage | Responsibility |
| --- | --- | --- |
| **0.16.2** | Historical v37, supported floor v1 | Last complete historical upgrade chain (v1 through v37). |
| **1.0.0-alpha.1** (planned) | A distinct new 1.0 baseline | Publish an independent, explicit offline converter from verified historical v37. |
| **1.0.0** (planned) | The same verified 1.x contract as the final prerelease | Remove converter source after durable publication; never reset storage again. |

0.16.2 supersedes the 0.99.0 release designation without reverting its functional
changes or Git history. Both use the same v37 endpoint. Publish and verify this
replacement before withdrawing the 0.99.0 registry version, Release and tag.
Do not automatically downgrade a local installation or change its Home.
Stable releases explicitly publish to npm `latest`; prereleases publish to
`next`, so the new baseline is opt-in.

0.16.2 freezes the historical endpoint at **37**. It does not append a no-op
migration, rewrite released SQL/data migrations, reset record-local schema or
protocol versions, or reinterpret historical evidence. Fresh and upgraded Homes
use the same contract. Ordinary opens still reject historical formats; only
explicit `upgrade` / `update` may migrate them.

### Select the bridge explicitly

In 0.16.2, `yui update --version 0.16.2` selects an exact published
package; no argument still selects `latest`. Tags and ranges are not accepted
as explicit selectors. The actual staged version must equal the requested
version before preflight or Controller handover. A mismatch cleans only the
owned staging prefix, leaving the installed binary and database unchanged.

Older CLIs do not acquire this option until updated. Once 0.16.2 is published,
use a separately staged, exact 0.16.2 CLI to drive the update against an explicit
`YUI_HOME`. For example, npm can stage it without replacing the global install:

```sh
YUI_HOME=/absolute/path/to/home npm exec --yes --package=@zq-silk/yui@0.16.2 -- \
  yui update --version 0.16.2
```

Do not replace the live global binary first or assume `latest` will continue
to select the bridge. Preserve target-owned `upgrade --update-preflight` /
`--update-apply`: refusal happens before activation, and preflight is repeated
under the handover fence after draining the exact Controller. The older-updater
recovery guidance below still applies when invoking an older updater.

### Inspect and preserve the old endpoint

With the published 0.16.2 CLI and the intended `YUI_HOME`, use the existing
`yui --json version`, `yui --json upgrade --dry-run`, `yui --json doctor`,
`yui --json controller status`, and `yui session reconcile --report` reads.
After the old-chain upgrade, the upgrade report must be `already-current` at
storage 37; `upgrade-plan` only describes pending migrations. Neither report
proves physical quiescence or readiness for the new storage 1.0 cutover.
Do not add a durable "ready for 1.0" flag or a second version authority.

Before the later offline cutover, settle active work using its original
contract. `yui session stop --all` explicitly stops idle managed Sessions and
the Controller; it is not a force stop or proof that detached Jobs and unknown
resources have exited. Inspect exact ownership and pending effects. Never mark
Tasks complete, acknowledge uncertain work, or delete resources just to pass an
upgrade. The future converter must recheck quiescence under its fence.

Retain the **exact published 0.16.2 package**, its existing release manifest,
registry integrity, tag/source commit, and this guide as the historical bridge.
The existing package inventory pins compiled migrations and their helpers;
an expiring CI artifact alone is not a long-term distribution. This release
introduces no additional Home metadata or migration registry.

The 1.0.0-alpha.1 converter must preserve old ledger/audit bytes, Home identity,
business IDs, records, Knowledge, workspaces (including dirty files), and
unconfirmed external effects. A database-only backup cannot fully roll back old
layout migrations with filesystem/Git effects. Unknown or malformed old formats
remain blockers. New storage 1.0 must have a distinct baseline identity, never the old
`v0.15.0-baseline`. Its SQL/fingerprint and final conversion tool belong to
1.0.0-alpha.1, **not this release**; it accepts verified old v37 rather than carrying
the complete old chain.

The new storage uses major.minor versions; default upgrades allow only explicit,
contiguous minor steps within the same major. Any persistent change during
prereleases must declare a new minor transition, never silently rewrite a
published baseline. The stable release reuses the final verified contract.
Publish the converter and checksum as durable prerelease attachments before
removing their source. Never include conversion code in the runtime tarball or imports, retaining current
initialization, validation, unknown-format rejection, exact runtime identity and
normal safety/recovery. Users skipping the bridge must still use the frozen
tools; 1.0.0 must never guess an old format.

## Controller handover fix in 0.16.1

Controller status and storage preflight are observations, not cleanup. The
authorized updater explicitly runs its bounded current-Home reconciliation
under the handover fence before capture/stop. It retains the existing four-pass
rule and process-start/inode checks, preserving current Controllers and excluding
Agent/tmux/app/foreign-Home resources.

Update results and release-step logs retain reconciliation targets, completed
actions, original cleanup errors, the last inventory with its observation time,
and failed observations or lock release. Captured-identity restoration reports
success or unknown effects separately. An uncertain cleanup/restore is not a
stopped Controller or replayable failure; inspect the exact resource before
choosing recovery. No new recovery worker or persistent protocol is introduced.
The staged `--update-preflight` / `--update-apply` contract is unchanged.

The updater's stop and exact-identity restoration children now explicitly receive
the parent updater's handover-lock owner identity. They no longer wait on their
own parent's lock; unrelated callers remain fenced. Storage remains at version 37.

An already-installed older updater, including 0.15.12 or 0.16.0, cannot gain this
fix merely by staging the new package. If it reports `CONTROLLER_HANDOVER_TIMEOUT`
before activation, inspect the original Controller and lock ownership. Once the
failed updater has released its own lock and the original Controller is confirmed
healthy, normally stop it with that installed release's `yui controller stop`,
then retry `yui update`. This preserves managed Agent Sessions and retains the
normal preflight, backup, migration and verification boundaries. Do not delete
an active lock or force-kill a Controller to bypass the failure.

## Pre-1.0 contract cleanup

Version 0.16.0 retires runtime compatibility before the final
1.0 baseline cutover. It does not reset storage numbering.
Storage 27→28 normalizes only provable singleton Role dispatch dedupe keys;
the old migration ledger, Messages, Task results and unconfirmed effects remain
unchanged. Ordinary opens require storage 37. Existing Homes advance only through
the explicit upgrade boundary; no runtime dual-reader is added.

This is a breaking pre-1.0 change:

- `message send` uses `--intent`; `--wake-policy` is no longer accepted by the
  CLI or capability API. Draft edits preserve intent.
- Internal command integrations implement `notifyMailboxChanged`; the Task-only
  notification adapter has been removed with its callers updated.
- ACP peers must report `configOptions`; there is no `modes`/`set_mode` path.
- Release recovery requires a pinned Home and installation prefix. Unpinned
  identities remain unknown, and incomplete handover locks remain fenced.
- Development link/unlink requires the current registry. It does not discover
  or adopt older NVM registrations or reconstruct orphan links.
- GC no longer discovers retired deployment layouts or reconstructs removed
  worktrees. Unsupported quarantine evidence is retained, never purged as if
  it were a current move receipt.
- `task activate` consumes an existing request; no request means no resource
  adoption. Request creation, deferred admission and atomic workspace adoption
  remain separate, using the same current boundary.
- `task integration queue` and its state machine are removed. The Agent chooses
  each WorkItem result's order and strategy and calls the atomic Integration
  operations; exact checks, target CAS and completion obligations remain.

Storage 28→29 preserves every former queue payload verbatim in a Task event
`integration.queue-retired`, with its original queue ID, before dropping the
active table. Event IDs advance past both the stored counter and existing
history. This does not accept delivery, generate an Integration or replay work.
Existing Integrations and Jobs stay intact. Inspect `task event list <task>`
and the referenced WorkItem/Integration before deciding what remains to do;
retiring the queue does not settle an unfinished Integration.

Storage 29→30 retires Run-linked wakes into `wake.run-link-retired` Task events
with the complete original payload. Current notification IDs, delivery status
and references remain intact, using wake schema 2; Run termination no longer
consumes notifications. Live Runs, owned retries and unresolved claims referring
to a retiring wake block both preflight and migration. The migration does not
stop execution or fabricate acceptance. Global Session sets use an explicit
`providerBinding: null` when no controlled binding exists.

Storage 30→31 makes every Review's scope explicit. Missing/null scope in a valid
older WorkItem Review becomes `work-item`; Task-final candidate evidence and
the old ledger are unchanged. New and retried Reviews always write their scope.

Storage 31→32 removes WorkItem `historicalState` from the current record.
Before removal, the entire original payload is preserved verbatim in a
`work-item.execution-state-retired` Task event. Current status, scope, Candidates
and execution groups are unchanged; no Run or acceptance is created. Unrecognized
historical shapes fail without changing the record or advancing the ledger.

Storage 32→33 retires the Leader rollout/budget settings and VerificationPlan
rollout modes. Active plan bodies gain an explicit schema version; their checks
remain unchanged, while retired Knowledge bodies are preserved. Integration
records gain explicit `rerunChecks: false`, and shadow reuse counters are removed
from cached artifacts. Original settings remain recoverable from the explicit
upgrade backup. This is an approved behavior change, not an assertion that
`record`, `reuse` and `enforce` meant the same thing.

Admitted `running`/`validating` plan gates block preflight and migration; settle
them with the old release first. No in-flight Job is relabelled under the new
proof contract. That cutover's v3 verification-plan digest excluded older cache entries from
automatic reuse without rewriting historical Job/Integration results or deleting
their logs. Historical plan interpretation is frozen inside the migration
directory so earlier migrations keep their original semantics.

The current clean-candidate proof uses a v5 L2-only execution digest. Both local and
Job-backed verification check candidate cleanliness, branch and exact HEAD
before publishing reusable success; older cache identities cannot silently pass
this boundary. Existing records/logs remain readable and admitted Jobs are not
relabeled under a new digest. Settle old attempts with their matching contract,
or explicitly abandon them before starting another operation.

The L1 runner, selector and current plan/artifact type branches are removed.
Storage 34→35 archives the original Project plan payloads and L1 artifacts/logs
in `storage_migration_archive`, then adopts VerificationPlan schema 2 without L1.
The archive is raw audit data, not an alternate execution reader or cache.
Settled historical ChangeSet-source Integrations become full-payload Task Events;
live workspaces, unsettled Jobs and adoption references block their retirement.
The complete earlier migration ledger remains unchanged.

Session custody now has one source, SQLite. Legacy `launch-env` owner rows or
files in `runtime/session-owners` block this cutover: use the old release to
inspect and settle their exact resources, then explicitly archive obsolete
files outside the active Home. The migration does not kill, infer ownership,
repair malformed records or rewrite immutable Session Manifests.

Storage 35→36 preserves historical Agent errors and explicitly marks missing
failure configuration as unavailable. Storage 36→37 narrows recorded failure
context to native metadata-query inputs, preserving the original snapshot and
empty optional identity placeholders in migration audit. Current error readers
do not depend on the execution snapshot protocol or reconstruct missing history.
Configuration rejection preserves input without automatic retry; an authorized
Agent can inspect failure-scoped model capabilities, correct the intended
configuration, and explicitly retry the rejected notification.

`task turn` and the `yui-dev` completion identity are no longer supported.
Before rollout, replace Sessions whose old Manifest still names `task turn`,
and explicitly remove/archive old `yui-dev` completion blocks before installing
current `yui` completion. User shell files are never rewritten by storage migration.
Current Host control/event validation and updater handover safety remain enforced.

Storage 33→34 removes Message `wakePolicy` and activation `origin` from current
records, preserving their original representations in audit Events. Historical
save-only Messages become `intent: record`; other user/operator Messages without
intent become `discuss`. Runtime readers never infer a missing stored intent.
Editing record-only context does not wake the Leader. Completion reads actual
pending message references, including an explicit handoff of previously saved context.

Draft editing also preserves request identity: messages bound to submission,
queue/steer or handoff requests cannot change body in place. Use a new Message
and request ID; identical-body updates are no-ops. Unkeyed discussion edits
honor pending/failed activation, while develop edits never start planning or
create/retry activation. These are operation-boundary fixes, not a new storage
format or a repair of previously edited historical content.

An origin-less pending immediate Draft activation blocks preflight and migration,
including on a stopped Task. Activate or cancel it explicitly with the old release
first. An admitted current request needs no second origin gate: cancellation,
planning deferral, execution state and exact Session authority remain enforced.
Old origin metadata, including settled-request history, remains in
`task.activation-origin-retired` Events; this never fabricates authorization.

New `job start` calls require `--request-id`; RPC callers supply `requestId`, and
the capability boundary supplies its invocation identity. There is no implicit
content-addressed request or anonymous Job constructor. Existing Jobs retain
their operation evidence and remain addressable by ID. Retrying the same explicit
request is idempotent, changed input conflicts, and Integration recovery still
finds its original Job across Session replacement. Choosing a new request ID is
an explicit new operation, not recovery of an uncertain earlier result.

Core Scheduler readers and persistence operations are required ports. A missing
Session/event reader cannot be interpreted as empty evidence or skipped error
persistence. Task execution and Web projections read the current store directly;
queue admission requires its Task lifecycle read. Exact dispatch settlement
remains separate and does not gain an archive gate that could lose late evidence.
Observer, config, Knowledge and workspace-cleanup Store readers are also required;
test doubles implement those contracts rather than selecting production fallbacks.

Task listing and `/api/dashboard` now expose only the bounded catalog; remove
`--view compact` from callers and use per-Task reads for detail. Scheduler
catalog projections are required internal ports, not optional full-scan adapters.
Extra `schema.json`/`state.json` files cannot override SQLite's version or be
used to reset a development Home; upgrades leave unrelated files untouched.
A missing database in a non-empty Home remains a refusal to initialize.
Unrecognized writer leases are diagnosed without adoption or deletion.

`controller status` always reports identity and retains the nonzero health exit
for contradictory storage. `YUI_STATUS_IDENTITY` no longer selects another
contract. Update-owned lifecycle capture uses the same resource collector
directly, without requiring the old Home to pass current-schema health.

Additional current boundaries:

- Project/artifact file locks and handover locks require exact process-generation
  evidence. Missing/invalid owners or unreadable OS identity remain fenced;
  age alone never proves a creator exited. No PID-only positive fallback remains.
- PR head lookup uses one `gh pr list --head ... --state open` query. Only an
  empty, valid array proves absence. Transport errors, malformed identities and
  multiple matches fail without attempting creation.
- Existing Git operations cannot be adopted without the Integration's original
  progress receipt. Preserve their files and diagnose explicitly; current
  receipt-backed conflict/Job continuation remains supported.

Before rollout, settle old executions and use explicit cleanup for unsupported
locks, links or quarantines. Preserve those records until their owner and
disposition are established; the runtime does not choose recovery for them.

The later baseline cutover must first establish a verified bridge/export to the
chosen current format, then replace the old initialization/migration chain with
one clean baseline. Only then remove pre-baseline migrations and their historical
fixtures. Reset the storage baseline once; do not reset it again when tagging
1.0.0. Keep unknown-version rejection, exact process/Host identity checks and
durable audit evidence. Version tags and real migration/publication effects
require their separate release authorization.

## Authorization model

Every (re)submission of a step passes `checkGrant(grant, request, now)`
(`src/grant/capabilityGrant.ts`) **before** the external call. The step kind
is the grant action: a grant lists the step kinds it authorizes, for example
`--action npm-publish --action version-tag`. The decision is fail-closed —
every denial carries a machine-readable reason and stops the run:

| Reason | Meaning |
| --- | --- |
| `grant-missing` | No grant record is bound to the workflow (engine-level). |
| `grant-revoked` | The grant was revoked by an operator. |
| `grant-expired` | The wall clock passed the grant's `expiresAt`. |
| `grant-uses-exhausted` | The grant's `maxUses` has been consumed. |
| `grant-action-not-allowed` | The step kind is not in the grant's actions. |
| `grant-parameter-missing` | A bounded parameter is absent from the step. |
| `grant-parameter-value-not-allowed` | A bounded parameter has an out-of-bounds value. |
| `grant-irreversibility-exceeds-ceiling` | The step is more irreversible than the grant's ceiling. |

Additional rules:

- **One use per authorized submission.** The engine records a grant use
  between the successful decision and the external call, so a `maxUses` grant
  fails closed on the attempt that would exceed it.
- **Irreversible steps need a confirmed prefix.** A step marked
  `irreversible` additionally requires every earlier step to be `succeeded`;
  otherwise the step fails with `prerequisite-not-confirmed` and the run
  stops. This is what keeps an `npm-publish` from running behind a failed PR.
- **Denials are recorded.** When a pending step is denied, the engine starts
  and fails the step with the denial in its log, so `workflow status` shows
  exactly where authorization stopped.
- **Rebinding.** A revoked, expired, or too-narrow grant does not dead-end
  the workflow. Issue a new grant and resume with
  `yui task workflow resume <task> <workflow> --grant <new-grant>`; the plan,
  source, and all confirmed step evidence are immutable across the rebind.

## Stable Task-final Review contract

Compatible CLI package updates and Controller replacements do not change an
active Task's final-review capability. Managed Sessions use the ordinary
`yui` command, compatibility is checked by protocol and storage identity, and
a replacement Leader presents the contract already established by durable Task
evidence. No version-aware Operator action is required.
Candidate and Task-final ReviewRound records must all carry that one contract.
Conflicting records fail closed; there is no rebind event, recovery command, or
second contract state machine.

## Current Agent Host boundary

A running Host keeps its original Endpoint implementation. It records exact
Session/attempt/native-Turn facts in the existing durable Inbox before contacting
the Controller; only the current Controller resolves Run ownership, validates
authority/workspace/lifecycle/history, and commits the result. An Inbox file is
not acceptance. Files are consumed only after commit, so downtime or a lost ACK
does not replay user input or model work.

Startup facts use the exact Run identity from the redeemed launch payload, not
the long-lived Session environment. This preserves pre-adoption evidence even
when the frozen Run workspace differs from the Role's default; later activity
and terminal facts still resolve solely by their own native input identities.

The current Host boundary is control `yui-agent-host/v5`, event source
`yui-agent-host-events/v1`, and Controller RPC version 4. Hosts do not open the
Home database, including for process custody, native account locations, or
execution-environment checks. Only the Controller owns storage and resolves
durable facts; malformed current input fails at its normal protocol boundary.

Breaking upgrades do not inherit historical Hosts or processes. Runtime startup,
`upgrade`, `update`, and release activation no longer scan old Host sockets or
processes, infer their capabilities, or negotiate a compatibility handoff. Use a
clean runtime environment; this is not permission to discard pending work or
kill resources of uncertain ownership. Current Controller restart, exact
process-generation checks, handover locks, Session authority and event replay
protection remain enforced.

Storage migration is separate: the complete 1..37 chain and updater
`--update-preflight` / `--update-apply` contract remain. Storage preflight is
rechecked at the fenced/quiesced boundary; no published migration is rewritten.
Session CLI refresh only retargets the current two-argument quoted wrapper
named by a valid Manifest. It does not convert retired wrapper forms. Runtime
diagnostics do not interpret `schema.json`, `state.json`, or a whole-map release
idempotency file; current SQLite data and per-key release receipts remain the
authorities, and unrelated files are left untouched.

`task role status`, `task role list`, and `task role session inspect` expose Host
reporting alongside durable Run state. Pending native results or known reporting
failures require attention; they do not mean the Provider failed, the Run ended,
or the work was accepted. The Host's live diagnostics inspect only its own event
file identities and never parse or quarantine another producer's newer payload.

## CLI and Controller release boundary

The global `yui` command is the stable user and managed-Session interface. It
does not follow `runtime/active-release.json` for ordinary commands: that
pointer selects the Controller release, not the CLI package. This keeps CLI,
Operator Session, and Controller replacement compatible without pinning every
command to one immutable build.

A source-checkout or otherwise unverified local CLI is not this published
interface. When `YUI_HOME` already names an active release, such a CLI fails
before opening storage and reports its build/source, the durable Home identity,
and its invocation class. `make install-local` continues to default to the
checkout's isolated `output/dev/home`; explicitly pointing that launcher at a
release-owned Home is rejected.

An explicit `yui release activate <release-id|build-id>` is the one exception.
The global CLI verifies the installed target release and its matching smoke
receipt, then delegates the unchanged activation arguments to that target's
`dist/cli.js`. The target release therefore owns the complete handover protocol
and timeout hierarchy. A no-target activation, help, `--json`, and every other
command remain on the global CLI. Activation does not add another ordinary CLI
routing path.

## Step catalog

The plan is a fixed, predeclared subset of operations. Each plan entry has an
id (unique within the workflow), a kind, optional params, and an optional
irreversibility level (`none` | `reversible` | `irreversible`).

| Kind | External effect | Authoritative identity |
| --- | --- | --- |
| `pr-create-or-reuse` | Creates the release PR, or reuses an open one for the head. | `pull-request` number |
| `ci-confirm` | Reads the CI conclusion for the source ref; succeeds only on `success`. | — |
| `merge` | Merges the named PR (squash by default). | — |
| `version-tag` | Creates and pushes the annotated version tag. | `git-tag` name |
| `npm-publish` | Publishes the tarball to the registry. | `npm-package` version |
| `fresh-install-smoke` | Installs and runs the published package from the registry. | — |
| `cli-update` | Updates the Yui CLI/Controller home via the existing update orchestrator. | `controller-home` |
| `controller-replace` | Stops and restarts the file-task Controller. | — |
| `project-migrate` | Runs the Project migration through the existing project command. | — |
| `post-verify` | Runs an arbitrary verification command. | — |

Steps may reference earlier evidence: a param value of
`$externalId:<step-id>` resolves to the referenced step's confirmed external
id at run time, so a `merge` step can consume the PR number the `pr` step
produced without the operator knowing it in advance. A reference to an
unconfirmed step fails the run rather than guessing.

## Recovery and resume semantics

A run always starts from the **resume cursor**: the first plan step whose
status is not terminal (`succeeded` or `skipped`). There is no "start over" —
confirmed steps are never re-run.

Because every state transition is persisted before the next external call, a
process exit at any point is recoverable: re-invoke `run` (or `resume`) and
the engine continues from the first unconfirmed step. `--max-steps <n>` bounds
a single run; a run that exhausts its budget mid-workflow returns
`budget-exhausted` and the next invocation continues.

In-flight steps are resolved by **authoritative identity query**, never by
blind re-submission:

- A step left `running` or `unknown` is queried first by its recorded
  `externalIdentity`.
  - `exists` → the step reaches `succeeded` **without a second submission**
    (`unknown` is confirmed, `running` is completed).
  - `unknown` → the run stops with outcome `unknown`; the step is never
    re-submitted while its fate is unknowable.
  - `absent` → the effect never landed, so the step is re-attempted (a
    `running` step records the recovery attempt).
- A `running` step **without** an external identity crashed before recording a
  submission result. An irreversible step is queried through the port anyway
  (the adapter consults its durable idempotency store): `exists` confirms the
  step without a second submission, `unknown` stops as `unconfirmed`, and only
  an authoritative `absent` re-attempts the step exactly once. A reversible
  step always falls through and re-attempts under the same idempotency key.
- A timeout **without** an external identity marks the step as `unknown`
  (unconfirmed) so it is never re-submitted blindly; on resume it fails closed
  as `unconfirmed`.
- A `failed` step is retried on the next run; its `attempts` counter and logs
  grow per attempt.

Run outcomes: `succeeded`, `failed`, `unknown`, `unauthorized`,
`unconfirmed`, `budget-exhausted`. Each carries a machine-readable
`stopReason` (for example `unknown:publish`, `unauthorized:grant-revoked`,
`budget-exhausted:verify`) and the list of step ids attempted that run.

## Idempotency key contract

Each step's idempotency key is **predeclared at create time** and never
changes:

```text
<taskId>/<workflowId>/<stepId>
```

The key is passed to every `executeStep` call for that step, including
retries after a confirmed-absent timeout. The port contract requires
`executeStep` to be idempotent under the same key: a retried attempt must not
produce a second side effect. The engine side of the contract is stricter
still — it never blindly calls `executeStep` for an `unknown` step; it first
re-queries by the recorded identity. A deterministic core scenario checks
uncertain-effect queries, confirmed-step reuse and grant exhaustion against
real SQLite. This proves those engine boundaries, not the idempotency of real
external services or every release adapter.

## Operator guide

Session authority is checked against current durable bindings. Telemetry is
grouped by Role/AgentRun, and process owners use PID/start identity. Storage
changes follow the [single explicit upgrade boundary](sqlite-control-plane-design.md);
ordinary commands never rewrite the Home schema.

Grant issue and revoke are irreversible-authority operations. They require
the current registered global Operator conversation. Its native session ID
must match the durable live session binding: Codex commands use `CODEX_THREAD_ID`
when present, otherwise `YUI_NATIVE_SESSION_ID`; Claude uses `YUI_NATIVE_SESSION_ID`.
Host generation and launch-time Agent labels are not caller identity. Resuming
the same conversation through another entry point does not revoke its authority.
An unregistered, replaced, or ended conversation has no such authority.
A managed Task Agent cannot self-issue or
self-revoke a grant, and clearing the child-process environment does not
confer user authority. The recorded granter/revoker is bound to that
Operator session (`operator:<agent-id>`); there is no `--granter`/`--by`
label to spoof.

```sh
# 1. The Operator session issues the authority for the release chain.
yui task grant issue task-15 \
  --action pr-create-or-reuse --action npm-publish --action post-verify \
  --irreversibility-ceiling irreversible

# 2. Create the workflow against an exact source and a predeclared plan.
#    An npm-publish step requires a content-addressed source artifact: the
#    immutable workflow source can never gain one later, so a plan without
#    --source-artifact is rejected at creation.
yui task workflow create task-15 \
  --grant capability-grant-1 \
  --source-repo acme/widget --source-commit abc1234deadbeef0000000000000000000000000 \
  --source-artifact widget-1.0.0.tgz@sha512-<base64-integrity> \
  --step pr:pr-create-or-reuse \
  --step publish:npm-publish --step-irreversibility publish=irreversible \
  --step-param publish:tarball=./dist/widget-1.0.0.tgz \
  --step verify:post-verify --step-param verify:command='yui --version'

# 3. Run (or resume) and inspect.
yui task workflow run    task-15 release-workflow-1
yui task workflow resume task-15 release-workflow-1 [--grant capability-grant-2] [--max-steps 1]
yui task workflow status task-15 release-workflow-1

# 4. Revoke authority at any time; the next step stops unauthorized.
yui task grant revoke task-15 capability-grant-1
```

`workflow status` renders each step's status, attempt count, and confirmed
external id, so an operator can see exactly where a release stopped and why.

## Real-resource boundary

Real execution happens only through the `yui` CLI, which wires the real
adapter (`createReleaseWorkflowPorts`). The adapter is a thin shell over
existing atomic operations — `gh`, `npm`, `git`, the CLI update orchestrator,
Controller stop/restart, and `project migrate` — and it runs only when a human
granter has issued an explicit CapabilityGrant that passes `checkGrant` for
each step. A local test request never substitutes for that authority.

The tag-triggered `publish.yml` workflow is the only maintained release smoke.
It reuses the exact commit that passed core CI and adds only artifact assembly,
fresh installation, and provenance checks required to publish.

That workflow authenticates through npm Trusted Publishing (OIDC), so the
release identity lives in two places outside the tag: `repository`, `bugs`, and
`homepage` are copied verbatim from the source `package.json` into the published
manifest by `assemble-runtime-package.mjs`, and the package's npm Trusted
Publisher entry names the GitHub owner, repository, workflow file, and
environment. npm compares `repository.url` against the building repository
case-sensitively before accepting provenance. Renaming or transferring the
GitHub repository therefore has to update those URLs and the npm Trusted
Publisher entry together with the rename; otherwise the next tag reaches
`npm publish` and fails there, after the tag and the gated build already
succeeded.

## Adapter security hardening

The real adapter (`createReleaseWorkflowPorts`) applies additional safeguards
beyond the engine's grant checks:

- **Tarball option injection.** An option-looking tarball path (one starting
  with `-`) is rejected before any subprocess — both the `tar -xOf` manifest
  inspection and `npm publish` — sees it, so a crafted path can never be
  interpreted as a flag.
- **Tarball TOCTOU.** After the frozen `source.artifact.integrity` is verified,
  the verified bytes are snapshotted to a workflow-private, read-only temp
  file. Both the `tar -xOf` manifest inspection and `npm publish` read the
  snapshot, never the live tarball path, so a replacement of the original file
  after verification cannot change what is published. The snapshot is removed
  when the step completes.
- **Pinned external commands.** The adapter resolves the external commands it
  shells out to (`gh`, `git`, `npm`, `tar`, `sh`) to absolute paths at
  construction time via `resolveExecutable`, walking the caller's `PATH`
  once. Every subprocess invocation uses the resolved path, so a later `PATH`
  change (or a manipulated working directory) cannot redirect a release effect
  to a different binary. An unresolvable command returns a synthetic failure
  (exit 127) without invoking any binary.
- **Pinned cli-update activation target.** Before the irreversible update
  effect, the adapter persists the exact activation target — the Home plus the
  global npm prefix (`bin/yui`) — to a durable file under the Home
  (`release/cli-update-identity/<idempotency-key>.json`). A hard-exit recovery
  query (a step with no recorded identity) reads this file and invokes that
  pinned target; if the file is absent (the process exited before the
  pre-effect persistence), the query returns `unknown` rather than deriving
  the target from the resume caller's `npm prefix --global` or `PATH`, so a
  different installation in the resume environment cannot attest the step.
- **Controller lifecycle verification.** A `cli-update` recovery query proves
  the replacement Controller actually owns the target Home: it runs
  `yui --json controller status` (with `YUI_HOME` pinned to the recorded Home)
  and requires a `current` controller resource whose `yuiHome` resolves to
  that Home, then `yui --json controller identity` and requires the
  authenticated Controller identity to match the activated artifact: the
  Node.js executable path, the exact Controller entrypoint derived from the
  pinned global binary, and the package version. Binary health alone (doctor,
  `--version`) never confirms the handoff, and any unprovable state returns
  `unknown`. This applies to both the identity-bearing query and the
  hard-exit query (a step with no recorded identity).
- **npm integrity comparison.** An `npm-publish` recovery query does not stop
  at the published version: it fetches `dist.integrity` via
  `npm view <pkg>@<version> dist.integrity` and compares it byte-for-byte with
  the frozen `source.artifact.integrity`. A match confirms the step; the same
  version with different bytes is a conflict and returns `unknown` (never a
  confirmation, never a re-publish); a missing version is `absent`.
