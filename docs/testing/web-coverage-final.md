# Task109 consolidated coverage

2026-10-11, Linux x64, Node 24.20.0. This is the message-7 continuation,
not a relabeling of the earlier bounded milestones. Fixed baseline:
`c079c41d9ad40ff001b30cbf8ababfd65c4848a3` (PR428), previously checked against
remote master twice. No rebase or external publication was performed.

## Candidate and results

Executable candidate: `413363a31a5644dc82107ec9fad3412a3e107f8c`.
It adds rendered model, material, InputRequest and Skill paths and a driver
that waits for fixture cleanup. The only production change since
`a9e450bd53eade2786681da915ad71d5bf65cc68` clarifies an existing model-adoption
rejection: an open native TUI must exit before changing its model. The guard
still rejects; it was not removed to make a test pass.

- `npm test`: build succeeded; 735 tests, 728 passed, zero failed,
  seven macOS-specific skips; test phase 20.742 seconds.
- Normal rendered suite: 14 journeys passed, plus all 12 real-process
  assertions including terminal Job settlement and fixture archive.
- Historical/unknown-send recovery on the same candidate: three browser
  journeys and all 12 real-process checks passed, including cleanup.
- Real native execution: the final maintained live wrapper passed on
  `a9e450bd53eade2786681da915ad71d5bf65cc68`; two real gpt-6-luna Turns,
  real command/tool execution and automatic cleanup. Its tested code is
  unchanged by the browser additions or rejection-message clarification.
- Earlier actual Codex TUI switching, read-only clients, resize, precise
  interruption and fresh-tab same-Thread recovery remain applicable.
  No relevant native transport, writer or cancel implementation changed.
- Earlier assembled-package smoke remains applicable: no package layout,
  dependency or launch packaging changed. It is not claimed as freshly run.

The detailed initial and repair reports remain historical evidence:
[original](web-runtime-smoke.md), [repairs](web-runtime-repair.md),
[recovery](web-recovery-smoke.md), [live TUI](web-live-luna-smoke.md), and
[native execution](web-native-execution-smoke.md). Their original failures,
versions and narrower acceptance statements have not been overwritten.

## Evidence levels

**L** = actual account/model/native Codex; **B** = rendered browser;
**P** = real CLI, Controller, SQLite, Host, tmux or Runner process;
**I** = maintained integration using real files/SQLite with injected runtime
ports where specified; **U** = pure logic or shipped DOM code with a fake DOM.
B/P normal and recovery fixtures replace only the external native protocol.
Their assertions do not establish live model, real billing or every upstream
history behavior. Current I/U rows below were rerun by the final core gate,
not inferred from historical test counts.

## Requirement matrix

