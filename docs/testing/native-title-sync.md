# Native title isolation (task-162)

The historical evidence in `managed-startup-title-diagnostic.md` still applies:
a second connection to the shared daemon is **not** an isolation boundary.
No shared-daemon `thread/name/set` call has been restored.

## Current path

- Codex user input remains unchanged. Necessary Skill-loading notices and retry
  recovery guidance use `additionalContext` with `kind: "application"`.
  Start and steer preserve native input parts (including images) and other client
  context. This contract was checked against schemas generated
  by the installed `codex-cli 0.159.2`, without a model request.
- Routine checks stay inside the Host: unchanged input sends no Skill context,
  marker or success report. Only cold attachment, explicit context loss/compaction
  or changed Skill metadata supplies actionable loading pointers. A failed Turn
  on the same attachment does not imply lost context. Recovery instructions are
  separate from the original user input and never duplicate it as application
  instructions. Guidance does not encode retry policy; engineering owns it.
- Title proposals reuse existing Role/Task/Draft/instance-code formatters.
  Proposals are not application receipts and never acquire native ownership.
- Upstream task-161 (`9d6a585e`, PR #497) is integrated. The title observer reuses
  its `createNonBlockingChecks` lane and explicit context epochs. Its two
  lifecycle state machines, safe Host upgrade and on-demand Skill hook remain
  authoritative; this change does not replace them or edit its workspace.
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
  The Home transition is 1.27 → 1.28 with no historical data rewrite.
  Upstream's existing 1.26 → 1.27 Host-upgrade transition is preserved.

## Historical pollution and repair

An observed name/preview beginning with `Yui Host checked current Skills;`,
`Yui Session Manifest:` or `<!-- yui:skills-checked -->` is a **candidate**,
not proof of ownership.
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
Field separation does not establish that every native auto-title heuristic
ignores application context. Readability instead relies on the existing
canonical title formatter and a separately confirmed explicit native name;
unknown naming outcomes remain diagnostics, not a success claim.

## Local delivery evidence

On Linux x64 / Node 24.20.0, `npm test` completed with 1,045 passed,
8 optional-driver skips and no failures (test phase 30.11 seconds).
The assembled-package `smoke-runtime-package.mjs --profile full` passed in
116.66 seconds, including the actual trusted-local Task title receipt and
native fixture readback, zero-notice warm inputs, application-context separation,
safe Host upgrade, lifecycle and cleanup. The real Host/Controller recovery
fixture also verifies unchanged original input and no repeated Skill context.
The fixture Home/processes and temporary assembly were released. This is
Leader self-review and isolated verification, not independent review or
production-native compatibility certification.
