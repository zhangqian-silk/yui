# Web and core-runtime regression smoke

The execution record below preserves the first, test-only delivery.
The authorized repair and extended verification are recorded in
[web-runtime-repair.md](web-runtime-repair.md).
The final cross-requirement matrix is in
[web-coverage-final.md](web-coverage-final.md).

This opt-in smoke supplements `npm test`; it does not replace the seconds-scale
core suite. It uses a disposable Home, the explicit checkout launcher, real
Controller/SQLite/Host/Runner processes, and deterministic Codex protocol
fixtures. No real model, account, intercepted HTTP response, or seeded Store is
used. Run on Linux with Node 24, Git and tmux available.

## Run

From the repository root:

```sh
make install-local
npm test
YUI_SMOKE_PORT=18819 node scripts/smoke-web-runtime.mjs
```

Choose a free loopback port. Reports default to a unique directory under
`output/web-runtime-smoke/`; optionally set `YUI_SMOKE_EVIDENCE` to an absolute,
new evidence directory. The script prints its URL and report directory. A
failed assertion makes the process exit nonzero after cleanup, retaining its
isolated Home and the original CLI/HTTP receipts. Independent checks continue
after failure; failed assertions are not marked expected or skipped.

For rendered-browser coverage, use the server wrapper and driver. The driver
waits for process setup and assertions, then for owned teardown after browser
execution. Choose a free port and a fresh evidence directory:

```sh
YUI_SMOKE_PORT=18819 YUI_SMOKE_EVIDENCE=/absolute/evidence \
BROWSER_USE=/absolute/path/to/browser-use \
python3 /absolute/path/to/browser-workflows/scripts/with_server.py \
  --server 'exec node scripts/smoke-web-runtime.mjs --serve' \
  --port 18819 --timeout 90 -- node scripts/run-web-browser.mjs
```

`smoke-web-browser.py` is a browser-use script with pre-imported CDP helpers,
not a standalone Python executable. It opens its own tab, uses rendered
controls, and records read-only API checks alongside UI actions. It saves
screenshots and `browser-results.json`. Use a fresh fixture for a complete
rerun: create-only intentionally creates one uniquely named Draft.
`YUI_SMOKE_BROWSER_ONLY` selects a case-name substring for diagnostic reruns
and preserves the other recorded results; do not mistake that for a fresh
complete run.
The normal `--serve` fixture includes a real managed Leader InputRequest.
The browser answers it once and observes the existing 60-second notification
aggregation before the same Session continues; this is not a stuck test.
The recovery fixture opts out of that question because it owns different
notification assertions. Model adoption starts in the structured view; a
later assertion verifies that an open native TUI still fences adoption after
the browser viewer detaches. Text upload and Skill browse/bind/unbind use real
rendered controls and check authoritative fixed references and Session state.

Start/stop a browser-use recording around the browser script when a trace is
needed. On finish, send SIGTERM to the exact `fixturePid` from `report.json`
and wait for `finishedAt`. Do not immediately kill its process group: Job
cancel acknowledgement is not terminal, and the script must wait for exit
evidence before completion/archive and Controller/tmux teardown. Failed Homes
are deliberately retained; inspect `cleanup` before deleting anything.
The fixture sets only its own reconciliation interval to five seconds.

The native test double supplies a model catalog and one historical Turn. Its
managed turn handler invokes the actual CLI to save Markdown/PNG and start a
Task-owned Job. The Job serves HTTP on the actual Runner socket. It does not
implement the actual Codex TUI, real billing, or all upstream history
semantics.

## Task109 execution record — 2026-10-10

Baseline and remotely verified `master`:
`c079c41d9ad40ff001b30cbf8ababfd65c4848a3` (Task108 / PR428).
These tests add no production behavior changes. Task94–108 requirements were
taken from Task109's full persisted contract and the final repository, not
inferred from a green test count.

Environment: Linux x64, kernel 6.8.0-87-generic; Node 24.20.0;
TypeScript 5.9.3; Git 2.43.0; tmux 3.4; better-sqlite3 12.11.1
(SQLite 3.53.2); node-pty 1.2.0-beta.15.
`make install-local` installed dependencies and built successfully.
The initial shell's Node 18 was not used for validation. No native binary was
copied to work around a build problem. npm reported one moderate audit finding;
dependency upgrades/audit remediation were not part of this test delivery.

Results:

- Final `npm test`: 731 tests, 724 passed, 0 failed, 7 platform skips,
  19.686 seconds. Skips are macOS-specific; this is not macOS validation.
- New real-process smoke: 10 passed, 1 failed. The failure below remains a
  nonzero regression, not an expected failure.
