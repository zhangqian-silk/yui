# Incremental context reads

Read before using Task event deltas or frozen Run deltas. This is not required
for a current read or merely because intent changed. For an apparent conflict,
read [Current intent](context-ordering.md); the delta itself never grants scope.

## Maintain a baseline and incremental history

For current Task facts, retain `coreCursor` from `task context <task>`.
`task context delta <task> --after <coreCursor>` returns **event history**, not
a replacement current view. Retain the same `--after` on every continuation;
use `--continuation` until `complete: true`, then advance to `throughCursor`.
The window's upper bound is fixed. Later arrivals belong to the next read.

Deduplicate by source Home + Task + event ID, and process numeric event order
within that stream. `createdAt` is occurrence/recording metadata, not a global
causal clock; native acceptance, delivery and acknowledgement are separate
facts. Never apply a late event's old payload over a newer current record.
Re-read affected current refs with their digest when making a decision.
An empty delta preserves the baseline; `stateChanged` can still require a
current read because not every shared fact is a Task event.

Cursors from another Home/Task, incompatible or invalid continuations, missing
baselines and source changes require a fresh bounded current read. Do not join
pages from different windows or versions. A failed original-detail digest
requires rediscovery; a content page must be reassembled only with its own
source digest. None of these reads consumes input or permits replay.

Frozen Run context is a different stream. Keep its exact Snapshot and
Assignment. `deltaRefs` is a launch hint, not a complete patch. The explicit
Run delta reports complete changed `refs` and `removedRefs` against its named
parent Snapshot, with large documents paginated. Apply removals only to that
frozen inventory; an empty delta is a no-op. Mutable Task facts and current
inbox clarifications must be refreshed separately within read scope; they
never expand the frozen Assignment or change a Review candidate.

Focused wakes use exact input refs, including delayed and same-timestamp
inputs. Timestamp-window discovery is under `--history` (or a historical wake
without refs), not new delivery authority. Original event and Message reads
remain available without rewriting or replaying them.
