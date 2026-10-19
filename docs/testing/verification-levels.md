<p align="right"><strong>English</strong> | <a href="./verification-levels.zh-CN.md">简体中文</a></p>

# Verification policy

Yui is a single-user local product. Permanent verification protects essential
happy paths and a few critical, easily changed correctness boundaries. It is
not a historical catalog of every defect or edge case.

## Local development

Use the smallest evidence needed for the current change. Retain a focused
regression when all of the following apply:

- Failure would lose durable intent, cross an authority/isolation boundary, or
  prevent an Agent/Operator from making legitimate progress.
- The boundary is shared by frequently changed code or has already failed in
  a realistic execution.
- The check is deterministic, uses disposable local fixtures, runs in
  milliseconds, and asserts observable behavior rather than incidental layout.
- Equivalent coverage is not already present; prefer one coherent scenario
  over separate cases for each historical symptom.

Keep broad fault matrices, real-model exercises, malformed-data combinations
and incident-specific scripts temporary. Remove their harnesses after the
change, preserving useful reports. Real-resource results do not replace fast
regressions, and fast regressions do not establish real-model behavior.

## Coverage, not test count

Keep three complementary kinds of evidence: a few normal paths through real
entry points and component wiring; critical regressions for durable intent,
idempotency, authority, isolation and historical storage; and cheap pure-logic
checks for meaningful branching. A passing suite proves its assertions, not
the absence of every bug.

Pin constants that are persisted or public contracts (event names, protocol
identifiers, historical encodings), with an independent literal expectation.
Where possible, also prove the current reader understands migrated data.
Do not derive expected and actual values from the same constant, or lock an
internal default merely because it is a constant.

Merge tests only when each assertion has an identified surviving scenario.
Identical constant checks and repeated setup can be consolidated; similar
names do not make Task and Global authority boundaries interchangeable.
Do not target a particular test count or delete safety checks to hit a time
budget. A temporary deliberate fault can confirm that a critical check detects
its intended regression; no permanent mutation service or broad fault matrix
is required.

## Permanent core smoke

`npm test` and `npm run test:core` build the checkout and run the maintained suite.
Both include `test/core` and `test/platform`. For an already built checkout,
`npm run test:business` runs only `test/core` and `npm run test:platform` runs
only `test/platform`; neither rebuilds. CI owns one explicit build per job.
The stable suite owns current storage 1.20 and its declared 1.0 through 1.19 minor
transition. It contains no undeclared historical format compatibility path.

Current coverage includes:

1. Fresh storage 1.20, exact schema/record validation, no initialization over
   unknown data, and rejection of old integer formats without mutation.
2. Exact-version staging, mismatched-target refusal, same-major contiguous
   minor preflight, explicit maintenance-owner identity across handover, and
   restoration against captured protocol/storage identity rather than omitted fields.
3. Durable Task/Message/Decision context, draft activation authority, mailbox
   claims, notification idempotence, Session replacement and exact late results.
4. Integration/Job request identity, immutable candidate proofs, conflict
   continuation, Review scope and final acceptance without fabricated delivery.
5. Runtime/Host isolation, Provider protocol parsing and bounded retry using
   fake producers, current configuration provenance and native-account boundaries.
6. Workspace/GC authority, archive cleanup, resource CAS, telemetry, Web
   projections and authorized release recovery without real external effects.
7. Idempotent per-checkout launcher installation, exact argument/Home forwarding,
   refusal to overwrite unrelated files, and rejection of removed global-link
   commands before side effects. Development Home reset retains its independent
   identity checks and backup behavior.
8. Failure isolation for optional Controller maintenance, individual retry
   Sessions and Task continuation observation, with scoped errors and no
   fabricated delivery, cancellation or quiescence.
9. Activation-source handoff without replay, Brief guards across same-timestamp
   input, Home/baseline-bound fixed event windows, and complete frozen-ref deltas
   with removals. These deterministic checks establish contracts, not a model's
   semantic conflict judgment.

Keep the test phase seconds-scale and measure build separately. Use the
existing assembled-package smoke for actual CLI/Controller/Host/tmux wiring,
not a second daemon matrix. Do not reconstruct retired storage paths in the
stable suite. Real-model or real-Home checks require explicit authorization.
Current envelope checks reject arbitrary unknown fields, rather than maintaining
a blacklist of retired field names.

## Skill and instruction changes

Review the shared Runtime contract and affected Role/Project Skills together.
Managed Skills ship a separate integer `VERSION`; bump the owning version for
substantive body or required-reference changes. The per-turn read reports current
stable paths/versions, not remembered model state or a historical load receipt.
Regressions cover pre-1.5 Session records upgraded from an isolated 1.4 Home,
current Skill loading on resume, preserved original queued input and newly
arriving suffixes, plus missing current files versus missing audit packages.
Check instruction boundaries with a few relevant scenarios: analysis remains
read-only, existing mechanisms are reused, Session loss preserves Task intent,
and execution failure does not prevent authorized supervision. This is a
bounded review, not a new permanent matrix or permission to use real models.

The package-start check follows local Skill references in the installed tree,
including cross-Role links. Entry points and their referenced Markdown must
ship together. File/format checks establish availability, not Agent behavior;
do not add prose-matching tests or claim model validation from static checks.

For review-material handoff and the small original development corpus, see
[review evaluation](review-evaluation.md). Its offline contract probes and
adjudication aggregation are deterministic; they do not run or measure a model.

