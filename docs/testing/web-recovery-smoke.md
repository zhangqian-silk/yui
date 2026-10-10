# Historical Sessions and lost HTTP acknowledgements

Task109 message-3 continuation, 2026-10-10. This supplements, rather than
replaces, [the original report](web-runtime-smoke.md) and
[the earlier repairs](web-runtime-repair.md).

## Run

Use Node 24, `make install-local`, tmux, and an installed `browser-use` connected
to a browser. The existing runtime smoke owns a fresh Home, real Controller,
SQLite, Host, Runner and local Git remote. Only the external native protocol is
deterministic. It never uses account credentials or a paid model.

From the checkout, set `PATH` to the chosen Node installation plus ordinary
system tools, then run (choose two unused adjacent loopback ports):

```sh
YUI_SMOKE_RECOVERY=1 \
YUI_SMOKE_PORT=18969 \
YUI_SMOKE_EVIDENCE="$PWD/output/web-recovery" \
BROWSER_USE=/absolute/path/to/browser-use \
python3 /absolute/path/to/browser-workflows/scripts/with_server.py \
  --server 'exec node scripts/smoke-web-runtime.mjs --serve' \
  --port 18970 --timeout 90 -- node scripts/run-web-recovery.mjs
```

The wrapper waits for fixture teardown before the server helper stops its
process group. Failures retain the exact sandbox for diagnostics; success
removes it only after Job exit/socket cleanup, fixture Task completion/archive,
Controller stop and tmux cleanup. Neither real Task109 nor Tasks94–108 are
archived. Reports, screenshots and native-input logs remain under the selected
evidence directory.

The test-only proxy binds loopback at `YUI_SMOKE_PORT + 1`. Its `/__fault`
control exists only in this disposable fixture, never in the product.
It forwards to the real authenticated Web endpoint. The two faults are:

- Before forwarding: close the connection without sending the request to Yui.
- After response: let Yui persist the input and return its genuine receipt,
  record that response, then close the browser connection without delivering it.

Faults remain armed across browser transport retries until explicitly cleared.
Receipt reads can also be disconnected while testing reload/new-tab recovery.
No fake `unknown` response, fake Store, or browser response substitution is used.
The browser can retry a failed connection itself; the captured requests retain
the same request-id, and the real backend's idempotent-replay receipts and native
Turn count are checked.

## Requirements and assertions

| Requirement | New actual assertion and evidence |
| --- | --- |
| A: formal current → historical Session | `task role session new` creates the replacement through the real lifecycle. Browser selects both real Session identities and reads historical native content. |
| A: no historical effects | Browser Send, Stop and upload are unavailable. Ctrl+Enter `/stop` cannot execute. Direct queue, interrupt, model-change and material POSTs return 409 with `Historical Session is read-only`; Messages, artifact listing, native Turn count and current model axes remain unchanged. |
| A: supported local feedback | “Discuss these versions” explicitly returns to the current Session and stages pinned references without sending. It preserves the current draft rather than writing to history. |
| A: target isolation and reconnect | Old/current drafts stay separate; reload restores the current draft. The second Task keeps its own native Session. |
| B: accepted input, lost response | Record actual queued/idempotent HTTP responses, disconnect receipt reads, verify Send blocked, reload and genuinely close/create a fresh browser target. Restore transport and query the same original request-id: accepted, exactly one additional native Turn, no frontend resend. |
| B: no forwarding | Proxy proves this injection never forwarded the POST. The authoritative receipt still correctly says unknown: absence is not a guarantee that permits automatic resend. Original request identity and disabled Send survive fresh-tab recovery; native Turn count is unchanged. |
| C: real Codex TUI/local model | **Not executed: isolation preflight blocked.** See below. The deterministic native fixture must not be described as actual Codex TUI. |

## Product correction

