<p align="right"><strong>English</strong> | <a href="./storage-baseline.zh-CN.md">简体中文</a></p>

# Storage baseline 1.0

Current storage is 1.16. The 1.15 → 1.16 transition adds explicit Schedule
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
