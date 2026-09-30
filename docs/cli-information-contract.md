# CLI information contracts

Yui separates a command's effect from discovery and full evidence. Queries
never consume Messages or start subsequent work. Mutation receipts describe
saved/requested/accepted/unknown facts; `ok: true` means the CLI invocation
succeeded, not that a Task, native Turn or remote delivery completed.

This is the current wire contract, not a compatibility mode. Stored Tasks,
Messages, results, Snapshots and Session histories are unchanged. No persistent
schema migration or new snapshot/cache store is introduced.

## Daily read path

| Question | Entry | Default information / further reading |
| --- | --- | --- |
| Which Task? | `task list` | Existing bounded catalog, filters, attention and cursor |
| What is current? | `task context <task>` | Current Task/Brief/Role/Project/workspace facts, active work and Runs, open inputs, active decisions, unresolved jobs, recent Message references; no event or terminal-Run dump |
| What records exist? | `task context list <task> --store <family>` | One authorized family, summaries and exact digest-bearing references |
| What does it actually say? | `task context inspect <task> --store <family> --ref <id> --digest <digest>` | Exact current record, including original result expansion; long documents are paged |
| What changed? | `task context delta <task> --after <cursor>` | Immutable events with a fixed upper bound, not a snapshot of current mutable state |
| Which Global input? | `session context <role>` | Identity, profile, authority, current native Turn/retry and separate bounded pending/recent Message pages |
| Read Global input | `role message list <role> [--pending]`, `role message show <role> <id>` | Scoped discovery, then exact original; queue acceptance never erases history |
| What arrived in this wake? | `task wake show <task> <wake>` | Fixed window and Message/Run/Event read pointers, not duplicated bodies |
| What was assigned? | `task run context <task>/<run>` | Frozen authority and a single `pointers` inventory with summaries; changed identities in `deltaRefs`; current observations remain separate |
| Which configuration is real? | `task role session inspect <task> <role>` | Task/Role identity, desired binding, frozen Session, current Provider binding, retry and explicit Host observation; no full Task/Role copies or Provider conversation history |

Domain lists for Task Messages, events, WorkItems, Runs, decisions, milestones,
publications and InputRequests use the same summary/reference paging contract.
Task Role-status and wake-history lists also page, with explicit detail commands.
Context lists additionally expose candidates, reviews, jobs, Project Knowledge,
workspaces and other authorized record families. `--status`, `--after` and
`--work-item` narrow Context discovery; every continuation must retain filters.
Run listing accepts a Task or `task/work` target.

Current Context's `attention.messages` counts all authorized Messages, not only
undelivered input. `collections` counts and `omitted` explicitly describe
incomplete discovery. Recent samples are not proof that no older pending or
relevant input exists. Read the relevant fixed wake and original Messages;
use family discovery when a broader requirement/history audit is needed.

## Budgets and continuations

- Discovery pages default to 20 items, accept 1–100, and reserve a 32 KiB
  compact-JSON budget. Items contain summaries, never full Message/report bodies.
- Current Task Context has at most 64 records, with a 24 KiB record/attention
  budget inside a 32 KiB response budget. Single inline values are at most
  2 KiB; large values and Message/Run/WorkItem/Knowledge bodies use references.
  Each collection contributes at most eight sampled records at entry.
- Global entry samples up to eight pending and eight recent Messages separately.
  They have independent continuations, so a long historical list cannot crowd
  pending input out of the entry view.
- Detail documents up to 16 KiB remain ordinary JSON. Larger documents return
  `contentPage`: exact source, SHA-256 digest, JSON-character offset, total bytes
  and characters, text, completeness and a next cursor. Chunks contain at most
  4096 UTF-16 code units without splitting surrogate pairs, keeping escaped
  wire output below 32 KiB. There is no 4 MiB cutoff that makes a legal original
  permanently unreadable.
- Task metadata/next-action/remote-delivery, Brief, WorkItem, Message, Run,
  decision/milestone/event, Role show/status/Session inspection, wake detail,
  InputRequest, Run context and frozen expansion use bounded detail reads.

Use `--json` and read the top-level `data`. Run context and expansion use
`data.context`; Run Context delta uses `data.contextDelta`. For a long detail, repeat that same read with
`--cursor <contentPage.nextCursor>`. Concatenate `text` in offset order, checking
the same source and digest, and parse the combined JSON once. Do not parse
chunks individually or treat a first chunk as the complete report.

List responses carry `items`, `total`, `complete`, and `nextCursor`. Counts,
items and cursor validation occur inside the same authorized scope. Cursors
are opaque positions, not access tokens: every page reauthorizes. A changed
collection or document returns an explicit source-changed error; restart rather
than mix versions. No persisted pagination session is needed. Mutable collection
continuations intentionally do not promise uninterrupted traversal during
concurrent writes. For append-only event traversal use fixed-bound Context delta.
Discovery currently scans the selected authorized family to fingerprint it;
its output, not total storage-reading cost, is bounded.

## Effects and exceptions

Message send/queue/steer receipts preserve identity, digest, body byte count and
the original submission/delivery/control states without echoing the body.
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

For a typical notification, read current Context once, read the fixed wake once,
then read each relevant original once (or its complete document pages).
Do not reread an aggregate to obtain a detail it intentionally omits.
Full-original reading costs additional calls only when the original exceeds
the inline budget; it is never replaced by a summary.
