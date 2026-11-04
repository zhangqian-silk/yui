# Native title isolation (task-162)

The historical evidence in `managed-startup-title-diagnostic.md` still applies:
a second connection to the shared daemon is **not** an isolation boundary.
No shared-daemon `thread/name/set` call has been restored.

## Current path

- Codex user input remains unchanged. Skill-check/loading notices and retry
  recovery guidance use `additionalContext` with `kind: "application"`, on
  both start and steer. Native input parts (including images) and other client
  context are preserved. This contract was checked against schemas generated
  by the installed `codex-cli 0.159.2`, without a model request.
- Title proposals reuse existing Role/Task/Draft/instance-code formatters.
  Proposals are not application receipts and never acquire native ownership.
- The title observer uses task-161's `createNonBlockingChecks` lane verbatim
  from `1f1bc39d`; explicit compaction classification/context epochs reuse
  task-161's `0270fe26` interface. This change does not replace either of
  task-161's lifecycle state machines or edit its workspace.
- A new Thread is observed after accepted input (when native history can be
  materialized); a resumed Thread is observed after business startup. A
  standalone `app-server --listen stdio://` **process**, not `app-server proxy`,
  handles only initialize/read/name/read. It never starts/resumes a Thread,
  submits a Turn, or runs a model. Its account Home must match the business
  connection's returned account identity.
- Startup, Goal and Turn do not await this lane, its filesystem, or its native
  requests. A two-second process deadline and bounded owned-process teardown
  contain an unanswered mutation; there is no automatic rename retry.
- Only an unnamed new Thread or a currently matching previously generated name
  is eligible. Native names are rechecked immediately before the write.
  Observed native rename events and interactive user rename requests cancel
  the attachment's lane. A successful RPC alone is insufficient: exact
  Thread/name readback is required for confirmation.
- The exclusive per-identity writer and fsynced intent precede mutation.
  `submitted`/`unknown` receipts or an abandoned writer directory block future
  attempts, including reconnect. A new attachment does not reset this fence.
  Confirmed receipt history permits later format changes without claiming
  arbitrary existing names. Receipt identity includes scope, Task (if any),
  Role, Agent, Thread and native account; logs expose status, attempt and path.
  The Home transition is 1.26 → 1.27 with no historical data rewrite.

## Historical pollution and repair

An observed name/preview beginning with `Yui Host checked current Skills;` or
`<!-- yui:skills-checked -->` is a **candidate**, not proof of ownership.
The Host reports it without mutation when no confirmed generated-name
provenance exists. An unnamed resumed Thread is not treated as a new Thread.
Users may deliberately choose identical wording; prefixes alone must never
authorize a repair.

For an authorized historical repair, first bind the exact account, Thread and
Yui Session, inspect the current explicit name versus its preview, and check
the original first input and retained naming evidence. Preserve any explicit
manual name. Missing evidence remains a diagnostic. A user-requested exact
native rename is a separate effect; this implementation does not bulk scan,
rewrite native files, delete uncertain receipts, or infer that old unknown
requests are safe to repeat.

## Verification boundaries

Deterministic fixtures exercise actual separate processes, successful
readback, lost replies after persistence, duplicate/unrelated replies,
intervening manual edits, account mismatch, reconnect and business progress.
The previous shared-daemon stall remains enabled in the business fixture:
accidentally restoring that naming call prevents the test from completing.

This is not paid-model or production-native validation. No shared daemon was
restarted and no production conversation was renamed. Native client display
caches may require refresh because the separate metadata process does not
broadcast on the business connection. Current execution-environment snapshots
are trusted-local directories and use the same exact account check; an absent
or mismatched native account identity skips naming with a diagnostic.

The native API has no expected-name/revision compare-and-swap. Already observed
manual edits are protected, including edits between intent persistence and
the pre-write read, but an unobserved external edit in the final read/write
race cannot be made atomic by this client. No stronger concurrent-edit
guarantee is claimed. Older native servers that do not implement
`additionalContext` are outside this verified protocol contract; there is no
fallback that silently reinserts metadata into user input.

## Local delivery evidence

On Linux x64 / Node 24.20.0, `npm test` completed with 1,025 passed,
8 optional-driver skips and no failures (test phase 29.82 seconds).
The assembled-package `smoke-runtime-package.mjs --profile full` passed in
114.16 seconds, including the actual trusted-local Task title receipt and
native fixture readback, application-context separation, lifecycle and cleanup.
The fixture Home/processes and temporary assembly were released. This is
Leader self-review and isolated verification, not independent review or
production-native compatibility certification.
