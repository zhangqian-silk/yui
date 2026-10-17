# Current intent, provenance and temporal reads

Use this when a handoff, changed requirement, stale summary or incremental read
appears to conflict with earlier material. Core supplies facts and source
relations; the Agent decides meaning within its existing authority.

## Resolve the apparent conflict

Read the current Task view first, then the relevant exact original sources:
Task requirements, `phase.activation.source` event and its linked Message,
current request, Brief, and the Session's actual authority. The `phase` and
`caller` projections are observations, not permission granted by a summary.
Do not fetch all history merely because the sources differ.

Classify the difference before deciding:

- **Stage progression:** an earlier “discuss only” limits that planning stage.
  A later explicit request to start the same work, legally adopted Activation,
  enabled gate and delivery-authorized Session establish the next stage.
  Continue without asking for the same authorization again. The old words stay
  in the audit trail; they are not a fresh stop.
- **Same-scope replacement:** a later authoritative original can replace the
  particular requirement it changes. Explain the scope of that replacement in
  Brief; preserve unchanged requirements and the original references.
- **Independent restriction:** “do not publish”, resource limits, material
  exclusions and unrelated prohibitions remain unless explicitly changed by an
  authorized source. Development authorization is not release authorization.
- **Actual contradiction or missing evidence:** read the exact source and
  current facts first. If the material ambiguity remains, request only the
  missing user decision; do not fabricate provenance or resolve it by timestamp.

Active lifecycle alone never authorizes implementation of a new analysis-only
request. An old planning Session never promotes itself. Stop, archive,
Assignment, workspace and grant boundaries remain independent checks.

An activation event's `sourceText` is exact text supplied by the recorded
caller; `leader-attested-native-input` explicitly identifies the Leader's
capture, not a Provider-verified user message. Read it as attributed evidence
together with the adopted request. `sourceMessageId` names the original shared
Message; its body digest detects edits, while handling receipts do not change
the source body. Missing/changed/unavailable provenance is visible and calls for
an exact-source read, not an automatic prohibition or an automatic grant.
Do not select whichever summary arrived last as the winning authority.

`phaseRelation: recorded-before-activation-request` is recording order only.
It does not declare every old requirement superseded. A delayed result or an
acknowledged Message retains its original scope, source and version.
`revised-after-activation-request` means an existing Message was edited after
that boundary; its old ID must not hide the new revision.

## Keep the shared working summary current

Description owns the goal and durable boundaries; Brief owns the current
semantic interpretation, progress, blockers, next action and original refs.
Core owns lifecycle, gate, Activation, Session and operation facts. Do not
manually mirror them into a competing state machine.

At a changed requirement, phase handoff, resolved blocker, meaningful result or
completion, reconcile affected Brief fields. Routine unchanged steps need no
write. `phase.brief.refresh-needed` is a mechanical hint, not a semantic verdict
or completion gate. Compare originals before editing.

Read `task brief show <task>`; update with its `writeGuard` as
`task brief update <task> --if-current <writeGuard> ...`. A new semantic event,
Brief edit or changed Task boundary invalidates the guard even at the same
timestamp. On rejection, reread current facts and reconcile only the intended
fields; do not blindly copy an old summary under a newly read guard.
An old Session still cannot write through this operation.

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