## CI and release

`ci.yml` runs on PRs and master. Business contracts and full package business
wiring run once on Linux x64/Node 24. Platform tests run on Linux Node 24/26
and Mac Intel/Apple Silicon Node 24. Every job builds exactly once, without
another lint or implicit pretest build. Keep the existing job names for branch
checks; the complete workflow must pass for the exact master commit.

| Evidence | PR/master | Exact release tarball |
| --- | --- | --- |
| Business/state/authority contracts (`test/core`) | Linux 24 once | Reuse exact-SHA successful Core CI |
| OS/helper/PTY/Git/SQLite boundaries (`test/platform`) | Linux 24/26, both Macs 24 | Real SQLite SQL/GC on all 12 installs; other installed boundaries below |
| `full` smoke: business Jobs/Schedules + lifecycle + compatibility | Linux 24 once | Reuse exact-SHA business evidence |
| `lifecycle` smoke: restart, Session/Host handoff, archive + compatibility | Both Macs 24 (Linux included in full) | Node 24 on each of the 3 platforms |
| `compatibility` smoke: setup, CLI/bin, helpers, Doctor/PTY/SQLite | Linux 26 (included in other profiles) | All 3 platforms × Node 20/22/24/26 (included in lifecycle on 24) |

`node scripts/smoke-runtime-package.mjs --assembled .release-stage` exercises
the actual CLI/Controller/Host/SQLite and isolated tmux, replacing only the
external Provider with a deterministic fixture. It covers setup, durable input
and idempotency across restart, scratch activation, native result ingestion,
completion preserving the conversation, explicit reopen followed by one
idempotent Operator request and its exact native result, and archive releasing live/dead panes
and grouped viewers without affecting a similarly named neighboring session.
The fixture owns a fresh Home and its PATH, installs cleanup before setup,
and never calls an installed model Agent.

The default `full` profile also checks public Jobs, both service Schedule targets,
real local Project fast-forward, Task delegation and Agent Job routing. Independent
service targets are created before awaiting either result, retaining each target's result
and isolation assertions. These are business wiring, not an ABI matrix.

`publish.yml` builds one archive containing all three native targets and runs
the profiles above against that exact freshly installed package through
`YUI_INSTALLED_ROOT`, adding actual npm-bin, dependency, supported Node version,
artifact and provenance boundaries. This validates runtime integration, not
real-model behavior. Pure contract and safety tests remain in `test/core`;
production wiring is exercised here rather than only through mocked ports.
The same release matrix runs `test/platform/sqlite-native.test.js` against the
installed consumer: selected-driver allocation/GC plus real SQL, transactions,
JSON/RETURNING, WAL and backup for each usable optional SQLite candidate.
An unavailable optional candidate is explicitly skipped, not reported as
compatible; the normal selected-driver path must still pass. Doctor smoke
reports the selected driver, engine and fallback reason. This matrix does not
prove old-glibc compatibility.
Pure selector/classification branches remain in `test/core/sqlite-driver.test.js`
and run once. Do not duplicate native PTY/SQL probes immediately before the same
installed Doctor/native-SQL checks; the repository dependency cache is still
verified after building. Never reuse a consumer's native binaries across ABIs.
The native dependency check launches a fixed local program through PTY and
requires its output and normal exit. Installed-package smoke explicitly checks
default Doctor's PTY results using dependencies resolved from the consumer.
On macOS it also tests a disposable copy with a non-executable spawn-helper:
Doctor must report the selected helper path and permissions without repairing it.
Doctor's isolated PTY probe waits up to 750 ms for output/exit, with a 1.5-second
outer native-process limit, and reports elapsed time. Existing Agent/Controller
diagnostics have their own costs; this is not a one-second whole-Doctor guarantee.
The package smoke also checks unconditional status identity and update-owned
resource/identity capture through the assembled package. Real lifecycle children
stop the exact Controller and restore its captured launch identity while their
parent holds the handover lock. Unrelated callers remain fenced, the lock stays
owned by the parent, and durable input survives. A live Operator Host also spans
that replacement: a Desktop-direct terminal is persisted during Controller
downtime, then the successor drains the queued user input and engineering notice
without changing their original identities or replacing the Host. This is a
current-contract process-handover regression, not proof of compatibility with
every historical Host build. These checks have no installation or publication
effect.

Smoke logs report `TIMING` phases and total, including cleanup. Measure source
build, dependency installation/cache restore, pure test time and npm install
separately. Actions elapsed time includes queue and re-runs; report those
separately instead of treating workflow wall time as test execution time.
Existing npm/native caches and the exact-tarball checksum/provenance gates remain
unchanged. Registry installation, release-asset byte comparison and updater
verification attest different boundaries; do not remove them as “duplicate”
without equivalent identity-bound evidence.

Configured Agents acting as developers or reviewers are ordinary execution
resources. Using a live provider or model as the subject of validation is
different: paid APIs, shared Homes, production systems, real account quota, and
other non-disposable external effects are never implied by a request to test or
validate. They require an explicit user request for the exact resource and
effect boundary.

For authorized real-model probes, distinguish native acceptance, exact Turn
completion and independently checked work (files, tests, commits and Task
facts). A missing echo marker is not a functional failure. After Session
replacement, verify the successor read the original input and correlate its
own terminal; do not require every historical wake to receive that terminal.
Check normal completion/archive before stopping execution, since stop/cancel
cleanup is a different path. Preserve these evidence distinctions in the report.
