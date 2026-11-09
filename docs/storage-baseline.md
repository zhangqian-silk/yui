<p align="right"><strong>English</strong> | <a href="./storage-baseline.zh-CN.md">简体中文</a></p>

# Storage baseline 1.0

Current storage is 1.35. The 1.34 → 1.35 transition admits optional
`migrationBackupKeep` configuration and schema-1 success receipts for new migration
backups. Existing configuration bytes and historical backups are unchanged; the
schema transition itself never deletes files.

The 1.33 → 1.34 transition separates frozen Context
metadata from immutable resource content. SQLite retains identity, scope,
sequence and fixed references; `task-data/<task-id>/context-values/<digest>.json`
holds the exact values, deduplicated only within that Task. Snapshot digests,
authorized values and historical references do not change. Scope lookups use
the existing SQLite index before loading selected content. Missing or corrupt
content is an error, never reconstructed from current state.

Home admission validates the current schema, Home identity and global config,
not every historical Task record or file. Exact reads and explicit record audits
remain strict. The compact Task catalog keeps missing/invalid Task bodies visible
with `recordError` and a null `ref`; it does not fabricate valid Task references.
Doctor reports historical record errors separately as `stored records`, outside
the core storage health gate used for post-update verification.
Exact reads return missing-file/content errors for the Agent to assess;
missing history does not disable unrelated Tasks. Normal upgrades do not
rewrite Task worktree contents or create automatic task-data/Artifact backups,
and deleted history is not automatically restored. The existing database
migration backup and rollback mechanism is unchanged.
Upgrade admission uses the same boundary plus SQLite integrity checking;
each migration still validates the data it transforms. This is not automatic
repair or a guarantee that damaged core database/configuration can run.

### Migration backup retention

```sh
yui config resources show
yui config describe resources
yui config resources set migration-backup-keep 3
yui config resources clear migration-backup-keep
```

`migration-backup-keep` accepts integers from 1 to 1000, default 3. A count means
backup **sets**, not individual database/WAL/SHM files. Saving or clearing the
setting never deletes anything and needs no restart. It takes effect only after
the next required storage migration succeeds and passes control-record and SQLite
integrity validation, under the existing `upgrade`/`update` maintenance fence.
Dry-run, update preflight, already-current storage, backup failure and migration
or validation failure never prune. No background cleaner is installed, and old
backups are never deleted first to make room for a new backup.

New successful backups receive `<backup>.retention.json`, binding their canonical
Home path, Home ID, creation timestamp and exact file identity. Only unchanged,
owned, single-link regular files with a matching receipt can be removed.
Candidates are ordered by the validated creation timestamp, not storage-version
strings or modification times. Historical `pre-storage-v…-<timestamp>.db` names
without receipts are reported as protected: naming alone cannot establish
ownership or distinguish success from failed recovery material. First enabling
the feature therefore does **not** reclaim pre-existing excess backups or infer
success receipts. Unknown files, manual backups, directories, links, shared
backup roots and another Home's data are never adopted.

The current migration backup is always protected. To reserve another successful
backup for a separate recovery, place a `<backup>.pin` marker before using it and
keep it until that recovery finishes. Failed/unreceipted backups need no marker.
Any `-wal`, `-shm` or `-journal` sidecar protects the entire set, rather than
unlinking SQLite pieces. Observed open files and an incomplete process inventory
also prevent deletion. Maintenance serializes Yui writers; do not open or alter
backup sets with an external tool during maintenance. Identity, fence and
sidecar checks are repeated immediately before deletion.

Protected sets can exceed the limit; output explains why. Both commands report
retained/deleted counts, exact deleted paths, protection reasons and cleanup
warnings (`upgrade --json` also exposes `report.backupRetention`). An unreadable
inventory reports the retained count as unknown. Cleanup errors never turn a
validated migration into failure or trigger rollback/replay. Retry occurs only
at a later successful migration. A crash after database deletion can leave an
inert receipt, which is ignored; incomplete/mismatched receipts protect surviving
files. This is database migration retention, not whole-Home or Task backup.

### Offline scoped repair

The user/current Operator can run `yui repair inspect` without starting a
Controller or loading Task history. Task Roles cannot use this Home maintenance
entry. `yui repair config --patch /absolute/patch.json` previews a patch such as
`{"set":{"telemetryEnabled":false},"remove":["unexpectedField"]}`. Use stored
property names (listed by `repair inspect`), not CLI hyphenated keys.
Only public configuration properties can be set; explicit removal can also
remove an unknown corrupt field. `schemaVersion` cannot be patched. Unmentioned
fields are preserved and the complete candidate must validate. Already-valid
configuration uses ordinary `config set/clear`, not this repair entry.

