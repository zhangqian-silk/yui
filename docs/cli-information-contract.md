# CLI information contracts

Yui separates a command's effect from discovery and full evidence. Queries
never consume Messages or start subsequent work. Mutation receipts describe
saved/requested/accepted/unknown facts; `ok: true` means the CLI invocation
succeeded, not that a Task, native Turn or remote delivery completed.

This is the current wire contract, not a compatibility mode. Stored Tasks,
Messages, results, Snapshots and Session histories are unchanged. Read projections
add no snapshot/cache store. New activation-source event attributes use the
declared storage 1.10 → 1.11 transition; historical sources are never invented.

## Daily read path

| Question | Entry | Default information / further reading |
| --- | --- | --- |
| Which Task? | `task list` | Existing bounded catalog, filters, attention and cursor |
| What is current? | `task context <task>` | Current facts, active work, open inputs, active decisions, unresolved jobs and unacknowledged Message references; no event or terminal-Run dump |
| What records exist? | `task context list <task> --store <family>` | One authorized family, summaries and exact digest-bearing references |
| What does it actually say? | `task context inspect <task> --store <family> --ref <id> --digest <digest>` | Exact current record, including original result expansion; long documents are paged |
| What changed? | `task context delta <task> --after <cursor>` | Immutable events with a fixed upper bound, not a snapshot of current mutable state |
| Which Global input? | `session context <role>` | Identity, Profile read pointer, authority, current native Turn/retry facts and a bounded pending Message page; history is opt-in |
| Read Global input | `role message list <role> [--pending]`, `role message show <role> <id>` | Scoped discovery, then exact original; queue acceptance never erases history |
| What arrived in this wake? | `task wake show <task> <wake>` | Fixed-window inputs/results, bounded complete ordinary inputs and exact original reads; `--history` expands diagnostics |
| What was assigned? | `task run context <task>/<run>` | Frozen authority, up to 16 `pointers`, sampled changed identities and live observations with totals; `--view refs` pages references, `--view full` reads the full pack |
| Which repeated failure? | `role message list <role> --diagnostics` | Derived classified groups with count, first/latest and recovery evidence; `--diagnostic <key>` pages original occurrences |
| Which configuration is real? | `task role session inspect <task> <role>` | Task/Role identity, desired binding, frozen Session, current Provider binding, retry and explicit Host observation; no full Task/Role copies or Provider conversation history |

Domain lists for Task Messages, events, WorkItems, Runs, decisions, milestones,
publications and InputRequests use the same summary/reference paging contract.
Task Role-status and wake-history lists also page, with explicit detail commands.
Role discovery reports `recordedHealth` and `hostObservation: "not-requested"`,
not live Host health. Even a normal recorded status cannot rule out a failed Host
or unacknowledged terminal; follow the row's `task role status` read to inspect it.
`task role status <task> <role>` defaults to `--view current`: the same computed
health, Host, delivery/retry, cleanup and drift observations, with Run/WorkItem
identities and exact detail commands instead of their input/report/history bodies.
Retry diagnostics remain available through the current retry read. Desired and
effective configuration remain visible; unknown evidence is not upgraded to success.
This changes the default nested JSON contract. Consumers needing the previous
complete records use `--view full` and retain that option on pagination.
The underlying runtime status projection and Web payload are unchanged.
Context lists additionally expose candidates, reviews, jobs, Project Knowledge,
workspaces and other authorized record families. `--status`, `--after` and
`--work-item` narrow Context discovery; every continuation must retain filters.
Run listing accepts a Task or `task/work` target.

`task run show <task>/<run> --view status` reads identity, record status,
delivery/retry observations, retirement and result availability without copying
input, launch or report bodies. It uses the same authorization as the default
`--view full`, which retains complete audit evidence and document pagination.
Its retry observation is the same current summary used in Task Context, with
an exact Session retry command for raw diagnostics and history, not their bodies.
`--view result` returns the complete original result (including failure/provider
fields), Run identity/status, retirement and execution observation without the
submitted input or launch configuration. An absent result is `null`, not success.
Long reports retain document pagination; continue with the same view. The full
audit command remains available in `reads.full`, and the default is still full.
Read the original result through its Message, result or full Run view before disposition;
status is neither a report nor acceptance. Once that exact original is available
in current context, use status for additional execution facts instead of loading
the report twice. No read receipt or model-memory cache is introduced.

