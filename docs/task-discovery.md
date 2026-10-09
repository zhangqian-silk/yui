<p align="right"><strong>English</strong> | <a href="./task-discovery.zh-CN.md">简体中文</a></p>

# Bounded Task discovery

Agents discover candidates with `yui task list --json`, then
read the selected Task's Context and original Messages. The catalog is a
current read, not a summary database, a Context snapshot, an acknowledgement,
or an execution/acceptance decision.

The catalog is the only list contract; there is no `--view` selector or
`--verbose` full-history list. Internal interactive selectors retain their
complete `{id,title,status}` array and read only those columns. Web uses the
same query at `GET /api/dashboard`. The per-Task detail endpoint retains
execution, observability, usage and remote-delivery fields. Discovery itself
does not change persistent records.

Web labels catalog-wide attention separately from filtered/page-local lists.
Native Session activity is an explicit optional read at
`GET /api/dashboard/sessions` with the same compact page parameters. It observes
only that returned page, includes direct inputs without AgentRuns and shows its
own read time. It is not part of the compact query or its 32 KiB budget, and never
claims a global running-Session count. Changing page membership clears this
observation. Task status counts and raw signals remain separate from activity
and semantic progress.

## Query and page contract

### Project knowledge

Current Task and Run Context select active knowledge only from the bound
projects. `scope` and `expiresWhen` are free text: the Agent reads the original
and decides whether it applies to the actual task. Engineering does not infer
semantic expiry or execute knowledge content. Explicit Operator retirement
removes an entry from future current Context; frozen Run evidence is unchanged.
Context pointers expose applicability and version, with complete source and
prior versions available through the exact detail read.

`project knowledge list` and `project knowledge proposals list` return compact
`items/total/complete/nextCursor` pages (`--limit`, `--cursor`); `--all` includes
retired knowledge or decided proposals respectively. `show` returns the exact
knowledge/proposal, or `contentPage` for a long record: continue with its cursor
and concatenate `text` in offset order before parsing. Mutation receipts contain
identities, not the entire Project. Web’s Task Records → Project knowledge uses
the same paged discovery and exact source reader.

Proposal identity includes project, source Task/Decision/Milestone/commit,
title, body, scope, expiry condition and superseded knowledge ID. Only outer
whitespace is trimmed; internal whitespace, case and Unicode remain significant.
An omitted condition differs from a supplied one; omit a condition in a
replacement proposal to clear it upon `accept --update`. A repeated identical
proposal reuses its existing pending/accepted identity. Changed applicability
still requires the existing Operator approval, including explicit `--update`
for a same-title replacement. Each effective update or retirement increments
the formal version and preserves its exact prior content and provenance.

```sh
yui task list --project project-1 --status active --limit 20 --json
yui task list --attention openInputs --json
yui task list --search "candidate title" --json
yui task context task-1 --json
yui task context inspect task-1 --store task --ref task-1 --digest <digest> --json
yui task message show task-1/message-1 --json
```

`--project` accepts an exact Project ID. Search matches ID, title, tags and
Project name using SQLite substring comparison (ASCII case-insensitive;
non-ASCII characters compare literally). Default scope excludes archived
Tasks; `--all` or `--status archived` includes them. Counts declare that scope,
not an invisible global total. Status/search/Project/attention filters apply
to `total` and the returned Tasks, not the scope-wide attention summary.

The default limit is 20, maximum 100. Successful JSON responses, including the
CLI envelope, fit 32 KiB. UTF-8 summaries are at most 512 bytes; titles are
at most 256 bytes. Truncation is explicit. IDs, digests and cursors are never
truncated. Oversized mandatory metadata produces a bounded error, not a
non-progressing successful page. A missing Brief is reported as missing.

Order is ascending `(createdAt, id)` with SQLite binary ID ordering. Repeat
all filters and the limit with `--cursor <nextCursor>`. A null cursor ends the
page sequence; byte limits can end a page before its requested item limit.
The first page fixes the largest matching creation key. Newer creation keys
are excluded until refresh. Each later page reads current facts: lifecycle or
filter membership changes can affect the enumeration. This is not a frozen
snapshot, and unrelated runtime events do not invalidate a cursor.

Each Task and attention sample has a real Task Context ref
(`taskId, store, refId, revision, digest`). The digest covers the original
Task, not the clipped preview or Brief. Read Task Context for the current
Brief and use Context inspect for a digest-checked original. A changed digest
is rejected; a ref never grants authority or implies the requirement was read.

## Attention without full history

Every page, including a filtered empty page, reports the same authorized
catalog's current attention. Each category contains a record/signal count,
affected-Task count, up to four exact Task refs, omitted-Task-ref count, and a
filter for enumerating all affected Tasks:

Start that attention query without the previous status/search/Project filters
and retain its `all` flag. This preserves the declared catalog scope, including
archived Tasks when explicitly included.

| Category | Current stored facts |
| --- | --- |
| `openInputs` | Open InputRequests |
| `pendingOperations` | Queued/running durable Jobs |
| `unknownOperations` | Jobs with `unknown-needs-attention` |
| `executionSignals` | For active/draft Tasks: live Runs, open WorkItems or accepted WorkItems retaining a current replicated group, unresolved/failed Integrations, pending/running/failed Reviews, Leader failure, and pending/processing Leader mailbox |

`executionSignals` is deliberately conservative discovery, **not** the detailed
execution-status classifier. Healthy live work is included so runtime identity,
stall, failed-work and recovery attention cannot be hidden behind pagination
or require scanning every Task's historical events. Counts must not be read as
failure counts. Open the affected Task for its precise execution state and
source records; no report text is parsed into status. Web explicitly labels
these facts and offers category navigation. Selected detail survives paging,
filtering and refresh; only the detail read can establish absence.

Task Leader Sessions see only their own Task. Assignment-scoped Workers and
Reviewers use existing authorized Run Context instead of whole-Task discovery;
the catalog rejects their request before counting. Global non-Operator and
incomplete managed identities are rejected. Historical Leader diagnostic reads
retain their original Task scope. A cursor is scope/filter-bound continuation,
not a credential. Read operations do not consume messages, acknowledge jobs,
wake Roles or query providers.

## Cost boundary

SQLite queries existing catalog/status indexes and aggregates narrow facts
before selecting page rows. It does not decode all Task payloads, Runs,
Messages or Events into JavaScript, build all overviews and delete fields, or
construct per-Task Context. Only selected Tasks and bounded attention samples
are decoded and hashed for original refs.

Output and materialized rows are bounded. Database work still scales with
authorized Tasks and relevant index rows; search can inspect Task/Project JSON
inside SQLite. Exact refs still cost the selected original Task's payload size.
These are local cost boundaries, not constant-time or model-effect claims.