Apply the same request with `--apply --expect <returned-digest>`. The digest binds
the Home, original control rows/revision and exact candidate; changed data or
inputs require a fresh preview. The write and revision bump are one SQL
transaction. Apply holds the existing maintenance and startup fences and refuses
Controller discovery/process presence; it does not stop or start services.
After an uncertain response, inspect and verify the intended values before any
retry. Successful repair is not proof that all Home data or services are healthy.

`yui repair identity --from-backup /absolute/original.db` previews restoration
from a user-selected existing SQLite backup. Apply uses the same digest flags.
The backup identity must validate and match the surviving valid `homeId`; valid
surviving identity fields must also agree. This never generates a replacement
identity or restores the entire database. Invalid JSON, missing singleton rows,
lost/unverifiable Home IDs, revision corruption, unsupported schema and physical
database corruption remain explicit blockers. No automatic backup or historical
file restoration is introduced. Preview outputs field names, not full config
values. A workspace directory selected in a config patch must already exist and
remain outside Home; repair does not create directories on its behalf.

Upgrade runs under the existing maintenance fence, first backing up the old
database (which still embeds all old values). It fsyncs objects before committing
metadata. On a handled failure the database is rolled back/restored and only
this attempt's new files are removed; cleanup/restoration errors are reported.
A process crash before commit may leave unreferenced immutable objects. They
are not authoritative snapshots and a retry verifies and reuses them.
If a user separately chooses a complete historical backup, it must include
`task-data/` as well as `yui.db` and existing artifact repositories; such a file
backup is not an upgrade prerequisite. Worktree cleanup must never remove these
durable namespaces. These changes do not themselves implement Task deletion.

New Task/Run Context includes portable Project policy and the effective
Knowledge version, not registration paths, proposals or the entire Knowledge
revision history. Explicit Project commands still expose those records.
Already frozen Context retains its original values, including old projections.
The 1.32 → 1.33 transition materializes each inherited
experimental Leader from its effective global configuration at upgrade time.
Its configuration is then maintained independently, like an ordinary Task Role.
Ordinary Roles and historical Session/Run payloads remain byte-for-byte unchanged.
Skill references still load current shared files; no historical input is replayed.

The 1.31 → 1.32 transition admits explicit
ExperimentLeader template references and schema-1 experimental knowledge in
Task artifact repositories. No tables are added and no existing Task/Role,
artifact or runtime is converted. In 1.32, inherited configuration was resolved on read;
historical execution snapshots remain fixed. Use the centralized upgrade path
for an existing Home; rolling software back requires its matching Home backup.

The 1.30 → 1.31 transition admits optional Leader draft/develop overrides and
launch stage/source provenance. It preserves existing Role, Task, Session and
Run payloads byte-for-byte; it neither invents overrides nor reconfigures or
restarts existing Sessions.

The 1.29 → 1.30 transition admits explicit WorkItem
continuation receipts, Role-tagged native user messages, and correlation of an
already accepted native Turn with its newly authorized Run. Existing payloads
remain byte-for-byte unchanged; no repair intent or acceptance is inferred,
no WorkItem is reopened by migration, and no native input is replayed.

The 1.28 → 1.29 transition admits optional local Git
total and remote Git inactivity/total timeout settings. Existing configuration payloads remain
byte-for-byte unchanged; absent fields use runtime defaults.

The 1.27 → 1.28 transition admits exact-identity native
title effect receipts under `runtime/native-titles`. It does not infer historical
title ownership, rename conversations, or change existing database payloads.
Unconfirmed naming intents remain non-replayable across Host replacement.

The 1.26 → 1.27 transition admits versioned Host-upgrade
signals in the existing role-runtime mailbox. It adds no table, infers no past
upgrade request, and preserves existing payloads. Drain receipts precede Host
exit; a Controller restart resumes the exact request, not business input.
The 1.25 → 1.26 transition admits optional Codex
workspace-write temporary-directory exclusions without changing historical
permission payloads. The published 1.24 → 1.25 transition remains unchanged
and admits optional Role
`instanceCode` and Session `generatedTitle` presentation fields without rewriting
existing records. Untagged historical titles remain user-owned; no code or
title provenance is inferred. The 1.23 → 1.24 transition adds transaction-maintained
Task read-cache revisions for the scheduler's nine source tables. Inserts,
updates and deletions invalidate only the affected Task; rollback also rolls
back the token. These tokens are derived cache identities, never Task authority
or a replacement for the Home revision CAS. Historical payloads are unchanged,
and existing Tasks start with an implicit zero token until their first mutation.
Two partial indexes support exact runtime-observation identity lookup without
scanning or deserializing the historical observation set.

The 1.22 → 1.23 transition adds global Shell Job
definitions with revisioned script files and per-Run executable snapshots.
It preserves existing payloads without rewriting any Job, schedule or history.