Current Context's `attention.messages` excludes explicit acknowledgements and
retirements; delivery alone is not handling. The exact wake receipt and latest
Message revision determine coverage. `--view current` continues that view;
the default family list still includes history. `collections` counts and `omitted`
explicitly describe incomplete discovery. Samples are not proof that no older pending or
relevant input exists. Read the relevant fixed wake and original Messages;
use family discovery when a broader requirement/history audit is needed.

Current Context is a working index, not a repeated configuration or requirements
dump. Task/Brief, Role, Project policy, workspace, delivery and decision records
return summaries and exact references even when their bodies are small. Lifecycle,
execution authority, attention counts and active execution/retry observations
remain inline. Read a relevant original through `context inspect` before acting
on its requirements or authority; `omitted: true` is not an empty original.
Fresh reads still compute current identities and enforce scope. There is no
model-memory cache, inferred handling receipt or automatic reuse of stale state.
Within the current workspace sample, the exact Run workspace overlay (when
authorized) precedes Task main, then other workspaces. Historical integration
directories cannot crowd Task main out of that sample. Full family discovery
retains its existing ordering, counts and original records; this priority neither
changes workspace authority nor grants access to another Assignment.

Message discovery can reuse an existing producer-authored `Yui-Summary:` from
the Message body or its matching terminal Run result. It labels the source as
an **author summary**, not a verified outcome or handling decision. The source
label counts toward the 512-byte summary budget; an otherwise valid summary
that no longer fits is omitted whole with an original-read hint, not clipped.
Missing, oversized or mismatched result summaries do not hide the Message or
change its exact original, digest, authorization or handling state.

## Budgets and continuations

- Discovery pages default to 20 items, accept 1–100, and enforce a 32 KiB
  compact-JSON budget including the success envelope, escaped identities,
  continuation and nested structure. Summaries are at most 512 UTF-8 bytes.
- Current Task Context has at most 64 records, with a 24 KiB record/attention
  budget inside a 32 KiB response budget. Single inline values are at most
  2 KiB; large values and Message/Run/WorkItem/Knowledge bodies use references.
  Each collection contributes at most eight sampled records at entry.
- Global entry samples up to eight current-turn/available inputs, including
  uncertain ones. Historical missing receipts are a separate count and explicit
  `inbox list --view history` read; absence of ACK is not proof of unexecuted work.
  Continue its pending page with `role message list <role> --current --cursor`.
  A managed self-read additionally includes `currentOriginals`: complete records
  correlated to this exact Turn and present in that pending page, at most 4 KiB
  each and 8 KiB combined. Available future inputs, history and oversized records
  remain discovery-only; their exact reads are unchanged. Inspection callers get
  no inline originals. This does not claim, deliver or acknowledge input.
  It does not repeat recent history, Profile bodies, frozen Skill
  packages or accumulated retry details. The Manifest is the Profile pointer;
  explicit Message and Session retry reads retain history and original evidence.
- `inbox list --view current|history|all` uses the current managed identity,
  prioritizes exact current-turn input and shares originals with automatic
  delivery. `claim` and `ack` accept 1–16 exact IDs with independent results.
  ACK records semantic disposition (including legal routing or supersession),
  not Task completion. Exact terminals emit one bounded handling check without
  ACK or business replay; reminder-only input cannot self-wake indefinitely.
  `inbox retire` disposes only obsolete proven-unsubmitted Global input with an
  explicit reason, preserving its original target. Task retirement remains
  the Leader's existing `task message retire` operation.
