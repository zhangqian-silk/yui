<p align="right"><strong>English</strong> | <a href="./storage-baseline.zh-CN.md">简体中文</a></p>

# Storage baseline 1.0

Current storage is 1.5. The declared 1.3 → 1.4 transition gives Project
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
that were never captured. Existing running Hosts keep their original inputs;
restoring a legacy Session requires explicitly selecting a new Session. No
ordinary reader backfills historical versions from mutable sources.

New launches snapshot raw resources under `runtime/skill-packages/<digest>`.
The version covers sorted relative paths, SHA-256 byte digests, sizes and
executable flags. Builtin Skills share a complete sibling tree to preserve
cross-Role references; configured Skills are bounded to their own directory.
Symlinks and special files are rejected, as are packages exceeding 2,048 files,
8 MiB per file, 32 MiB total or 32 directory levels. Scripts are retained,
never run on import. Sources must be readable and physically rooted.
Sessions and AgentRuns retain the compact source/version/inventory pointers;
file bodies stay in the package. Changing a source affects a new Session only.
Lost or corrupted packages fail closed rather than being rebuilt from current
sources.

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
