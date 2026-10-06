# Collaboration evaluation — implementation in progress

This research entry is deliberately outside `npm test` and core CI. It measures
deterministic scripts using Yui persistence and discovery, not model coding
ability, Agent understanding, or real-service reliability.

The first vertical slice implements **O02/F only**: a local stateful notification
simulator commits an effect and loses its response; Yui records the original key
and unknown outcome; after an isolated Controller restart, the script discovers
the original through Context/message reads, queries that key, and persists a
matching receipt without another send. The independent evaluator inspects the
effect ledger and bound receipt. Controller restart is **not** Session replacement
and does not count as P-mode coverage.

## Run, then analyze

Use supported Node (24 recommended) and the repository's isolated launcher:

```sh
make install-local
node scripts/collaboration-eval/run.mjs \
  --version /absolute/path/to/Yui \
  --case O02 \
  --out /absolute/path/to/a-new-report-directory
node scripts/collaboration-eval/analyze.mjs /absolute/path/to/a-new-report-directory
```

The report directory's parent must exist. An existing report directory is refused
before fixture creation. Each invocation reserves a new directory and stores
append-once `evidence.json` plus its SHA-256. `record.json` without complete evidence
means the invocation did not finish saving; analysis must not fill in its history.
The analyzer only reads saved evidence, validates its digest and prints a derived
report to stdout. It imports no runtime/runner and never creates a Home, contacts
the CLI, or reruns a case. Hashes detect accidental changes, not an attacker who
rewrites both evidence and hash.

The execution manifest records target commit, dirty status, CLI and lockfile
hashes, harness/strategy/oracle hashes, Node/platform, and raw CLI receipts.
The first slice uses fixed synthetic inputs and seed 89 (no random strategy).
Only the selected O02 condition belongs to this invocation's denominator; this
must not be described as a 24-case baseline.

Each run owns a fresh temporary user directory, YUI_HOME, fake Provider executable,
and tmux namespace. The fake executable is the existing package-smoke fixture;
this slice never activates an Agent. It cannot fall back to a real model.
Cleanup is installed before `setup` and runs on ordinary success or exceptions.
Controller stop and scoped tmux cleanup precede directory removal. On cleanup
failure, ownership paths and failures are retained in evidence. A hard process kill
is not a cleanup receipt; inspect retained ownership before recovery.

Current bounds: 90 seconds for O02 execution, 60 reads, 2 MiB query output, a
20-second per-CLI bound, and bounded cleanup. Reads include failed calls and
pagination. Bytes are UTF-8 stdout/stderr bytes, never token or price estimates.
The trace separates preparation, queries, writes and cleanup; model consumption
and human preparation effort are not inferred.

## Focused verification

```sh
node --test scripts/collaboration-eval/check.mjs
```

This checks append-once evidence, tamper detection, failed-condition denominators,
unknown-effect reconciliation, and deliberate duplicate/wrong-receipt failures.
It is not proof of Session handoff, authority isolation or the remaining cases.

## Outstanding Task acceptance

The pinned v3 plan remains authoritative. Still outstanding: five-type 24-case
integration; 18/6 split and four variants; genuine P-mode predecessor/successor
lifecycles for C05/W01/R02/A03/O02; frozen-Run/acceptance and multi-repository
boundaries; selection, cancellation and fair A/B comparison; dev-then-frozen-holdout
baseline; manual document/research rubrics; full Task-level delivery validation.
The Task is not complete. Product optimization must follow evidence, not this
single normal scripted outcome.