| Requirement | Normal path and material failure boundary actually asserted | Evidence / outcome |
| --- | --- | --- |
| 94 unified current/history Sessions | Durable Unicode Message and same-key conflict survive Controller restart. Formal Session replacement leaves old history readable and read-only; current and historical drafts do not cross. Task and Global exact delivery links, owner/cursor fences, late results and unknown recovery are tested separately. | P normal; B/P recovery; I `input-control`, `global-input-control`, `web-conversation`. Pass at those levels. |
| 95 one Thread, native access and writers | Two browser windows and an extra terminal socket share one Thread. Only the writer's input reaches the native boundary. Closing a reader retains the writer; returning to Conversation releases the viewer lease without a new Turn. Actual Codex TUI, resize, interruption, reload/fresh-tab reconnect were previously exercised. | B/P normal; earlier L TUI; I `web-native-terminal`, `global-host-control`. Pass. Retained TUI configuration is a separate model-adoption fence, not a leaked writer. |
| 96 lifecycle and user decisions | Create-only saves one Draft with no Session, replay conflicts reject, explicit activation uses real Host. A managed Leader creates an actual InputRequest; one browser answer is persisted as user answer and the same Session receives the next wake. Settled disposable Tasks complete/archive only after their Job exits. | B/P normal, `browser-input-answer.json`; I `web-workbench`. Pass. The normal 60-second input-answer aggregation is observed, not bypassed. |
| 97 settings and provenance | CLI/Web read the same configuration. Stale revision, invalid multi-field update and retained-effort/model mismatch reject without partial state changes. Valid pair and clearing effort succeed. Sources, defaults, environment-value redaction, stale discovery and unknown-save UI guards are tested. | P normal; I/U `web-settings`, launch-configuration tests. Pass; prior CLI parity defect remains fixed. |
| 98 materials and fixed feedback | Browser uploads real UTF-8/CRLF bytes; pinned digest agrees with the original file. Upload/reload preserve draft and do not send or execute contents. Fixed artifact feedback stages a version without replacing text. Historical, cross-Task and changed-Session mutations are refused. | B/P normal and recovery; I `input-control`, `web-materials`. Pass. Browser upload is text only, as designed. |
| 99 bounded retrieval | Real search returns disjoint 20+1 pages, changed-query cursor rejects. A 9,218-code-point source is reconstructed exactly. Browser changes pages and opens later source content. Unauthorized Task/record references and stale source evidence reject. | B/P normal; I `web-body-search` and context guards. Pass; no arbitrary cross-Task read authority inferred. |
| 100 Knowledge applicability | Scope-only accepted update reaches Context and CLI/Web identically; exact proposal replay is idempotent; retirement filters current Context and stales the old digest. Expiry-only change, history, clearing optional fields and unrelated-project denial are explicitly tested. | P normal; I `project-knowledge` with real SQLite. Pass. Free-text expiry remains Agent-interpreted metadata, not an invented predicate engine. |
| 101 frozen Skill packages | Source resource/binding/CAS/traversal checks cross Controller. Attachment-only change appears on next launch; old Session package remains exact/readable after unbind. Package files, scripts, executable intent, symlinks, size and corrupt snapshots are checked. | P normal; I `skill-packages`, `web-skills`, effective launch/context tests. Pass. Browsing never executes package scripts. |
| 102 usage | Missing data stays unknown/null with no fabricated actual amount. Actual SQLite aggregation preserves Session/Run attribution, request identity, cumulative deduplication, cross-currency revisions, partial/known zero and separate estimate provenance. Reads do not collect/write usage. | P normal; I/U `task-usage`, storage baseline. Pass at data-contract level; no real invoice or provider-priced event is claimed. |
| 103 drafts/model/Slash | Browser reload/target switching retain separate drafts; `/help` and `/model` create no Message. Rendered native catalog adoption changes the idle current model without new Thread/Turn or Role-default mutation. Native-TUI-open rejection leaves the prior model unchanged. Unknown adoption, exact stop, Slash completion/literal opt-in and stale target controls remain covered. | B/P normal; I/U `web-conversation-view`, `input-control`, `codex-native-access`; earlier L exact cancel. Pass within supported model-control boundary. |
| 104 previews | Markdown code renders and script text stays inert. Actual PNG decodes, 200% zoom changes dimensions, downloaded original matches pinned digest and byte length. Unsafe type/path/dimensions, relative pinned images and bounded content are tested. | B/P normal; I/U `artifact-preview`, `web-materials`. Pass; unsupported SVG/GIF are not silently enabled. |
| 105 Job HTTP service | Managed native CLI starts actual Task-owned Job; Runner owns socket. Real sandboxed iframe executes relative asset; closing preview leaves service alive. GET/HEAD boundary and POST rejection; explicit cancel waits for exact exit artifact and owned socket absence. Ticket revocation, foreign socket, limits and neighbor ownership are covered internally. | B/P normal; I `web-preview`, Job/resource tests; reused package archive-neighbor proof. Pass at stated boundaries; no arbitrary TCP/WS/HMR proxy claim. |
| 106 defaults | Browser structured-view preference is selected through Settings before opening the Task and survives reload. Server defaults/source/CAS/validation are the shared 97 checks; changing current model leaves defaults unchanged. | B/P normal; I/U `web-settings`. Pass. Preferences do not retroactively alter a live Session. |
| 107 exact selection into draft | DOM UTF-16 selection over original Unicode/CRLF becomes exact code-point offset 3/length 7. Reference appends, never sends; long original paging and target/history isolation are checked. | B/P normal and recovery; I/U `web-body-search`, `web-conversation-view`. Pass. |
| 108 Skill browser and explicit binding | Real Settings catalog/source reader, explicit Task Role selection, bind/save/unbind all use rendered controls. Saved configuration changes, frozen Session stays identical, source attachment remains v2 after removal. | B/P normal (`browser-skills.json`); I `web-skills`. Pass, no package deletion or auto-execution. |
| Internal A/B: authoritative operations, control and recovery | Public CLI/Controller writes rather than seeded Store in P. Auth token, wrong Task/Role/Session/Turn/writer, selected-Session delivery and then-handoff are checked. Lost accepted response and never-forwarded request preserve original ID across true fresh-tab recovery without blind resend. | P/B normal/recovery; I Task and Global control suites. Pass with simulation boundary disclosed. |
| Internal C: storage migration/recovery | Fresh 1.6 and supported 1.0–1.5 upgrades use actual SQLite and centralized upgrade runner. Session payloads, known frozen packages, knowledge/history/context and input intent survive. Unknown costs are not invented; foreign/incompatible storage rejects, repeated current open is legal. | I `storage-baseline`, `project-knowledge`, upgrade/release recovery tests; P fresh Home/restart. Pass. Not a claim to CLI-upgrade a user's real historical Home. |
| Internal D/E/F/G | Knowledge, Skill, configuration and usage correspond to rows 97/100–102/108; real Job/Runner cleanup to 105. Exact ownership, stop requested versus confirmed terminal, archive settlement and unrelated resource preservation remain required. | Final core plus normal/recovery P receipts and reused package proof. No production or other real Task resources touched. |

