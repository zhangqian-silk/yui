# Yui storage and update compatibility

Read this before changing persistent records, schemas, payloads or the update
handshake. Ordinary behavior changes use the current contract directly.

Yui Home has one storage version. A persistent contract change appends exactly
one immutable contiguous migration. Retain the complete forward chain from the
minimum supported version, currently 1, through the current version. Homes
below that floor remain untouched and need initialization, not a below-floor
adapter.

Ordinary stores do not dual-read, normalize or write historical shapes.
Only `yui upgrade` and the migration phase of `yui update` interpret them.
Do not add separate layout, aggregate, record-family or configuration
compatibility versions. Record-local protocol tags can validate current data,
but changes to persisted payloads still belong to the Home migration.
Never rewrite a released migration or lower the floor to discard valid history.

Preserve the target-driven update handshake with released updaters.
`upgrade --update-preflight` and `upgrade --update-apply` must retain their
success/blocker semantics and parent-owned handover-lock proof. Add fields
rather than renaming or removing those consumed by older supported updaters;
otherwise the migration chain becomes unreachable through `yui update`.

Migrations preserve valid historical data. They do not heuristically repair
malformed, partial, manually modified or leaked Sessions, workspaces, runtime
artifacts or state. Return a bounded diagnosis and let an authorized Agent
choose cleanup or retry. An explicitly retired Task remains an isolation
boundary: preserve its history while skipping only runtime cross-reference
checks that would block healthy Tasks.

## Final historical release

0.99.0 freezes this historical line at v37 with its complete v1..37 chain.
Do not add a no-op migration for the package version or change the existing
definitions. Keep the published artifact and its release manifest/source tag
as the frozen historical upgrader.

The approved sequence reserves the one-time old-v37 to distinct-new-v1 cutover
for 0.99.1, with its own explicit converter and verified backup/rollback
boundary. It is not a rewrite of old migration 1. Only after that bridge is
verified may 1.0.0 remove the old conversion implementation; 0.99.1 and 1.0.0
must share exactly the same new persistent contract. See the release workflow
for the complete product boundary. Do not implement that reset in 0.99.0 or
claim its current-schema preflight proves future cutover readiness.
