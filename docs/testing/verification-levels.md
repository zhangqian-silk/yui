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
The baseline cutover retires tests owned solely by the removed v1..v37
implementation. Their source/evidence remains in the frozen 0.16.2 release;
mixed tests retain current behavior, such as Review scope and Integration
completion boundaries.

Current coverage includes:

1. Fresh storage 1.0, exact schema/record validation, no initialization over
   unknown data, and rejection of old integer formats without mutation.
2. Independent v37 conversion: original intent/audit/counters, nested Session
   envelopes, opaque Context, rollback on invalid input, offline backup and
   repeat-call idempotence. The CLI fixture uses a disposable Home; it never
   converts a real account. The converter is not part of the runtime tarball.
3. Exact-version staging, mismatched-target refusal, same-major contiguous
   minor preflight, explicit maintenance-owner identity across handover, and
   restoration against captured protocol/storage identity rather than omitted fields.
4. Durable Task/Message/Decision context, draft activation authority, mailbox
   claims, notification idempotence, Session replacement and exact late results.
5. Integration/Job request identity, immutable candidate proofs, conflict
   continuation, Review scope and final acceptance without fabricated delivery.
6. Runtime/Host isolation, Provider protocol parsing and bounded retry using
   fake producers, current configuration provenance and native-account boundaries.
7. Workspace/GC authority, archive cleanup, resource CAS, telemetry, Web
   projections and authorized release recovery without real external effects.
8. Idempotent per-checkout launcher installation, exact argument/Home forwarding,
   refusal to overwrite unrelated files, and rejection of removed global-link
   commands before side effects. Development Home reset retains its independent
   identity checks and backup behavior.

Keep the test phase seconds-scale and measure build separately. Use the
existing assembled-package smoke for actual CLI/Controller/Host/tmux wiring,
not a second daemon matrix. Converter schema fixtures preserve one frozen
endpoint; do not reconstruct the entire historical chain in the new suite.
Real-model or real-Home checks require explicit authorization.
Current envelope checks reject arbitrary unknown fields, rather than maintaining
a blacklist of retired field names.

## Skill and instruction changes

Review the shared Runtime contract and affected Role/Project Skills together.
Check instruction boundaries with a few relevant scenarios: analysis remains
read-only, existing mechanisms are reused, Session loss preserves Task intent,
and execution failure does not prevent authorized supervision. This is a
bounded review, not a new permanent matrix or permission to use real models.

The package-start check follows local Skill references in the installed tree,
including cross-Role links. Entry points and their referenced Markdown must
ship together. File/format checks establish availability, not Agent behavior;
do not add prose-matching tests or claim model validation from static checks.

## CI and release

`ci.yml` builds once and runs core plus one assembled-package normal-path smoke
on every PR, without another lint or broad regression suite.
`node scripts/smoke-runtime-package.mjs --assembled .release-stage` exercises
the actual CLI/Controller/Host/SQLite and isolated tmux, replacing only the
external Provider with a deterministic fixture. It covers setup, durable input
and idempotency across restart, scratch activation, native result ingestion,
completion preserving the conversation, explicit reopen followed by one
idempotent Operator request and its exact native result, and archive releasing live/dead panes
and grouped viewers without affecting a similarly named neighboring session.
The fixture owns a fresh Home and its PATH, installs cleanup before setup,
and never calls an installed model Agent.

`publish.yml` runs the same smoke against the freshly installed package through
`YUI_INSTALLED_ROOT`, adding actual npm-bin, dependency, supported Node version,
artifact and provenance boundaries. This validates runtime integration, not
real-model behavior. Pure contract and safety tests remain in `test/core`;
production wiring is exercised here rather than only through mocked ports.
The package smoke also checks unconditional status identity and update-owned
resource/identity capture through the assembled package. Real lifecycle children
stop the exact Controller and restore its captured launch identity while their
parent holds the handover lock. Unrelated callers remain fenced, the lock stays
owned by the parent, and durable input survives. These checks have no installation
or publication effect.

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
