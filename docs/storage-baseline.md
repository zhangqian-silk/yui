<p align="right"><strong>English</strong> | <a href="./storage-baseline.zh-CN.md">简体中文</a></p>

# Storage baseline 1.0

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
