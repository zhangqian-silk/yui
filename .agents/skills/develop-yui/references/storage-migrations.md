# Yui storage and update boundaries

Read this before changing persistent records, schema or the update handshake.

Yui Home has one authoritative **major.minor** storage version, currently 1.36.
It is independent of software releases, record schema tags and business
revisions. `storage_schema` identifies the format and schema checksum. New
Homes initialize the complete current schema directly.

Ordinary readers accept only the current version and never normalize data.
Default `upgrade` / `update` may advance only along a complete, contiguous minor
path within the same major. Each future minor change declares its exact source
and target checksums and transforms; published definitions are immutable.
Unknown versions, downgrades and cross-major transitions fail closed. A pinned
software version does not grant cross-major conversion.

Record-local schema tags validate current values; they are not independent
Home upgrade axes. Changes to persistent payloads must still declare the
appropriate Home version transition. Preserve transactions, identity fences,
exact execution authority, pending intent and irreversible-effect evidence.

The 1.0.0 source tree and runtime contain only the current contract and its
declared same-major minor transition mechanism. A Home whose
storage identity is not supported by the current same-major transition graph
is rejected without mutation. Malformed or unsettled state is a diagnosis, not
permission for heuristic repair; preserve the evidence and let the Agent or
Operator choose cleanup, retry or abandonment.

The baseline sets current Yui-owned envelopes and protocols to version 1,
using distinct identities for each contract. Never
reset business IDs, revisions, epochs, event counters, user/native payloads,
frozen Context digests or external Provider protocols.

Persistent changes after the published 1.0 baseline require an explicit
same-major minor transition; never rewrite the baseline. Keep current bounded
retry, lock waiting, transactions, replay protection and exact-identity caches:
they are current runtime behavior.
Storage 1.34 keeps frozen Context metadata in SQLite and its immutable resource
values in `task-data/<task-id>/context-values/`. Preserve both when backing up a
current Home; these are durable evidence, not a runtime cache or a worktree.
The 1.32/1.33 upgrade backup is self-contained because its snapshots still embed
their values. Migration publishes fsynced content before committing references,
and tracks only its own new file/directory effects for rollback. Never refill
missing frozen content from live records or garbage-collect it by age.
Historical files are not a whole-Home admission prerequisite: validate control
schema, Home identity and global config without loading all historical records
or content, and return the original missing-file
error on the exact requested read. Do not create file backups or restore deleted
Task content automatically. Normal upgrades must preserve Task worktree contents,
including uncommitted files. This does not remove the existing database
migration backup/rollback mechanism.
Explicit record audits and exact reads remain strict; migrations validate their
own transformed data. Catalog diagnostics are not execution or cleanup authority.
Explicit `repair` is a separate user/current-Operator maintenance operation,
not an automatic reader fallback or migration. It patches named config fields
only when the existing object is parseable, or restores identity metadata from
a supplied backup matching the surviving Home ID. Preserve preview guards,
maintenance/startup fences, exact scope and atomic revision updates; never
generate a replacement identity or bootstrap missing control rows.
Real Home operations and publication require explicit user authority;
development uses isolated fixtures. See
[the storage baseline](../../../../docs/storage-baseline.md) for current
admission and recovery boundaries, and verify the runtime tarball.

Cleanup capabilities ship through normal software upgrades; migrations may
prepare required storage but must not invoke destructive cleanup. Process-data
cleanup and full Task deletion require separate explicit operations. Verify
that upgrading old Homes preserves existing process data. The current
`task process-cleanup` removes only archived-Task telemetry details after
preview confirmation; it is not full Task deletion or file cleanup.

Migration backup retention is a separate, synchronous tail after a successful
and validated migration, under the existing maintenance fence, never a schema
transform or background collector. Default keep is 3 (configurable 1–1000).
Preserve the current backup, failed/unreceipted historical material, explicit
`.pin` recovery references, SQLite sidecar sets, changed identities, links and
unverified/open-process references. Only exact Home-bound success receipts
permit deletion. First enablement does not adopt old names. Propagate the same
counts, protections and cleanup warnings through both upgrade and update;
cleanup failure must not restore/replay a committed migration. Exercise normal
selection with deterministic process observations and verify actual descriptor
protection in platform tests. Never test against a real Home's backups.
