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

0.99.0 is the frozen historical bridge (old integer v1..v37). The 0.99.1 runtime
must not import or package that chain, an old-format reader, or the one-time
converter. `tools/baseline-cutover` is an independently packaged, explicit
old-v37 to new-1.0 converter. It accepts only proven source structure and keeps
full backup, original audit bytes and quiescence boundaries. Malformed or
unsettled state is a diagnosis, not permission for heuristic repair.

The new baseline resets current Yui-owned envelopes and protocols to version 1,
using distinct identities where old version-1 formats could collide. Never
reset business IDs, revisions, epochs, event counters, user/native payloads,
frozen Context digests or external Provider protocols.

Freeze this persistent contract between 0.99.1 and 1.0.0. Do not reset again
when tagging 1.0.0. Real Home conversion and publication require explicit user
authority; development uses isolated fixtures. See
[the operator guide](../../../../docs/storage-baseline.md) for conversion and
recovery, and verify both the runtime tarball and independent converter archive.