- Real-browser script: all six journeys passed. Responsive creation was
  corrected using observed UI labels and rerun against the same fixture;
  intermediate failed screenshots remain in the evidence.
- Existing assembled-runtime smoke: passed, including real PTY Doctor,
  restart/idempotence, reopen/follow-up, update handover and archive isolation.
  PTY Doctor proves a PTY dependency, not an interactive Codex TUI.

### Confirmed product defect: global CLI model/effort validation

Affected requirements: Task97/106 and Task109 internal configuration parity.

1. Native model catalog advertises `fast` with `low` effort and `deep` with
   `high` effort only.
2. Save global Leader `fast/low` through the supported settings API.
3. Change only the model to `deep` through Web settings.
   HTTP 409 identifies the incompatible retained effort; saved state is unchanged.
4. Run `config role update leader --model deep` through the real CLI/Controller.
   It exits **0**, reports `Updated role leader`, increments the revision and
   saves **deep/low**.

Expected: both entry points reject the same invalid resulting configuration
without partial persistence. Impact: CLI can save defaults that Web refuses,
leaving an invalid launch configuration for future Sessions. A real-provider
launch failure was not attempted and is not claimed.

Source inspection: `preflightAgentConfigurationMutation` in
`src/controlPlaneCli.ts` validates profile and Task-role mutations, while the
global-role path warms the catalog then calls `runGlobalRoleCommand` without
the equivalent resulting-config check. `src/web/webSettings.ts` validates the
patched configuration. This is a reachable product defect, not a fixture
expectation about unsupported UI. The smoke restores valid fixture settings
through the public API before continuing independent checks.

No production repair was made: this Task delivers regression coverage and
findings. A repair should align the CLI's global-role preflight with shared
validation and rerun the retained red assertion. This report is not a claim
that the integrated release is fully green.

### Coverage matrix

Layers: **B** real rendered browser; **P** real process/Controller/SQLite;
**I** existing in-process integration tests (real SQLite/files where stated,
but injected runtime/provider ports); **U** narrower unit or fake-DOM tests.
All listed existing tests were rerun on this baseline.

| Task / requirement | Actual assertion and evidence | Result and boundary |
| --- | --- | --- |
| 94 unified Session/history | P message exact body and request-id replay/conflict survive actual Controller restart; native activation resolves the same Session ID. B draft reload preserves Thread/Turn. I `input-control` and `global-input-control` test persistence, exact delivery linkage and unknown settlement. | Pass. P history is a deterministic upstream sample; global browser history and forced crash during send not exercised. |
| 95 same Thread and writer | I `input-control`, `global-input-control`, `web-native-terminal` check human writer fences, stale targets, Session replacement and unknown/no-replay boundaries. | Pass at injected-port level only. Real native TUI switching/multiwindow writers not covered; fixture cannot launch an interactive Codex TUI. |
| 96 workbench/lifecycle | P create-only has one durable Draft and no native Session; replay/conflict rejects. Explicit activation uses actual Host. B narrow create-only readback has Draft/no Session. P two activated fixtures complete then archive after Job settlement. | Pass. Public InputRequest reply journey not covered in browser. |
| 97 unified settings | P CLI/Web time-zone agreement, stale CAS and invalid multi-field write preserve state; retained-effort parity assertion. | Mixed: CAS/atomic rejection pass; CLI model/effort parity **fails** as above. |
| 98 materials/pinned feedback | P native CLI saves pinned Markdown and PNG through artifact API. B pinned Markdown and feedback preserve draft and append a version reference without creating a Message. I `input-control` covers text-upload/feedback authority and Session changes. | Pass for tested paths. Browser file upload/download, target switching and history read-only feedback not covered. |
| 99 bounded search | P real message search; B exact original Unicode/CRLF selection creates a bounded code-point reference, retains existing draft and does not send. I existing context/search cursor and stale-reference guards. | Pass. Browser cross-task long-result pagination not covered. |
| 100 Knowledge | P exact repeated proposal, scope-only accepted update reaches version 2; CLI/Web inspect values agree; retirement removes current Context and invalidates old digest. I `project-knowledge` covers long exact continuation, applicability and omitted-field semantics. | Pass. Free-text expiry is metadata, not assumed semantic execution. |
| 101 full Skill package | P source browse/bind, stale revision, traversal rejection; attachment-only change affects next launch, not frozen current Session; unbind retains source and old readable snapshot. I `skill-packages` covers scripts/references, symlink/size boundaries and corruption. | Pass. No script automatically executed. New managed Worker Run freeze not independently exercised by P. |
| 102 usage | P no usage is `unknown`/null, actual amounts empty, not zero. I `task-usage` verifies actual SQLite attribution/deduplication, cumulative/request evidence and actual/estimated currency separation. | Pass at stated layers. No upstream billing evidence, browser cost interaction or process-level priced-event restart journey. |
| 103 draft/model/Slash | B reload retains unsent Unicode draft; `/help` creates no Message. P current model adoption preserves native Session/Turn and future defaults; wrong Session rejected. | Pass. Full Slash catalog and native TUI not covered. |
| 104 rendered artifacts | B Markdown code rendering and inert script text, pinned feedback; P valid PNG artifact exists. PNG display was manually inspected in browser. | Pass for automated Markdown and artifact paths. Image zoom/download integrity not automated or claimed. |
| 105 HTTP previews | P real managed Job/Runner/socket, relative asset, sandbox CSP and POST 405. B sandboxed iframe executes relative JS; closing view leaves Job ready. P explicit cancel waits for exit.json and exact socket removal. | Pass. Existing core boundary tests supplement limits; no real-process abnormal crash/neighbor-Job cancellation matrix. |
| 106 defaults | P shared setting/CAS checks and invalid retained effort, B structured preference reload. | Mixed: same global CLI defect as 97; no claim every high-frequency field has browser coverage. |
| 107 exact-source quote | B source `来源 😀\r\nKeep…`, DOM UTF-16 selection converts to original code-point offset 3/length 7; reference appended to correct draft, no Message sent. | Pass. Long source paging and switching to historical target not exercised in browser. |
| 108 Skill browse/bind | P source catalog/resource, global and Task bindings, revision conflicts, unbind and next-launch adoption. | Pass. Not a rendered Skill browser interaction test. |
| A/G CLI, control, cleanup | New P checks cover formal public operations, not seeded Store. Package smoke covers real lifecycle/reopen/archive-neighbor safety. | Pass except configuration finding. Accepted is never counted as settled Job cancellation. |
| B control failures | I exact Task/Global target, human writer and unknown/no-replay checks; P wrong Session and restart replay. | Pass at stated layers; transport-loss/send-unknown browser injection not performed. |
| C migration/recovery | `project-knowledge.test.js` uses real SQLite fixtures for each supported 1.0–1.5 input through 1.6, preserving knowledge, frozen Context and input intent; current readers reopen. New P fresh Home and restart. | Pass. This is internal migration coverage, not CLI-upgrading representative historical full Homes with every Skill/usage payload. Independent native-agent module migrations are not counted as Yui storage evidence. |

