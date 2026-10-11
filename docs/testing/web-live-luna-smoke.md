# Bounded real Codex / Luna browser verification

Task109 message-4/5 continuation, 2026-10-11 (Asia/Shanghai). These messages
explicitly authorized the existing account and at most five short live Turns,
replacing message-3's local-model-only/network-namespace prerequisite.
The originating Leader cancelled the obsolete `input-1` through the formal CLI.
This report supplements [A/B recovery evidence](web-recovery-smoke.md);
it neither relabels that evidence as live-model testing nor removes its assertions.

## Result and exact scope

The real browser → Yui Web terminal → authenticated Host resume → tmux/PTY →
real Codex TUI → configured account gateway → `gpt-6-luna` chain was exercised.
There was **one dedicated Thread and exactly five native Turns**: four completed,
one interrupted, zero native model-error terminals. Two completed Turns answered
the small terminal prompts; two completed Turns reported the unavailable shell
sandbox instead of performing the requested notification/context work.

This is **not an all-green Agent-execution result**. Native read-only shell
execution failed with `bwrap: loopback: Failed RTM_NEWADDR`. The structured
browser send was accepted exactly once, produced a same-Thread notification and
model reply, but that reply reported the unread context; the requested greeting
was not executed. No extra model attempt or sandbox/global change was made after
the five-Turn limit. This limitation is separate from the demonstrated terminal
conversation, cancellation, writer isolation and reconnect behavior.

No product source was changed in this continuation. The tested executable
candidate remained `3dc0b349bfd97b3ae7cdaeecb09499ce686ac9e1`, including the prior
shared-configuration, viewer-lifetime and pending-send recovery fixes.
The prior core gate (726 passes, zero failures, seven platform skips), A/B
process/browser results and earlier package smoke remain their original fixed
evidence; unaffected suites were not rerun.

## Configuration and provenance

- Linux x64; Node `24.20.0`; real browser through the installed Browser Use
  helper; checkout-local absolute `output/dev/bin/yui`.
- CLI/TUI `codex-cli 0.159.2`, SHA-256
  `1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`.
- The native daemon launcher installed **0.162.1** inside the isolated
  `CODEX_HOME`, SHA-256
  `628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1`.
  Thus this tests the **0.159.2 TUI / 0.162.1 daemon pair**, not an entirely
  0.159.2 runtime. Installed global binaries and the production daemon were
  not changed.
- The exact model was confirmed in the real native catalog before activation.
  Its catalog default effort was `low`; the isolated Role explicitly cleared
  effort. Native Turn contexts record `gpt-6-luna`, default collaboration mode,
  and `reasoning_effort: null` (provider default). `low` is catalog evidence,
  not a separately observed wire-level effort field.
- Only the already configured `metabridge` provider/account route was reused.
  A private auth-cache copy and minimal provider configuration went into the
  independent Codex Home. The original auth cache was byte-for-byte unchanged
  at teardown. No login, logout, account switch, reset, top-up or new credential
  was performed. Credentials and tokens are excluded from evidence.
- The executing Task109 Leader remained `gpt-6-astra / medium`. The fixture's
  `task-1/leader` and its `gpt-6-luna` Thread were wholly separate.
- Native Thread: `01a12a35-99c1-74f1-93c6-d9836c1dbfcc`.

The official authentication documentation was consulted before implementation
(`developers.openai.com/codex/auth`): it documents file-backed credentials under
`CODEX_HOME` and copying an existing auth cache. Documentation/catalog presence
was not used as proof of account/model execution; actual Turn receipts provide
that separate evidence.

## Observed journeys