- Run entry samples up to eight records per live category and 16 frozen refs.
  Pointer continuation uses `--view refs` and `pointerPage.nextCursor`; full pack
  document continuation uses `--view full`. Neither changes the frozen authority.
  Read `--view input` before acting when `input.directiveOmitted` is true: the
  entry's bounded directive summary is not the assigned instruction body.
  New frozen Task-message pointers include a literal `Excerpt:` preview in their
  existing summary (at most 160 UTF-8 bytes), alongside the original revision
  and digest. Use it to select relevant originals, not as their complete body or
  authority. Later message edits cannot change that Run's frozen preview.
  Existing snapshots are not regenerated.
  When pointers are present, `reads.expand` exposes the existing selected-original
  batch syntax directly. Replace the placeholders with relevant frozen pointers;
  this is not a preselected read-all command. The existing 1–8 selection limit,
  exact snapshot checks, complete original bodies and page budget are unchanged.
- `session skills [--cursor ...]` checks only current metadata/readability. It
  does not read Skill bodies or historical packages, and uses document pagination
  only when the configured metadata exceeds the inline budget.
- Detail documents up to 16 KiB remain ordinary JSON. Larger documents return
  `contentPage`: exact source, SHA-256 digest, JSON-character offset, total bytes
  and characters, text, completeness and a next cursor. Chunk lengths adapt to
  the complete encoded 32 KiB response budget, including identity and cursors,
  with 256 bytes reserved for small command wrappers. Chunks never split
  surrogate pairs; offsets remain UTF-16 units and previously issued cursors
  remain readable. There is no 4 MiB cutoff that makes a legal original
  permanently unreadable.
- Task metadata/next-action/remote-delivery, Brief, WorkItem, Message, Run,
  decision/milestone/event, Role show/status/Session inspection, wake detail,
  InputRequest, Run context and frozen expansion use bounded detail reads.

Ordinary Task reads authenticate the original caller but do not restrict data
by its Task or Assignment ID. This single-user local product relies on local
filesystem permissions and authenticated service transports, not Task ownership
as a tenant boundary. Foreign current context identifies the caller's own Task
and labels its authority `reference-only`. Search, records, artifacts and native
conversation evidence do not switch identity, adopt another Run's instructions,
or grant writes, inbox handling, dispatch or external effects. Explicit resource
and Job-owned Role restrictions still apply. Native conversation tools need no
Yui gateway or Task mapping; actual resource access and relevant scope suffice.

Completed results remain readable. Simple questions need no reopen; the current
Leader may reopen its own unarchived result when a same-result request or explicit
unfulfilled commitment needs tracked diagnosis, evidence handoff, authority
coordination or authorized delivery. Diagnosis stays read-only; reopening retains
historical completion evidence and never lifts a stop, restores cancelled intent,
promotes a planning Session or grants external effects.

Use `--json` and read the top-level `data`. Run context and expansion use
`data.context`; Run Context delta uses `data.contextDelta`. For a long detail, repeat that same read with
`--cursor <contentPage.nextCursor>`. Concatenate `text` in offset order, checking
the same source and digest, and parse the combined JSON once. Do not parse
chunks individually or treat a first chunk as the complete report.

### Copyable detail-reading example

For 1–8 already-known independent originals in the same Task, use
`task context inspect <task> --refs '<JSON array of discovery ref objects>'`.
For hand-written commands, repeated `--context-ref <store/refId@digest>` flags
avoid JSON quoting; they use the same exact-reference spelling as dispatch.
Do not combine the two selection formats or single-inspect selector flags.
Each object requires `store`, `refId`, and `digest`; optional `revision` is
discovery metadata, not a second freshness guard. The response contains
`{taskId, items}`, with each item identical to a single inspect result.
The entire batch shares the existing 32 KiB budget, not one budget per item.
Follow `contentPage` using the same ordered references and `--cursor`.
A stale, duplicate, unavailable or forbidden reference rejects the whole read.
Each original is independently digest-pinned; this does not create an atomic
cross-record snapshot, select sources, claim inputs, or grant broader access.
Use single inspect unchanged when only one original is needed.