### Evidence and cleanup

Repository-local evidence root: `output/task109-evidence/`.

- `core-final.log`: complete final core run.
- `package-smoke.log`: assembled package lifecycle checks.
- `final-fixture/report.json`: original CLI outputs, HTTP request/result values,
  durable Session, Job, artifact, configuration and cleanup receipts.
- `final-fixture/browser-results.json`: six browser outcomes.
- `final-fixture/*.png`: desktop draft, pinned Markdown, exact search selection,
  preview and 390px narrow-screen screenshots, including diagnostic failures.
- Browser-use recording: local
  `/data00/home/zhangqian.0326/.config/browser-harness/agent-workspace/recordings/task109`
  (80 frames; stopped normally). Only task-owned browser tabs were closed.

Final fixture ran on `127.0.0.1:18829`, 08:37:38–08:45:59 UTC.
Job `task-1/job-1` first returned a cancellation request with `stopped:false`;
the final read and exit artifact confirmed `cancelled`, with the service step
terminated by SIGTERM. The script asserted that its exact Runner socket root
no longer existed. Both activated Tasks became archived; Controller stop and
exact tmux namespace stop succeeded. A browser-created Draft has no native
Session. The failed fixture Home is retained at the exact `cleanup.retained`
path in the report; do not use a broad Home cleanup command.

Harness development failures were not counted as product findings: missing
local Git remote, unsupported setup invocation, JSON envelope parsing, initial
PNG bytes, a missing fake history method, and incorrect browser labels were
corrected and rerun. An early `--serve` version exited with an unresolved
Promise, leaving its fixture live; `browser-fixture/cleanup-recovery.log`
records exact Job cancellation, socket removal and fixture-only shutdown.
The final script keeps Node alive until a shutdown signal. Setup also emitted
a long-path Codex socket warning in this environment; later actual Host
activation and settled Job evidence succeeded, so setup's warning alone was
not promoted to a product conclusion or hidden.

Completion means the bounded test delivery and honest coverage/findings are
available. It does not mean all Task94–108 behaviors were exhaustively tested,
that the remaining red regression is fixed, or that real paid upstream,
macOS, production, global Home, PR/merge or publication was exercised.
