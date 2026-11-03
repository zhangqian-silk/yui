# Bound original page forwarder — evaluator only

This is not a product CLI/Skill, cache, load receipt or authority grant.
`--original-tool available` installs one fixed executable and its two dependencies
in a fixture; `absent` is the default. Real use needs a separate authorized freeze.
The old full-download/body-range implementation is audit-only in commit
`d674fb32` and run75's frozen archive. There is one active path, not a fallback.

## Entry and explicit source selection

Use the absolute Node/tool paths from this fixture's startup guidance:

```sh
/absolute/node /owned/tools/original-tool.mjs '{"kind":"run-message","runId":"run-1","messageId":"message-1"}'
/absolute/node /owned/tools/original-tool.mjs '{"kind":"task-message","messageId":"message-2"}'
/absolute/node /owned/tools/original-tool.mjs '{"kind":"inbox-message","messageId":"global-message-1"}'
```

| Explicit kind | Legitimate pointer | Exactly one normal CLI read |
| --- | --- | --- |
| `run-message` | Exact Run context's `task-message` refId and that Run ID | `--json task run context expand <inherited-task>/<run> <message> --store task-message --mode full` |
| `task-message` | Exact Task Message ref from current context or a wake's originals | `--json task message show <inherited-task>/<message>` |
| `inbox-message` | Exact current Global inbox Message entry | `--json inbox show <global-message>` |

Kinds are required; Message IDs never select a route implicitly. A Task wake is
not a Message. Task inbox/wakes, arbitrary stores/commands, Skills, writes and
fallback routes are unsupported. CLI authorization remains authoritative for
every invocation, including each continuation. A caller must read the actual
pointer; this helper does not discover or attest pointer provenance for it.

There are **no cli/Home/owner/Thread request fields**. The existing fixture-owned
`provider.json` supplies the same installed `originalTool.cli/home` binding used
by its provider descriptor. No extra identity/business-truth file is created.
Inherited Home/scope/Task/Role/Agent/Thread must be present and consistent;
the normal CLI then validates the actual managed Session and record access.
No identity is filled in, cleared, borrowed, repaired or overridden. Configuration
is a location binding, not a new grant. Missing identity fails before any CLI call.
This prototype still requires full managed environment hints, not Desktop-only
native-ID support. No account/credential environment is logged.

## One page, exact stdout

Each invocation executes at most **one** normal CLI read with `shell:false`,
unchanged inherited environment, a bounded buffer and timeout. It validates the
returned envelope/source/cursor/offset/Unicode/totals shape, then forwards the
entire original UTF-8 stdout byte-for-byte: JSON whitespace, record fields,
padding, complete `contentPage.text` and all metadata. It adds **zero** stdout
wrapper bytes. Inline small originals remain complete CLI objects.

For the next page repeat the same kind/IDs with `cursor` equal to that page's
literal `contentPage.nextCursor`. The cursor must carry the same source/digest
and requested offset. The helper never follows it internally, restarts at page
zero, trims, extracts only records, normalizes, silently truncates or caches.
Default/hard caps: 64 KiB combined stdout/stderr and final stdout, 20 seconds,
2 MiB declared document. Optional `maxOutputBytes` (1024–65536) and `maxMs`
(1–20000) only lower caps. An oversized valid CLI page fails explicitly; no
second range protocol or automatic retry is added. Failure exits 1 with empty
stdout and a bounded category on stderr, preserving an audit when possible.

One partial page is **not** a verified whole original. The receiving observer
must join all actual text contiguously in the same owner/Thread/Turn/epoch,
using the literal preceding cursor, constant source/digest/totals, final length
and SHA-256, then compare the exact source body against independent truth.
Missing/duplicate replacement pages, changed sources, summary-only text,
truncation, late/equal-deadline output and foreign identity cannot earn full
coverage. This is output coverage, never present model memory or authorization.

## Evidence, cost and lifecycle

`original-tool.mjs` logs its request, selected identity hints, cwd/time/file hashes,
the single actual CLI call/raw response, and actual final stdout to the existing
fixture evidence directory. Audit failure emits no source stdout. This is
experiment evidence, not an OS-tamper-proof security boundary or a cache.
`original-evidence.mjs` accepts only the frozen static Node/tool/JSON argv,
unique matching audit and exact native owner/cwd/start/end plus actual stdout.
It purely revalidates the captured bytes; it never executes historical commands.
The result feeds the existing native CLI-page/full-original judge, not a second
body-range coverage protocol. Skill/other-field checks retain their own evidence.

Capture helper attempts, underlying calls/wire, actual outer stdout/errors,
discovery usage and maintenance separately; overlapping counts are not additive.
Captured internal counts are lower bounds; missing audit records mean unknown
totals, not zero cost. Preserve all old seals/results and derived corrections.
Fake `normal-warm` exercises cold Run, later Task and Global entries in actual
zsh login shells through the same product CLI with inherited managed identity;
its explicit negative prechecks are fake-only, never scripted real adoption.
The fixture registers teardown before setup, stops exact owned resources and
archives before release. No new daemon, global change or cleanup protocol.
