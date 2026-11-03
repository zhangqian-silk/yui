# Historical context-cost measurement

Read-only, local Codex rollout analysis. This is **exploratory cost attribution**,
not current B0, behavioral evaluation, a holdout, model validation or a cost-saving
claim. No provider/network calls, Yui state writes, original-text export, or new
runtime service. Node 24.20+ is required for native streaming Zstandard support.

This retained historical-source adapter is an optional entry from the
[evaluation tools](../eval/README.md) and
[context analysis guide](../../docs/evaluations/context/README.md), not the
default experiment runner or a universal online importer. Select authorized
roots and windows explicitly; do not scan unrelated sessions. Its rollout
usage/continuation contract below differs from app-server context-run evidence.
It neither creates plan/preflight/seal records nor supplies semantic quality
judgments. Keep this directory with deliveries that expose this analysis entry;
historical experiment attachments are not required.

## Run

```sh
node --test scripts/context-cost/check.mjs
node scripts/context-cost/run.mjs \
  --sessions-root /local/codex/sessions \
  --task-workspaces /local/yui/workspaces/tasks \
  --leader-first 122 --leader-last 149 \
  --operator-id ROOT_THREAD_ID \
  --operator-tail /local/codex/sessions/DATE/rollout-ROOT_CONTINUATION.jsonl \
  --operator-tail-bytes 168016975 \
  --cutoff 2026-10-22T07:29:52.562Z \
  --output output/context-cost/unique-study-directory
```

Use the exact locally authorized paths/identity, not these placeholders.
The output is `aggregate.json` (exclusive creation; reruns need a fresh directory).
It contains only paths/identities, digests, numeric aggregates and methodological
qualifications. Keep it in the ignored local `output/` tree; have the authorized
Leader pin it to Task artifacts before workspace cleanup. Do not add rollouts to
Git. The report records the full command, cutoff, Node version, checkout SHA and
an independent SHA-256 of each script; a dirty checkout SHA alone is not evidence
of which measurement code ran.

## Evidence and boundaries

- Discovery reads only each candidate file's first `session_meta` line. Bodies
  are read only after exact selection. `.jsonl.zst` is streamed, not extracted.
  No cache or copied original dataset is created. Directory metadata may identify
  relevant child executions, but their bodies are not measured.
- A Leader root must have the exact Task `main` cwd, no `parent_thread_id`,
  `forked_from_id` or `source.subagent`, and consistent root/session identity.
  Cwd alone is not a root proof. Multiple root IDs for a Task are reported as
  ambiguous, not silently combined. Missing roots remain missing.
- Continuations are resolved backward by `history_base.thread_id` to a unique
  segment filename identity within the same root. The predecessor prefix ends
  at **both** `end_byte_offset` (uncompressed bytes including LF) and
  `end_ordinal_exclusive`. Inconsistent, partial or missing boundaries fail.
  All source fingerprints hash exactly the measured, uncompressed prefix.
- Rollouts are treated as append-ordered histories. Timestamp cutoff stops at
  the first later record; `afterCutoffRecords` counts observed stop boundaries,
  **not** all later records. The supplied Operator tail byte cap is an additional
  bound. The report records actual prefix length, last ordinal and hash, so later
  appends do not change the frozen source. File size is only a local observation.
- Added visible characters count Unicode **code points** and UTF-8 bytes in
  `response_item` text, tool arguments/output and visible reasoning summaries.
  `event_msg` mirrors, task completion echoes, metadata snapshots and compaction
  replacement histories are not added again. Binary images, tool schemas,
  provider-fixed prompts, opaque reasoning and other non-text content are not
  measured. Payload string lengths are not wire JSON sizes or tokenizer counts.
- Duplicate visible volume is exact same-type text repetition, via in-memory
  SHA-256; hashes/text are not exported. It is neither semantic redundancy nor
  cache hits. Real repeated reads are still added volume, not discarded.
- Tool-output attribution follows matching `call_id` to the producing command.
  The pure Skill category is deliberately narrow. Multi-command, parallel,
  embedded-code, and multi-file reads remain mixed/unknown; a mixed output is
  not all Skill overhead. Poll outputs without command provenance remain
  unknown. Notification detection uses anchored Yui markers (also after a
  Manifest prefix), not semantic analysis; mixed envelopes are counted whole.
- Retained context is reconstructed from native response items and replaced
  by `compacted.replacement_history`. The compaction replacement volume is
  reported separately, never called newly delivered content. Metadata base
  instruction snapshots are separate observations, not repeated input.
- Exact request-before residence is **unknown**. Two keyed-usage-boundary
  proxies are reported: visible residence at completion and residence minus
  assistant items since the previous keyed usage. Base instruction text is
  included once in each sample. Request/response wire ordering, missing events,
  trimming and provider injection can differ; these are not exact model inputs.
  Do not sum final contexts from different sessions as one retained context.
- Skill-associated outputs during a reset window (until `task_complete`) are
  reported by `initial`, `continuation` and `compaction` cause. These are observed
  read-volume proxies, not proof that every read was required by recovery.
  Same-segment recovery without an explicit reset is unknown.
- Actual usage is summed only once per `(thread_id, response_id)` from
  `token_usage_record.usage`, including any keyed pointer in a compaction record.
  A conflicting repeated identity fails. `turn_token_usage`,
  `thread_token_usage` and repeated `token_count` snapshots are never added.
  Missing keyed records/fields and compaction IDs without keyed usage are
  explicit gaps. `compactionExactSubset` follows `compaction_response_id` and
  is a subset of exact usage, **not** an extra charge to add. Missing optional
  fields contribute zero **observed** tokens,
  not proof of zero use; inspect `exactMissingFieldRecords`.
- `token_count.info.total_token_usage` positive deltas are a **separate approximate
  cross-check**, with reset/unidentified-transition counts; they are never added
  to keyed usage. Counter transitions are not precise request identities.
  Cached input is a subset of input; reasoning output is a subset of output.
  No input+cached, byte-to-exact-token, token-to-fee conversion or paid-model run.
- Main roots exclude Worker/Reviewer/child/retry body costs. Metadata counts
  cannot establish execution-tree completeness. Legal disposition counts and
  per-disposition efficiency require separate authoritative handling evidence.
  Neither transferring work to children nor shorter notification text proves
  total savings, and new notifications do not erase retained historical notices.

The four small synthetic checks exercise byte/ordinal truncation and Unicode,
usage identity/snapshot/compaction separation, same-cwd child exclusion with
Zstandard input, and Manifest-prefixed notification/residence attribution.
Their temporary directories are deleted in `finally`; no Home, Controller,
tmux namespace, real model or account quota is created by this tool.