For `task context inspect`, the following Node.js example consumes the outer
`data` envelope. Supply the authorized CLI path and exact discovery arguments;
keep the current Session environment. It only reads that record, does not claim
or acknowledge input, and does not prove that an Agent has read its contents.
Save as a local `.mjs` file and invoke
`node reader.mjs /absolute/path/to/yui task-1 task-message message-1 <digest>`.
The final stdout is the reconstructed record; capture it in your owned scratch
directory and read it in bounded portions if it exceeds the tool output limit.
Do not re-fetch earlier pages just to inspect metadata.

```js
import { spawnSync } from "node:child_process";

function readDocument(read) {
  let cursor, source, digest, total, offset = 0;
  const chunks = [];
  for (;;) {
    const data = read(cursor);
    const page = data.contentPage;
    if (!page) {
      if (chunks.length) throw Error("Detail changed shape during pagination");
      return data;
    }
    if (!chunks.length) {
      ({ source, digest, totalCharacters: total } = page);
    }
    if (page.source !== source || page.digest !== digest ||
        page.totalCharacters !== total || page.offset !== offset ||
        typeof page.text !== "string" || !page.text.length) {
      throw Error(`Detail identity/offset mismatch at ${offset}`);
    }
    chunks.push(page.text);
    offset += page.text.length; // UTF-16 units, not UTF-8 bytes.
    if (page.complete === true && page.nextCursor === null && offset === total) {
      try { return JSON.parse(chunks.join("")); }
      catch { throw Error(`Invalid completed detail at ${offset}`); }
    }
    if (page.complete !== false || offset >= total ||
        typeof page.nextCursor !== "string" || !page.nextCursor.length) {
      throw Error(`Invalid continuation at ${offset}`);
    }
    cursor = page.nextCursor;
  }
}

const [cli, task, store, ref, digest] = process.argv.slice(2);
if (![cli, task, store, ref, digest].every(Boolean)) throw Error("Five arguments required");
const args = ["task", "context", "inspect", task, "--store", store,
  "--ref", ref, "--digest", digest, "--json"];
const record = readDocument(cursor => {
  const result = spawnSync(cli, [...args, ...(cursor ? ["--cursor", cursor] : [])],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw Error("Detail command failed; stop without replay");
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw Error("Invalid CLI envelope"); }
  if (reply.ok !== true || !reply.data) throw Error("Detail read refused");
  return reply.data;
});
console.log(JSON.stringify(record));
```

This is a detail consumer, not a list paginator or a mutation retry helper.
On a changed source or refusal, stop and reassess the original read; do not
silently restart or mix versions. Errors deliberately exclude document text:
passing a partial `contentPage.text` to `jq fromjson` can echo the entire
fragment on failure. To inspect one already-fetched page without parsing it,
use `.data.contentPage | {offset,len:(.text|length),complete,nextCursor}`.
Two pages are not a completion condition; only the returned metadata is.

List responses carry `items`, `total`, `complete`, and `nextCursor`. Counts,
items and cursor validation occur inside the same authorized scope. Cursors
are opaque positions, not access tokens: every page reauthorizes. A changed
collection or document returns an explicit source-changed error; restart rather
than mix versions. No persisted pagination session is needed. Mutable collection
continuations intentionally do not promise uninterrupted traversal during
concurrent writes. For append-only event traversal use fixed-bound Context delta.
Discovery currently scans the selected authorized family to fingerprint it;
its output, not total storage-reading cost, is bounded.

## Intent, source and temporal consistency

Current Leader/public Task context projects `phase` (lifecycle, gate, activation
source and Brief freshness) separately from the managed `caller`'s actual
execution authority. These are facts, not a semantic permission decision.
Old Message records carry recording/revision relationships to the adopted
activation, not an automatic “superseded” verdict.

Activation requests accept either `--source-message <id>` or
`--source-text <exact-input>`; a Leader must provide one. Develop submissions
link their saved Message automatically. Exact text is retained in the existing
immutable event with caller attribution, including native Session identity for
Leader captures. It is not a Provider-verified user Message and is never queued
again. Same-request retries cannot change that source. The activation wake
references the event/original explicitly. Missing or changed sources have a
diagnostic and original-read route, not a fabricated approval or rejection.

