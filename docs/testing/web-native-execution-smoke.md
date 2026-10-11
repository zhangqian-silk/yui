# Opt-in native execution smoke

This complements the [deterministic recovery smoke](web-recovery-smoke.md) and
the earlier [bounded TUI exercise](web-live-luna-smoke.md). It verifies actual
tool work, not merely an accepted Message or completed model Turn.

## Scope and prerequisites

This Linux-only fixture consumes a real account/model and is **never part of
`npm test`**. Run only with explicit authorization for the selected account,
`gpt-6-luna`, permissions, and bounded Turn budget. A test name, environment
variable, or this document is not authorization.

Use Node 24, `make install-local`, installed Browser Use, an exact native Codex
binary, and an authorized existing `CODEX_HOME` with a file-backed auth cache
and explicit provider block. The fixture copies that cache privately; it does
not log in, switch accounts, change global config, or modify production Yui.
It owns separate Yui/Codex Homes and workspace. These directories are **not an
OS sandbox**. Its normal development Leader explicitly uses supported `bypass`;
run it only where that policy is appropriate and authorized.

```sh
# Set absolute paths appropriate to the explicitly authorized environment.
export YUI_LIVE_CODEX=authorized
export YUI_LIVE_CODEX_BINARY=/absolute/path/to/codex
export CODEX_HOME=/absolute/path/to/authorized/native-home
export YUI_SMOKE_EVIDENCE=/absolute/path/to/new-evidence-directory
export YUI_SMOKE_PORT=19059
export BROWSER_USE=/absolute/path/to/browser-use

python3 /absolute/path/to/browser-workflows/scripts/with_server.py \
  --server 'exec node scripts/smoke-web-codex.mjs' \
  --port "$YUI_SMOKE_PORT" --timeout 90 \
  -- node scripts/run-web-codex.mjs
```

The normal path uses two short Turns: activation, then one browser Message.
The instrumented native proxy refuses a sixth request within that fixture.
Count **all** prior attempts against the actual authorization; a fresh evidence
directory never renews the user's budget. There is no automatic model retry.
For an unknown result, inspect the same request-id and Thread. A known failed
business result may be corrected only as a deliberate new, budgeted request.

## What the probe actually establishes

The fixture uses the checkout's formal configuration, activation, Controller,
Host and real native proxy. A small WebSocket observer reuses Yui's native
connection and `ws`; it neither fabricates native responses nor mocks browser
traffic. Before forwarding the first `turn/start`, after Yui has adopted the
native Thread, it:

1. Verifies the returned model, approval policy, workspace and sandbox.
2. Generates the **installed daemon version's** protocol schema and confirms
   `command/exec` fields, recording executable/version/digest.
3. Runs a separate `readOnly` diagnostic without changing host capabilities.
   Failure remains a sandbox/environment failure, never a passed isolation test.
4. Calls real `command/exec` using the native returned sandbox/cwd and scoped
   shell environment. This reads the real Session Manifest, runs its complete
   `currentCommand`, reads an independently generated fixture and creates/readbacks
   a small probe file. No model Turn is involved.

Standalone `command/exec` has no Thread context. Its probe supplies
`CODEX_THREAD_ID` from this exact acknowledged native Thread, matching the
identity native model tools inject. The context reader still enforces current
Yui ownership; no identity checks or roles are bypassed. Probing before Yui has
adopted the Thread is invalid and was caught during development.

The real browser then sends one structured Message. The model must read its
Manifest/context and full original Message, read a unique value **not included
in the prompt**, create `business-result.json`, and verify it using code.
The observer compares real file bytes, exact Message/request receipt, same
Thread/Turn facts, and rendered Web values. It waits for rendering separately
from backend completion.

The fixture records original failures. It stops owned execution, Controller,
Web and native daemon, checks exact `/proc` ownership, releases its tmux/socket,
removes credential copies, and removes only its allocated Homes after
quiescence. Uncertain cleanup retains non-secret ownership evidence and fails
the driver. Native auto-update may change the daemon/updater executable; record
the actual path/version instead of inferring it from the CLI version.

## 2026-10-11 Task109 outcome

The previous blocker was the **read-only test baseline on a host that cannot
initialize the native network namespace**, not an established Yui permission
mapping defect. Formal `bypass` mapped to native `dangerFullAccess/never`;
the model-free read/context/write probe and subsequent real tool work succeeded.
The read-only `/bin/true` probe still returned
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. No host sandbox,
network, sysctl or production permission was changed.

Live executable/test source: `3828c54` (product code remains the earlier
`3dc0b349bfd97b3ae7cdaeecb09499ce686ac9e1` candidate). Subsequent harness changes
added event-loop lifetime/cleanup handling, a programmatic-transformation
instruction, explicit receipt assertions and rendered-content waiting.
Those changes were not claimed as a second fresh paid run.

Exactly **three** new native Turns occurred on Thread
`01a12b41-465e-7a33-a5d3-e000a82b1439`:

| Turn | Outcome |
| --- | --- |
| `01a12b41-4c9e-7523-9061-559fd5d8ebe0` | Activation; actual Manifest, Role Skill/profile and Context reads; READY. |
| `01a12b41-c42d-7bc3-b3a4-15a27a2feec1` | Browser Message read and real file creation; incorrect manually transcribed reversal correctly failed the business assertion. |
| `01a12b44-05b5-70d2-b79e-a5900a68e90d` | Explicit correction Message; programmatic reversal, real file replacement/readback/code verification; file and Web agree. |

Original request `b8e52186-c0cb-4a65-abcc-d4c5c07ff899` maps to `message-1`;
correction `f2c806ad-8643-4d79-9fcd-a313028878d7` maps to `message-2`.
Each browser action made one POST and had its own queried accepted receipt.
No unknown input was replayed; the correction was a distinct explicit request.
SQLite confirms three unique completed Turns on that one Thread. The final
read-only browser verification submitted no input.

CLI and preflight daemon were `0.159.2`, SHA-256
`1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e`.
Per-Turn native logs correlate all three Turns with client `0.159.2` and
resolved effort `low`; stored Turn contexts retain default effort `null`.
After the Turns, native automatic update advanced the isolated daemon/updater
to `0.162.1`, SHA-256
`628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1`.
This is not a claim that the entire lifecycle stayed on one version, nor
independent provider billing/wire-effort certification.

Three earlier preflight fixture attempts consumed zero model Turns. Their
failures exposed transport framing and probing before Session adoption.
The paid run also exposed a fixture keepalive omission; exact owned resources
were subsequently stopped and audited manually. The first cleanup audit
correctly retained Homes when the newer updater remained; final audit found
no owned processes, tmux servers, native sockets or credential copies and
removed all eight allocated directories.

Existing A/B historical-read-only, unknown-send/lost-receipt and deduplication
evidence remains unchanged, as do prior live TUI cancellation/viewer/resize
results. They are not relabeled as newly run. No Mac environment was available:
macOS fresh npm install and PTY smoke remain a separate platform gap.
Sandbox-restricted tool execution remains unavailable on this host; the normal
authorized development tool/context/business chain is now demonstrated.
