# Yui storage and update boundaries

Read this before changing persistent records, schema or the update handshake.

Yui Home has one authoritative **major.minor** storage version, currently 1.0.
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
Real Home operations and publication require explicit user authority;
development uses isolated fixtures. See
[the storage baseline](../../../../docs/storage-baseline.md) for current
admission and recovery boundaries, and verify the runtime tarball.