`task brief show` returns `writeGuard`; `task brief update` requires
`--if-current <writeGuard>`. New semantic input/results, phase changes or edits
invalidate stale writers transactionally, independently of timestamps and
runtime heartbeats. On rejection, reread and reconcile intended fields.
Task Job saves append a semantic event for status, result, cancellation or
acknowledgement changes, not for heartbeat, checkpoint or notification receipts.
Core indicates `refresh-needed`; Leader maintains the actual summary at
meaningful boundaries. No completion gate or automatic prose rewrite is added.

Task event cursors bind the Home and Task. Delta returns `kind: event-history`,
`fromCursor`, `complete`, `stateChanged` and a fixed `throughCursor`. Keep the
original `--after` across every `--continuation`; advance only on completion.
New arrivals remain outside that window. Empty events do not erase a baseline,
and shared state can change without Task events. Invalid/old cursors require a
fresh bounded current read. Event numeric IDs order recording within one Task,
not occurrence, delivery, handling or unrelated Tasks.

Run delta uses its exact frozen parent Snapshot and returns complete changed
`refs` plus `removedRefs`, with normal document pagination. The clipped launch
`deltaRefs` remains a hint only. Mutable Task facts never widen that Assignment.
Focused wakes with exact refs no longer absorb other messages merely because
timestamps overlap; `--history` retains timestamp-window discovery.

## Runtime diagnostics

CLI JSON failures keep `ok`, `code`, `message` and `details`. `message` contains
the primary error, effect uncertainty, safe recovery guidance and focused help;
`details.diagnostic` retains the complete sanitized cause chain, operation,
Home, CLI entry, targets and any Controller request/delivery/timing facts.
Those identity lines and nested causes are not repeated as prose in `message`.
Consumers needing them must read `details.diagnostic`, not parse the human
message. Text-mode diagnostics remain unchanged. This is presentation only:
exit codes, redaction, partial receipts and no-replay/recovery boundaries do
not change; no probe, retry or repair is performed.

Global failure evidence remains ordinary record-only Messages; no aggregate
table, Message envelope change, memory store or recovery state machine is added.
Grouping is a derived view of new evidence documents. Older documents remain
readable in ordinary history, not heuristically reclassified. Classified source,
Host/Session, error category/code and explicit effect distinctions determine
equivalence; unclassified faults are not merged. Original affected IDs and raw
evidence remain in exact documents, never a growing array in one notification.
Counts represent distinct observations, not repeat polls of the same identity.

One queued notice represents an unchanged failure episode. Only a new group,
changed impact or exact successful recovery observation produces a new notice.
Recovery ends the corresponding episode without acknowledging inputs or proving
absence of previous effects. Recurrence after recovery gets a new episode.
Operator's own failures/recovery notices are retained without self-delivery.
Discovery and every evidence page retain the existing Role read boundary.

## Effects and exceptions

