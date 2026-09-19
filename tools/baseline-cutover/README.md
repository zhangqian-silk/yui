# One-time Yui baseline converter

This archive is separate from the Yui runtime. It accepts only the frozen
0.16.2 storage v37 contract and converts it to the distinct storage 1.0 baseline.
It does not contain or execute the full historical upgrade chain.

Equivalent indentation in `home_meta` is accepted without relaxing its columns
or constraints. Conversion archives the original DDL and recreates only that
table with the target's canonical definition, preserving its rows exactly.
Other schema objects and the complete ledger still require exact matches.

Use Node.js 20.17+, 22.9+, or 24 on Linux. Supply a separately installed new
Yui package directory, including its native dependencies:

```sh
node cli.mjs --home /absolute/stopped/home --runtime /absolute/new/package
node cli.mjs --home /absolute/stopped/home --runtime /absolute/new/package \
  --apply --backup-dir /absolute/new-backup-directory
```

The first command is read-only; the second requires explicit operator authority.
Read `docs/storage-baseline.md` or `docs/storage-baseline.zh-CN.md` in the new
runtime package before applying. They specify settlement, process ownership,
full backup, audit preservation, cold startup and rollback boundaries.

Never run on a live Home. Never delete unknown locks, infer missing ownership,
or downgrade by overwriting only the database. Keep the old 0.16.2 package and
the complete backup until the conversion has been verified and accepted.