The 1.21 → 1.22 transition admits an optional boolean
`enabled` on Roles and Profiles. Absence means enabled. SQL layout, historical
payloads, existing Task bindings, Session snapshots and input receipts are
unchanged; upgrade does not launch or stop execution.

The 1.20 → 1.21 transition converts provably unedited
built-in Project sync defaults to timezone-explicit clock schedules, archiving
their original bytes under migration 21. Ambiguous higher revisions and custom
plans remain unchanged; no Git work or reauthorization occurs. See
[Project sync](project-sync.md) for the conservative upgrade boundary.

The 1.19 → 1.20 transition adds Agent Job configurations,
optional Job ownership on Global Roles, and the `agent_job_runs` table for
exact original-message/native-attempt evidence and explicit business results.
Existing Role, Session, process Run and artifact identities are unchanged;
no Agent or native Session is invented during migration.

The 1.18 → 1.19 transition adds optional immutable Task
creation source, exact Run delegation and Task/WorkItem result-reference kinds.
Existing valid payload bytes, ordinary source-less Tasks, unknown effects and
fixed references are unchanged; no historical source or authority is inferred.
SQL layout is unchanged.

The additive 1.17 → 1.18 transition admits builtin
Project-sync provenance, a compiled service issuer and a separate user-enabled
preference on new Schedules. SQL layout and every existing payload remain unchanged;
it neither adopts custom Jobs nor fabricates historical grants or Runs.
Installation is a Controller operation, separate from storage migration.

The 1.16 → 1.17 transition adds optional append-only
JobRun artifact references and scope/Run-isolated local Git repositories.
Existing payload bytes and Task Git repositories/frozen references remain
unchanged; no historical artifact, provenance or authorization is inferred.
No SQL layout change or automatic cleanup is introduced.

The 1.15 → 1.16 transition adds explicit Schedule
dispatch targets and authorization kinds. Existing plans keep their exact Session
authority, rules, identity and progress; original bytes are archived under migration
16. No service permission is inferred. New service grants and Job instance
provenance use the same tables; no ScheduleRun lifecycle is introduced.

The 1.14 → 1.15 transition adds separate Job business
results derived from saved process results, archiving original Run payload bytes
under migration 15. It does not infer structured business data from logs, change
execution identities, replay effects or rewrite frozen Context/Integration evidence.
SQL layout is unchanged. Public immediate builtin admissions use an explicit
Home/Run-bound user authority, not an invented Session or Schedule authorization.

The 1.13 → 1.14 transition removes the Role foreign key
from `global_role_session_sets`, preserving every payload byte and rebuilding
its retry index. Stopped Session identity/history can then outlive Role removal
without granting authority. No new authorization table or inferred history is
introduced. Ordinary reads require current storage; only an explicit supported
upgrade changes an existing Home. See [authorization](authorization.md).

The 1.12 → 1.13 transition permits exact native attempt
identity on new inbox claims, exact target identity on new steer controls,
explicit Global inbox retirement and terminal handling-check evidence.
It does not rewrite historical messages, infer old turn ownership or synthesize
ACKs. SQL layout is unchanged. Current inputs and historical missing handling
evidence have separate bounded discovery views; neither is a second queue.

The 1.11 → 1.12 transition admits append-only
`task.project-delivery-decided` events with Project requirement, reason, actor,
original Message/digest/quote and the previous decision ID. Existing records and
SQL layout are unchanged. No historical exclusions are inferred; absent decisions
retain the required-delivery default. See [Project delivery scope](project-delivery-scope.md).

The declared 1.10 → 1.11 transition adds source provenance
to new activation-request event payloads: an existing Message/body digest or
exact caller-attributed native input, plus the recorded Message boundary.
Historical events are preserved without guessed sources or replay. Missing
provenance is an explicit read diagnostic. SQL layout and frozen digests are
unchanged; the centralized transition has no data rewrite.
New Task Job status/result/cancellation/acknowledgement writes also append
`job.state-changed` events atomically. Existing Job history is not backfilled.

The 1.9 → 1.10 transition appends independent
[Schedules](schedules.md) and their due index without rewriting Jobs or Runs.

The declared 1.8 → 1.9 transition adds stable Job
definitions and global Runs, and links each historical Task execution to its
own definition while preserving exact IDs, artifacts and Integration references.
Original Job payload bytes are archived. See [Job/Run contracts](job-runs.md).

The declared 1.7 → 1.8 transition permits an optional
Model management connection in Yui configuration. Only service addresses and
file references are stored; no credentials are imported. Existing Homes remain
unconfigured, and the SQL layout is unchanged.

The declared 1.6 → 1.7 transition adds optional Agent
inbox claim and acknowledgement receipts to canonical Messages and Leader
wakes, including the exact pending-window identity. Historical records and
frozen Context digests remain unchanged; missing handling evidence is never
backfilled as delivery or consumption. The SQL layout is unchanged.