Before this continuation, pending sends lived only in `sessionStorage`.
Closing that tab removed the request identity; a new tab enabled Send even
though the original effect was unresolved. The new focused regression failed,
and the real fresh-target browser assertion reproduced the same failure.

The product now retains only unresolved request-id/action under the exact
owner/Thread key in `localStorage`. Message bodies, materials and unsent drafts
stay tab-local. New or already-open tabs check that shared identity at the send
boundary and query the existing receipt, never replay it. Resolution removes
only the matching identity, not a newer request from another tab. If identity
storage fails, no request is sent. A missing backend record remains unknown.
This is browser recovery metadata, not a second authoritative message store.

## Fixed verification identities

Original completion: `e83233edcbe5a0c4d6014fa75dde9ea8fc32ca85`.
Remote master was read-only rechecked at the start and remained
`c079c41d9ad40ff001b30cbf8ababfd65c4848a3`; no rebase/push/PR/merge/release.

Product fixes: `16439ffe0c8db9e9b06566bfa67e876640835922` and
`d93137b01a037b1a44ebdbb57babacde2f9855d8`.
Full `npm test` on the latter: 733 tests, **726 passed, zero failed,
7 macOS-specific skips**, test phase 19.615 seconds.
The focused view suite passed before the final send-boundary extension; the
final full suite includes that extension.

Browser/process candidate `ca3130724f124247fa4652b350ce8633b9312046`
adds only four historical-effect assertions over that product candidate.
It passed **3 new browser journeys and all 12 real-process checks**. Subsequent
wrapper-only verification is recorded with its own exact commit in
`report.json`; no earlier receipt is relabeled as testing later source.

Evidence under `output/task109-recovery/`:
`red-fresh-tab/browser-results.json` is the preserved product failure;
`final/` contains the fixed browser/process receipts, screenshots,
`history-receipts.json`, `recovered-receipt.json`, `transport.jsonl` and
`native-turns.jsonl`. `core-final.log` is the full core result.
Earlier runs include harness corrections (rendered labels, asynchronous
history loading, collapsed receipt text, and ensuring a genuinely new browser
target instead of reusing an about:blank tab); they are not product failures.

## C: exact environmental boundary

The installed real binary was identified without starting a model/TUI Session:

```text
codex-cli 0.159.2
/data00/home/zhangqian.0326/.nvm/versions/node/v24.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
SHA-256 1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e
```

Official configuration documentation was consulted:
`https://developers.openai.com/codex/config-advanced#custom-model-providers`
and `https://developers.openai.com/codex/config-reference`.
It describes user-level `model_provider`, custom `base_url` and
`wire_api = "responses"`, and a local `model_catalog_json`. This is guidance,
not evidence that this fixed binary's full TUI/protocol integration passed.

`codex-preflight.json` records isolated version/help execution under `strace`
with `connect`/`sendto` denied, empty HOME/CODEX_HOME, no inherited credentials,
and scratch cleanup. Version/help succeeded and `--remote` exists.
Both `unshare --user --map-root-user --net` and `unshare --net` failed with
Operation not permitted. `bwrap --unshare-net` failed configuring loopback
(`RTM_NEWADDR: Operation not permitted`). The binary is statically linked.

No actual TUI/model Session was launched. A user-level provider URL and proxy
variables alone were not accepted as fail-closed evidence against unanticipated
external model/telemetry paths. This does **not** prove every possible isolation
method is unavailable; the simple supported namespace paths on this host are
unavailable, and a bespoke syscall/network supervisor was not added.

C still requires an execution environment that demonstrably permits only the
local fixture endpoints (for example a working loopback-only network namespace).
Then verify the fixed version's streaming Responses contract and model catalog,
authenticated same-Thread resume, history, input/response, resizing, cancellation,
read-only writers and teardown. Alternatively, the user must explicitly accept
C remaining unverified. No permission to use real accounts/paid APIs is sought.
Task109 is not complete on the basis of A/B passing alone.
