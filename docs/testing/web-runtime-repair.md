# Task109 repair and extended verification

Date: 2026-10-10. Scope: Task109 `message-2`, continuing the same managed Task
after explicit authorization to fix defects in Task94–108 and continue tests.
The first completion, original report and red regression remain historical
evidence; they were not substituted for post-fix results.

## Changes and fixed defects

### 97/106: complete global-role configuration validation

Original reproduction: global CLI changed only `model` and saved an invalid
retained `effort`, although Web rejected the same resulting configuration.
The original real CLI/Controller/SQLite assertion remains in the smoke.

The CLI now previews the complete global-role binding, resolves its native
catalog, validates before mutation, and rechecks the exact candidate inside
the command transaction. Add/update and clear options use the existing
binding patch semantics. Web uses the same candidate construction and
validator. Profile and Task-role validation retain their existing preflight.
No fixture model names, model lists or effort policy were added to production.

The new fast regression failed before the correction with “Missing expected
exception.” After correction it proves:

- invalid retained effort rejects before any role/state-revision change;
- a simultaneous description change is not partially saved;
- a valid model/effort pair saves normally;
- invalid role creation saves no role;
- clearing effort remains supported.

The original process-level assertion now passes, including equality of
pre/post rejection settings and revision, legal CLI pair updates and clearing
effort. Repair commit: `d20f597b3e337a571da3c7b9447d6063121176ee`.

### 95: closing a read-only terminal disconnected other clients

The extended browser test exposed a second product defect. Two browser
windows shared the same native Thread: first writable, second read-only.
A third, actual WebSocket connection was also read-only and correctly ignored
injected input. Closing that connection then removed **all** grouped viewer
and writer sessions, although the original browser windows remained open.
The test failed on `terminalWriter === true`.

Read-only tmux inspection reproduced the result: before closing, the group
contained the Task host, one writer and two viewers; afterwards only the host
remained. This was not an upstream model failure or a screenshot inference.

The old `client-detached` hook killed its configured client session. A
notification after explicit destruction could execute a surviving session's
hook, causing cascading lease removal. The fix arms the session-local
`destroy-unattached` option from `client-attached`, after initial attachment.
It does not enable destruction while a new lease is still detached and
waiting for its first client. Explicit cleanup still names the exact session.

The unchanged browser assertion now passes. Closing a read-only connection
does not drop the original writer; closing the writer by returning to
conversation then releases it. Repair commit:
`6c97249c308eb7030ab624eaec13548aa381c035`.

## Fixed candidate and fresh results

Remote `master` was rechecked and remained
`c079c41d9ad40ff001b30cbf8ababfd65c4848a3`. The prior test delivery is
`870f1afc87f14385d65d8df605cdd7e1694e4dff`. All final executable checks below
ran on `6c97249c308eb7030ab624eaec13548aa381c035`; only documentation was
added afterwards.

Same isolated Linux x64 / Node 24.20.0 / tmux 3.4 environment as the first
record. Explicit checkout launcher, disposable Homes, actual
Controller/SQLite/Host/Runner, local-only Git remote, no live provider/account.

| Check | Fresh result |
| --- | --- |
| Focused launch-configuration and Web settings tests | 9 passed |
| Final `npm test` | 732 tests: 725 passed, 0 failed, 7 macOS-specific skips; 19.544s test duration |
| Real-process smoke, including final lifecycle cleanup | 12 passed, 0 failed |
| Real-browser journeys, desktop and 390px | 10 passed, 0 failed in the final fresh fixture |
| Newly assembled runtime package smoke | Passed: real PTY dependency, reopen/follow-up, update handover and lifecycle/neighbor cleanup |
| Source review and `git diff --check` | Passed; direct Leader self-review, not independent review |