Message send/queue/steer receipts preserve identity, digest, body byte count and
the original submission/delivery/control states without echoing the body.
`bodySha256` is the lowercase SHA-256 of the saved body's raw UTF-8 bytes;
`bodyBytes` counts those same bytes. Callers may compare them with the exact
submitted file to verify transport without fetching the body again. Do not trim
or JSON-encode the body before hashing. The separate `digest` covers the entire
record and is not a body checksum. These fields are derived from the saved
Message, including idempotent replay; they neither add persistent state nor
replace required original reads, authorization, ACK or downstream acceptance.
`operator submit --json` uses that same structured shape:
`data.taskId`, `data.message` (the bounded Message receipt), and `data.submission`
(the recorded save, phase, planning, activation, delivery and next-step facts).
It no longer returns only an `output` string for JSON consumers; ordinary text
output is unchanged. A same-key retry reproduces the saved submission feedback,
not a fresh interpretation of the Task's later state. The receipt is not the
original body or proof that the Leader finished.
Message `--body-file <path|->` inputs preserve their UTF-8 text, including leading
and trailing whitespace, through Operator submission and Task/Global message
send, update, queue and steer paths. Blank-only or NUL-containing input remains
invalid. Inline text and summary/note file normalization are unchanged. This fixes
the earlier file-input trim; an old request saved after trimming must be inspected,
not replayed with newly different bytes under the same request ID.
Operator's optional `scripts/verify-submission.mjs` compares a local receipt with
the payload and expected Task/intent/request ID. It performs no Yui operation,
write, cleanup or ACK; a missing checksum is a failed local check, never success.
`task decision record|supersede --json` also returns a bounded save receipt:
`data.taskId`, `effect: "saved"`, `data.decision` (identity, state, timestamps,
complete-record digest and rationale byte count). When the complete
saved record is at most 2048 UTF-8 bytes in JSON, `decision` also contains all
its fields and `contentOmitted` is false: callers can inspect the actual short
saved value directly, without a `read` follow-up pointer. Larger records set
`contentOmitted: true`, include an exact `read` command, and omit title,
rationale and supersede-reason bodies rather than truncate them. The digest
always covers the complete original record, excluding receipt-added fields;
`decision show` remains the complete read when needed. Human text is unchanged.
JSON callers must consume `data`
instead of parsing the previous `output` string. This confirms the saved state,
not semantic acceptance; a missing response never authorizes repeating a record.
Brief updates return a saved reference. No new wait, retry, acknowledgement or
approval phase is added. Repeating a read cursor must never repeat a mutation.

Whole-transaction operations (activation, completion, integration and input
control) remain atomic business operations even when their mechanics have
several steps. Their state-specific receipts and existing unknown-effect
diagnostics are retained; they are not flattened into a generic “executed” flag.

This change covers daily Agent context, collaboration discovery and original
evidence reads, not every diagnostic or export in the product. Existing
specialized log-tail/artifact limits, Task catalog pagination and bounded error
diagnostics retain their contracts. Configuration catalogs, Project/config
administration, resource inventories, archive diagnostics, release operations,
and specialized integration/changeset reads remain purpose-specific; this
document does not claim a universal 32 KiB cap for them. Full-detail Web
projections are separate consumers, not silently replaced with CLI summaries.
Use targeted Context discovery for large Project Knowledge and Task evidence.

For a typical notification, read current Context and the fixed wake, then obtain
only relevant originals not already returned in full (including their complete pages).
The focused wake JSON includes complete ordinary Message values up to 4 KiB
each and 8 KiB combined, marked `contentOmitted: false` with their current
versioned `ref`. Use those bodies directly. Larger messages and result reports
retain explicit reads; a completion notice never substitutes for its report.
For an inline complete value, `refreshRead` is an optional current-source refresh,
not a required next read; `read` is present only when the original is omitted.
Consumers that previously followed every `messages[].read` must first inspect
`contentOmitted` and use `value` for complete originals. Text output still links
to the original because it presents only a summary, not the inline JSON value.
The fixed window selects identities, not a historical snapshot of mutable
message bodies. Later revisions remain distinguishable by their exact reference.
History mode does not inline bodies. This changes no claim or ACK semantics.
The current Leader's `inbox show <wake>` also returns that focused view as
`originalContext`, with the existing wake metadata at the top level. It uses
the same identity selection, inline limits and exact original pointers as
`task wake show`; reuse the included complete bodies instead of making a second
read. Own-inbox authorization still applies, and the outer read retains
`contentPage` pagination. An unclaimed `pending-*` window has no fixed wake yet;
its claim receipt still supplies the durable wake and original-read command.
Claim/ACK mutations themselves are unchanged and do not perform extra reads.
For mutations addressed to an existing `wake-*`, the receipt now calls that
navigation `refreshOriginals`, not `originals`: use it when the focused originals
are missing, incomplete or need refreshing, not merely because a claim occurred.
Mutations addressed to `pending-*` retain `originals`, including idempotent claim
retries, because their initial inspection did not provide fixed originals.
This is a JSON navigation-field change; consumers must handle both entry types.
It records no read history and does not waive complete relevant-original reads.
Do not reread an aggregate to obtain a detail it intentionally omits.
Full-original reading costs additional calls only when the original exceeds
the inline budget; it is never replaced by a summary.