This covers the requested logic using the authorized mix of levels, not every
possible Cartesian product of browser, OS, provider and failure. In particular,
Global control's independent authority and replacement paths are I/P coverage,
not a newly claimed real-model Global browser journey; priced billing is a
data-contract test, not an account audit. These are declared simulation/layer
boundaries, not skipped mandatory assertions disguised as passes.

## Real execution proof and resource accounting

Evidence root: `output/task109-coverage/live-final/`.
The proxy performed official native `command/exec` before the first
`turn/start`, using actual returned `dangerFullAccess` / `never` policy and
the adopted Thread identity. It successfully read its Manifest, executed its
exact full Context command, read a unique fixture and wrote/read a proof file.
The separate read-only sandbox diagnostic still failed with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`; it is not a
passing sandbox assertion and did not modify host permissions.

Real gpt-6-luna Thread: `01a12b59-749f-7111-9d9c-27e6ba23a1fc`.

| Native Turn | Observed result |
| --- | --- |
| `01a12b59-7afd-7e63-ab65-50bdecf301cf` | Activation; actual Manifest/Role/context reads; completed, 19,930 ms. |
| `01a12b59-cf17-74a1-ad34-37beb2e0bd59` | Browser formal Message; actual fixture read, programmatic reversal, result write/readback; completed, 30,293 ms. |

Original request `2a8d8aae-35d6-4370-a09d-49e23476fd7c` has an accepted formal
receipt; there is one browser POST and two total native Turns including
activation. The unprompted value is
`b02517cc-0b83-4268-91d9-b1ca524e92a7`; file and rendered reply agree on
`7a29e425ac1b-9d19-8624-38b0-cc71520b`.
Output SHA-256:
`4cb3a555eb1377e6f3c9d35bef90fb378691dbd7ffc1872387a63acabc70c427`.
Native item-completion logs and readback establish tool effects, not only the
assistant's statement or the completed Turn status.

CLI and isolated daemon in this fresh round were both **0.159.2**, SHA-256
`1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`,
including the daemon stop receipt. The earlier round's later automatic
0.162.1 daemon update remains recorded separately; versions are not conflated.

Actual live accounting across the Task continuations: previous TUI milestone
5 Turns, native-execution development milestone 3 Turns, fresh maintained
wrapper 2 Turns = **10 real Turns**. The three failed model-free fixture
attempts used zero model Turns. This is accounting, not a new limit.
The old manual reversal failure and explicit corrective Message remain in
their original evidence. Current observed native elapsed time totals 50.223 s;
no exact account charge or priced token total was supplied by these receipts,
so neither is reported as zero or guessed.

## Failure disposition and cleanup

Expanded-browser diagnostics are preserved separately from final passes:

- `browser-expanded/`: native TUI retained after default terminal view, so
  model adoption was correctly fenced but its error was unclear. The new
  diagnostic explains that viewer detach is not TUI exit. Draft feedback
  assertions sampled before asynchronous restoration; final checks wait for
  the same exact expected draft, not a weaker value.
- `browser-expanded-2/`: model adoption succeeded; the test incorrectly read
  run configuration from metadata instead of the selected history page.
- `browser-expanded-3/`: formal answer succeeded; a 15-second test deadline
  was shorter than the normal 60-second aggregation. The final test observes
  the same original answer/wake for up to 90 seconds without resubmitting.
  Upload now waits for its real file input to be enabled before selection.

All three diagnostics settled Jobs and stopped their own Controller/tmux.
Before deleting retained Homes, a separate `/proc` and exact tmux audit found
no owned processes; SQLite facts and native logs were preserved outside the
Homes. `failed-fixture-cleanup.json` records the exact three deleted paths.
No shared directory sweep was used.

Fresh live cleanup captured the native Turn ledger and workspace outputs,
formally stopped fixture execution and Controller, stopped the exact daemon
and updater, removed the copied credential, checked original authentication
bytes unchanged, and verified no remaining owned process, tmux or socket.
Only its two allocated Homes were removed. Normal/recovery fixtures separately
retain their Job exit/socket and Task archive receipts. Evidence files remain;
scratch Home deletion is not evidence deletion.
`browser-tab-cleanup.json` records closure of the four remaining diagnostic
and recovery tabs by their exact fixture URL and target ID; unrelated tabs
were not closed.

## Remaining platform/environment boundaries

- No authorized macOS host is available here. Seven platform-specific core
  skips and fresh macOS npm-install/PTY testing remain a distinct platform gap.
  Linux results are not macOS results.
- This host's read-only bwrap sandbox is still incompatible. Normal authorized
  development execution is proven under the supported bypass configuration;
  independent Homes are not claimed as an OS security sandbox.
- No global configuration, account, Leader binding, production Controller or
  real Task94–108 was changed. No push, PR, merge, npm publication or real Task
  archive was performed.

Self-review covered the full candidate diff, ownership/cleanup, unchanged
model guard semantics and actual receipt assertions. No independent reviewer
was used; a small diagnostic plus opt-in tests did not justify a separate
managed review lifecycle. Reproduction commands remain in the linked normal,
recovery and native-execution guides. Real-model tests are opt-in and absent
from `npm test`.
