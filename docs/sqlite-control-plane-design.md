<p align="right"><strong>English</strong> | <a href="./sqlite-control-plane-design.zh-CN.md">简体中文</a></p>

# SQLite control-plane storage

Yui has one authoritative product Store: `YUI_HOME/yui.db`, in WAL mode.
`storage_schema` contains its single **major.minor** version and schema
checksum. The clean baseline is **1.0**, introduced by package 1.0.0-alpha.

## Authority

- SQLite owns Tasks, WorkItems, AgentRuns, Messages, Decisions, results,
  Project Knowledge, workspace records, runtime bindings, mailboxes, events
  and configuration.
- Provider Sessions, transcripts, processes, caches and telemetry support
  execution and diagnosis; they do not replace durable Task truth.
- Record `schemaVersion` tags validate current envelopes. They are not
  separately writable upgrade versions.
- `storage_migration_archive` preserves opaque original payloads and binary
  audit evidence. It is not a compatibility reader, scheduler or cache.

## Admission

Ordinary opens require the exact current format/version/checksum, the current
physical schema objects, and valid typed records. A missing database in a
non-empty Home or a missing format identity is not permission to initialize.
New Homes execute the final baseline DDL once, without replaying old DDL.

Writes, ordinary reads, bounded Context pages and full-Home diagnostics share
the current domain validators. Invalid records fail without normalization;
failed writes do not advance the Home revision. An open writer rechecks its
captured schema identity before every mutation.

## Write and concurrency contract

- Each mutation is a SQLite transaction; WAL plus `synchronous=FULL` is the
  durable commit boundary.
- `home_meta.revision` is the Home-wide CAS/revision, not a format version.
- Indexed typed columns support exact identity/status queries; full validated
  payloads remain the durable domain representation.
- Mailbox claims, exact Run terminalization, active-pointer removal, result
  persistence and downstream notifications commit together where they express
  one product fact.
- Idempotency and unique constraints protect confirmed external effects,
  without inventing a second planning protocol.

## AgentRun and Session boundary

An AgentRun records an explicit execution request, visible input and original
result, not hidden reasoning. A native Session may contain several Runs and
ordinary conversations. Notifications alone do not create Runs; only exact
native evidence settles one. WorkItem and Task acceptance remain Agent-owned.

## Update behavior

Version APIs expose `"1.0"` strings, not floats. Default `upgrade` / `update`
supports only a known contiguous minor path within the same storage major.
The initial baseline has no such steps. Cross-major and old integer formats
require an independent explicit converter; they never enter a runtime fallback.
The updater preflights the exact staged package before activation, then rechecks
under its maintenance fence. Unknown ownership remains a blocker.

See [Storage baseline 1.0](./storage-baseline.md) for the independent old-v37
conversion, backup/rollback, artifact boundaries and cold startup procedure.

## Unified Home layout

Self-managed data stays under one canonical Home: Task worktrees under
`workspaces/tasks/<task>/<owner>/<project>`, Global scratch under
`workspaces/global`, runtime data under `runtime`, and backups under `backups`.
Explicit external Project inputs keep their external-resource semantics.
Only deliberately short IPC socket paths may live outside Home.
The converter does not relocate workspaces or rewrite their Git identities.