| Check | Actual result and evidence |
| --- | --- |
| Real startup and same-Thread resume | Dedicated fixture activation created one Thread. Browser showed native history and `GPT-6-Luna default`; subsequent opening/resume did not create another Thread. `initial-facts.json`, `initial-history.json`, native process identities. |
| Browser terminal input and reply | One terminal prompt received `2 + 3 = 5.`; a second received a 40-line color list. Native user/assistant items and completed Turn identities corroborate the display. `turn2-completed.json`, `cancel-admitted.json`, native SQLite projection. |
| Resize propagation | At visible desktop sizes, pane dimensions changed from 56×35 to 53×46; the browser and real native terminal remained attached to the same Thread. Screenshots record the two layouts. This is not pixel-perfect reflow certification. |
| Writer/read-only windows | A second browser window was read-only. UI input and an additional read-only socket's input were absent from the native composer. Closing those readers preserved the original writer. The assertions preceding the reload step in `views.py` passed; `real-tui-readonly.png` and native-pane observation corroborate them. |
| Conversation/terminal switching | Completed real reply appeared in Conversation. Leaving Terminal released its writer; returning reopened the same native Thread. `same-thread-conversation.png`. |
| Reload and true close/reopen | Page reload and closing the old target before creating/navigating a new target resumed the same Thread, with unchanged two-Turn history at that point. `reconnect-result.json`. |
| Exact cancellation | Browser Escape cancelled the observed accepted native Turn `01a12a3d-e506-7f03-9b9f-eb753cefd7ed`. Yui reports `cancelled`; native SQLite reports **that same Turn** `interrupted`, duration 592 ms. No other Turn was affected. `cancel4-before.json`, `cancel4-result.json`, `native-evidence.json`. |
| Structured send after cancellation | One real POST, request ID `39fa98d6-353b-4d21-8f77-135e68fb1bbd`; authoritative query returned `accepted`/`message-4`. One notification Turn completed on the same Thread. Its requested greeting remained **environment-blocked** because the model could not read the manifest. `final-turn-result.json`, `final-session.json`. |
| Final counts and cleanup | Native read-only SQLite observation: five unique Turns, one Thread, four completed/one interrupted; all five contexts select the exact requested model. Owned resources settled and all four scratch directories removed. `native-evidence.json`, `cleanup-audit.json`, `browser-cleanup.json`. |

### Turn accounting

The authoritative, full Turn IDs (not item IDs) are:

1. `01a12a35-9d06-7441-ad82-e7537c0d6af3`: activation notification;
   model completed with shell-sandbox diagnosis.
2. `01a12a38-78eb-7c20-91df-5eca6df8ab67`: terminal arithmetic; completed.
3. `01a12a3c-d8fa-7101-ba1e-83ac4e6eb79f`: terminal color list; completed before
   the initial cancellation harness observed a usable target; no cancel sent.
4. `01a12a3d-e506-7f03-9b9f-eb753cefd7ed`: terminal cancellation probe;
   precisely interrupted.
5. `01a12a3f-11a8-7ce2-b960-d0d9ead20140`: structured-send notification;
   model completed with shell-sandbox diagnosis.

## Harness diagnostics, not hidden passes

Preflight failures occurred before any model Turn: setup needed its existing
interactive-fixture option, and `task create` needed a separate supported
`task update --description`. A long temporary `CODEX_HOME` exceeded Unix socket
path limits. A uniquely allocated short `/tmp/yui-luna-*` native Home resolved
that fixture path issue; Task diagnostics stayed in the runtime-provided TMPDIR.

The first terminal automation pressed Enter during native paste handling.
The original text remained in the native composer, and there was no new
backend Turn. After inspecting both facts, a later Enter submitted that same
composer without retyping or replaying a request.

The resize harness initially used 900 px, where the responsive UI hides the
terminal panel. It was corrected to visible desktop sizes. A later reload
wait also used a restored hidden-panel viewport; explicit desktop sizing fixed
the harness. Already-passed writer/view assertions were not repeated merely
to replace the partially failed script with an all-green exit.

The first cancellation observer looked for `history.activeTurnId`, which did
not expose the running target it needed in that read. Turn 3 completed normally.
Turn 4 used the formal execution receipt's accepted native identity and was
cancelled. Its script initially expected Yui's status to be `interrupted`;
read-only verification confirmed Yui's actual `cancelled` mapping against the
native `interrupted` record. No model request was repeated to fix that assertion.

## Cleanup and remaining limits

Before the first fixture CLI call, teardown was registered. At the end:
owned browser targets closed; fixture execution was fenced/stopped; its
Controller and tmux stopped; native `daemon stop` returned `stopped`.
The native daemon's own pid-update-loop remained alive, so its recorded PID,
command and exact isolated executable were checked before sending SIGTERM.
All recorded process IDs, matching command paths, tmux namespaces and native
sockets were then absent. The copied auth file was removed on every path.
Three fixture roots plus the short Codex Home were removed only after the
audit; sanitized diagnostics, screenshots and this report remain.

No production Controller, original Thread, global Role/default or other Task
workspace was changed. No push, PR, merge, release or real Task archive occurred.
Live tool execution/notification semantics remain limited by the local native
sandbox. This run does not certify model quality, all account entitlements,
provider billing, macOS, arbitrary disconnections or the all-0.159.2 stack.

Temporary live scripts are archived as inert Task evidence, not maintained as
an automatically runnable paid suite. Reproduction requires fresh explicit
live-resource authorization and the same bounded account/Turn policy; reuse
the maintained Web smoke's CLI/API/browser helpers, an isolated Home, real
catalog discovery, formal lifecycle and exact receipt reads. No real-model
command was added to `npm test`.