The declared 1.5 → 1.6 transition adds optional
source-attributed monetary evidence to canonical runtime observations. Existing
observations remain unchanged: absent amounts and prices stay unknown. The SQL
layout is unchanged.

The declared 1.3 → 1.4 transition gives Project
Knowledge applicability and exact version history, and updates proposal
fingerprints to include applicability and replacement intent. It restores
`scope`/`expiresWhen` only from an exact matching accepted proposal. Migrated
knowledge starts at version 1 of the observed head; older proposals remain
available, but missing historical edits are not invented. Frozen Context
snapshots and their digests are unchanged. The SQL layout is unchanged.

The declared 1.2 → 1.3 transition adds optional exact Session fences to
structured inputs and permits their explicit nondelivery reason without an
Assignment. Existing Role-addressed inputs remain unchanged.

The declared 1.1 → 1.2 transition adds optional
CapabilityGrant authorization-source evidence and native-human input/archive
audit records. Existing valid Operator grants remain unchanged; migration does
not infer or invent past user authority. The SQL layout is unchanged.

The 1.4 → 1.5 transition introduces complete Skill package references in
effective launch snapshots and Session Manifests. Historical records and their
digests are preserved byte-for-byte; missing package metadata explicitly means
legacy entrypoint-only/unrecorded evidence. Migration cannot recover resources
that were never captured. Existing running Hosts keep their original inputs.
Current loading uses stable source paths and internal versions; restoring a
valid legacy Session does not require frozen-package evidence or replacement.
No ordinary reader backfills historical versions from mutable sources.

New launches snapshot raw resources under `runtime/skill-packages/<digest>`.
The version covers sorted relative paths, SHA-256 byte digests, sizes and
executable flags. Builtin Skills share a complete sibling tree to preserve
cross-Role references; configured Skills are bounded to their own directory.
Symlinks and special files are rejected, as are packages exceeding 2,048 files,
8 MiB per file, 32 MiB total or 32 directory levels. Scripts are retained,
never run on import. Sources must be readable and physically rooted.
Sessions and AgentRuns retain the compact source/version/inventory pointers;
file bodies stay in the package. These records describe captured source, not
proof of model loading. Source changes apply to current Skill loading after the
per-turn version check, including existing Sessions. Lost or corrupted audit
packages fail explicit historical reads, not current Session admission, and are
never rebuilt from current sources. The loading change adds no persisted DB
fields or storage migration; storage remains 1.6.

Yui 1.0.0 starts from one clean persistent contract. The package version,
storage schema, record envelopes and Controller protocol are separate
identities; none is inferred from another.

## Current contract

- `storage_schema` identifies the authoritative storage **major.minor** and the
  exact physical-schema checksum.
- A fresh Home creates the complete current DDL directly. Ordinary reads accept
  only the current identity and never normalize records.
- Default `upgrade` and `update` may follow only a complete, declared,
  same-major minor path. The initial 1.0 baseline has no migration steps.
- Cross-major, downgrade, unknown and undeclared identities are rejected before
  activation and leave the Home unchanged.
- Current Yui-owned envelopes and protocols begin at their own version 1.
  Business IDs, revisions, epochs, event counters, Context digests and external
  provider protocols are independent and are never reset by storage numbering.
- `storage_migration_archive` is opaque audit evidence for declared current
  transitions. It is not a reader, scheduler or repair mechanism.
- The runtime package and current source contain only the current contract and
  its declared same-major minor transition mechanism.

Future persistent changes must add an explicit storage minor version, source
and target checksums, a deterministic transactional transform and focused
regression evidence. A published baseline is immutable.

## Failure and recovery

Update preflight validates the staged package and target Home before activation,
then repeats the check under the maintenance fence. A migration failure rolls
back its transaction and does not advance the storage identity.

Invalid, malformed or unsupported state is preserved and diagnosed. Yui does
not guess repairs, discard evidence or silently initialize over it. The Agent,
Leader or Operator can inspect the exact failure and choose a bounded action
such as retrying, abandoning an affected execution, restoring a verified
backup, or initializing a separate fresh Home.

Before an authorized persistent update, make a restorable backup of the Home
while the Controller is stopped or held by the maintenance fence. Restore the
database and its matching WAL/SHM set as one unit. Do not combine files from
different observations.

Real Home operations, publication and shared-infrastructure validation require
explicit user authority. Development and CI use isolated disposable fixtures.

## Release artifact boundary

The published runtime tarball is the only executable release artifact. It must
exclude repository tests, development tools and non-current storage material.
Every GitHub Release carries the exact tested runtime archive, checksum and
provenance used for npm publication.
