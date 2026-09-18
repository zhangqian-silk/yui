# Storage baseline 1.0

Yui 0.99.1 is the clean runtime baseline. Package version `0.99.1`, Home
storage version `1.0`, record envelope version `1`, and Controller protocol `1`
have different responsibilities. The later 1.0.0 package uses this same storage
contract; it must not reset it again.

## Current runtime

- `storage_schema` contains one authoritative identity: format, major, minor,
  schema checksum and creation time. JSON APIs expose storage versions as
  canonical strings such as `"1.0"`, not floating-point numbers.
- New Homes execute the complete current DDL once. They do not replay the old
  v1..v37 ledger. Ordinary reads validate the current identity, physical schema
  and typed records; they never normalize data.
- Explicit `upgrade` / `update` can apply only a complete, contiguous **minor**
  path within one major. The initial 1.0 baseline has no minor steps.
  Cross-major, downgrade, unknown and old integer formats fail before activation.
  An exact package selector is not permission to cross a storage major.
- Yui-owned record envelopes start at 1. Host control uses the distinct
  `yui-agent-host-control/v1` identity, so it cannot accidentally adopt an old
  `yui-agent-host/v1` producer. Context/Run/Host-event/Driver contracts already at
  v1 remain there. External Provider protocols and package versions are unchanged.
- Business revisions, authority epochs, IDs, event sequences, native data and
  immutable Context resources are not schema versions. Never reset them.
- `storage_migration_archive` is opaque audit evidence, not an executable
  compatibility reader. Old numbers and original bytes in audit remain intact.

The runtime tarball contains neither historical migration modules nor the
standalone converter. Source-level history and previous published packages
remain available for explicit diagnosis, not automatic runtime fallback.

## One-time conversion from 0.99.0

The independent `yui-baseline-cutover` archive accepts only the exact frozen
0.99.0 schema and its complete v37 ledger. Older Homes must first use 0.99.0.
It never runs the old migration chain itself.

1. Using 0.99.0, settle active Runs, Jobs, claimed notifications, in-flight
   retries and unconfirmed effects. Preserve queued intent rather than marking
   it completed. Stop managed Sessions and the Controller. `session stop --all`
   refuses busy Sessions; it is not authority to force-stop or discard work.
2. Stage the published 0.99.1 package in a separate installation prefix, with
   its native dependencies installed. Do not overwrite the global CLI or try to
   run the new Controller against the old Home.
3. Verify the converter archive checksum, unpack it, then use its entrypoint.
   The examples below use **placeholders**, not a production Home:

```sh
node /absolute/converter/cli.mjs \
  --home /absolute/home --runtime /absolute/staged/package

node /absolute/converter/cli.mjs \
  --home /absolute/home --runtime /absolute/staged/package \
  --apply --backup-dir /absolute/new-backup-directory
```

`--runtime` names the package directory containing `package.json`, `dist/` and
available dependencies, not its `bin/yui` entrypoint. The default invocation is
read-only. `--apply` requires a new backup directory outside Home, under an
existing canonical parent. Run from an external Operator shell, not a managed
Task or a Session that is itself being converted.

The tool refuses active durable execution, pending outbox operations, active
Session bindings, recorded live processes, observable processes referencing
this Home/database, pending native Inbox files and unfinished Controller
handover/discovery. Unknown identity for a recorded owner remains a blocker;
unrelated user processes are not adopted or terminated. Stop unmanaged writers
and external workspace editors too; a file copy is not a filesystem snapshot.
The maintenance fence and SQL write transaction protect the conversion.

Before mutation, the tool copies Home and creates a self-contained SQLite
backup with checksum. It converts only named Yui envelopes and active typed
verification plans, preserving each changed payload and the original ledger in
audit. User text, native payloads, frozen Context bytes, Git data, dirty files,
IDs, counters and Task outcomes are preserved.

Old `active-release.json` and `runtime-identity.json` are archived in
`retired-runtime/`, not relabelled as observations of the new runtime. The tool
also verifies and converts the typed isolation owner markers at the declared
runtime inventory paths, retaining their originals and recomputing only the
format-dependent fingerprint. Resource paths, namespace and port allocations
do not change. Unknown markers or links remain blockers. The tool
does not resume old Hosts, update the global installation, start a Controller,
or submit model input. After a successful conversion, use the staged 0.99.1 CLI
to install the exact package and start only the new runtime. Start new managed
Sessions through the ordinary explicit lifecycle; history is not live authority.

## Evidence and recovery

Success is `outcome: converted`, target `1.0`, with the exact backup path.
Repeating against a valid current Home returns `already-current` without
creating another backup or rewriting records.

- `backup/home/` preserves the Home tree; `backup/yui.db` is the consistent
  standalone database snapshot; `receipt.json` identifies source, target,
  checksum and completed conversion. `retired-runtime/` preserves old bindings.
- A validation failure rolls back the SQL transaction and restores runtime
  bindings moved by that attempt. If restoration cannot be proven, the error
  names the retained files; keep Home stopped.
- A crash or receipt-write failure is not proof that storage stayed old.
  Inspect the actual format and backup before choosing recovery. There is no
  automatic repair worker or speculative replay.
- To roll back, stop all new writers, preserve the failed/new Home separately,
  and restore the old Home tree plus the standalone `yui.db` at the **same**
  original Home path, without mixing in newer WAL/SHM files. Use only 0.99.0.
  Review the converter-owned lock in the snapshot by exact process identity.
- After new business writes, restoring the old backup loses those writes.
  Recovery then needs an explicit disposition; never restore automatically.

Real Home conversion and publication require separate user authorization.
Isolated fixture evidence does not claim that a particular production Home is
ready to convert.