The package was assembled anew with
`node scripts/assemble-runtime-package.mjs --output output/task109-repair/package`
and exercised with
`node scripts/smoke-runtime-package.mjs --assembled output/task109-repair/package`.
Use the [smoke instructions](web-runtime-smoke.md#run) for the browser/process
tests. No release, remote push, PR or merge was performed.

## Coverage update

This supplements the original 15-task matrix, preserving its layer labels:
**B** rendered browser, **P** real process boundary, **I** internal integration
with real storage/files and injected runtime ports where stated.

| Requirements | Newly executed evidence | Remaining boundary |
| --- | --- | --- |
| 94/95/103 same Thread and writers | B two terminal windows and an additional real terminal WebSocket; real Host relay, authenticated native resume, tmux and PTY. First input reaches native fixture, UI and raw-socket read-only writes do not. Thread/Turn unchanged; closing reader retains writer; returning to conversation releases writer and preserves draft. | The native UI is a deterministic protocol client, **not actual Codex TUI**. No real upstream terminal/model compatibility claim. |
| 94/103 target switching | B Task1 draft → Task2 empty draft → separate Task2 draft → original Task1 draft restored. No send. | Historical Session replacement/read-only browser journey still not covered. |
| 97/106 shared settings | P original invalid retained-effort failure now rejects atomically; valid pair and clear-effort succeed; Web/CLI values and revisions checked. New I regression covers add/update and partial-write safety. | Catalog is deterministic. Live model enumeration remains untested. |
| 98/104 pinned images | B actual PNG decoding, 200% rendered dimensions, actual browser download; original file is 68 bytes and its SHA-256 equals the pinned artifact digest. Markdown/script inertness and staged feedback rerun. | File upload and historical-target feedback remain internal-only, not new browser journeys. |
| 99/107 bounded retrieval | P 21 messages paginate 20+1 with disjoint identities; changed-query cursor rejects. A 9,218-code-point Unicode/CRLF original is fully rebuilt from bounded source pages. B results replace 20 rows with 1; exact source advances to a later page. Original Unicode/CRLF selected-reference test rerun. | Not an exhaustive large cross-task/history matrix. |
| 100 Knowledge | P exact replay, scope-only accepted version change, CLI/Web source agreement and retired filtering rerun. | Free-text expiry remains metadata, not semantic automation. |
| 101/108 Skill | P catalog/resource/bind/CAS/traversal, attachment-only next-launch version and immutable old frozen snapshot rerun. | New Worker Run freeze and rendered Skill binding remain outside the added journeys. |
| 102 usage | P unknown/null/empty actual amounts rerun; final core suite reruns attribution, cumulative dedupe, currency/estimate and source-boundary checks. | No real billing, priced-event process-restart journey or browser cost audit. |
| 105 Runner | P+B actual managed Job socket, iframe relative asset, GET boundary, explicit cancellation, exit receipt and owned socket cleanup rerun. | No new abnormal-crash/neighbor-Job fault matrix. |
| Storage/control internals | Final core run reruns supported 1.0–1.5→1.6 real SQLite migration fixtures, Global/Task exact control, Session replacement and unknown-no-replay regressions; package run verifies actual restart/follow-up delivery. | No CLI upgrade of representative full historical Homes; lost-acknowledgement send injection and reconnect/no-replay remain internal tests, not full browser fault injection. |

This was a risk-prioritized continuation, not a claim to exhaust every
permutation. No known failing product assertion remains in the final executed
set. The outstanding coverage boundaries above remain explicitly unverified
at the broader layer.

## Evidence and resource accounting

New evidence root: `output/task109-repair/` (separate from first-delivery data).

- `core-fixed.log`, `package-smoke.log`: final-candidate logs.
- `verified/report.json`: full final CLI/HTTP/Job/Session/artifact receipts and
  cleanup. Its `commit` is the exact executable candidate; `browserChecks`
  contains all ten final results.
- `verified/browser-results.json`, screenshots and `downloads/pixel.png`:
  browser evidence and downloaded original.
- `final/browser-results.json`: pre-terminal-fix failure, including traceback
  at the writer-survival assertion; `final/report.json` records that fixture's
  configuration/search passes and native-input observations.
- `fixture/`: earlier diagnostic runs; wrong test expectations for cleared
  Web field (`""`, not null), search cursor HTTP rejection (400, not 409),
  retained search input, button label and asynchronous textarea replacement
  were corrected. These are harness corrections, not additional product bugs.
- Browser-use recording:
  `/data00/home/zhangqian.0326/.config/browser-harness/agent-workspace/recordings/task109-repair`
  (201 frames; includes exploratory and final runs, not only passes).

Final fixture `127.0.0.1:18859` ran 09:21:17.930–09:22:55.311 UTC.
Its native observations contain one attachment to `fixture-task-1-leader`
and only `WRITER-ALLOWED`; neither read-only injection reached that boundary.
The Job cancellation request was followed by a confirmed `cancelled` result
and `exit.json` with SIGTERM, then exact socket absence. Both activated
fixture Tasks completed and archived. Controller and exact tmux namespace
stopped successfully. The successful scratch Home was removed only after
receipts were saved; it is disposable, while reports/screenshots remain.

The pre-fix fixture also settled its Job and stopped its Controller/tmux.
Its Home was removed by the earlier harness because its process checks
passed; its browser failure and native observations remain in the report.
The harness now reads browser failures during teardown and retains failing
Homes as well. The earlier failed diagnostic Home remains discoverable at
`fixture/report.json → cleanup.retained`; it has no running owned processes.
No production Controller, global Home or unrelated browser tab was stopped.

The original fixed artifact report
`git:6cda57d5b11382186944f918f5c2fd1c1746095a:reports/regression.md`
and original failure evidence
`git:51e19b791e1438c1cd93548575f27f8e1c20f557:evidence/runtime-summary.json`
are preserved. This repair report and new receipts are saved as separate Task
artifacts; later documentation does not rewrite original execution facts.
