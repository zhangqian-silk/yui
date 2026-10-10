# Structured conversation access

The Web dock separates **Conversation**, **Discussion** (durable Task records),
and **Terminal**. The global entry selects the existing Operator; a Task selects
its current Leader. Current and retained Sessions show their native Thread ID
and planning/delivery origin. Selecting history does not revive that Session.

Conversation uses the existing Codex connection and the local Web token boundary.
It reads metadata with `thread/read` (`includeTurns: false`) and at most 40 items
with `thread/items/list`. The schema was checked against Codex CLI 0.159.2.
Pagination is experimental and requires native store support: errors are shown
as unavailable, with no full-history fallback, daemon startup, `thread/start`,
`thread/resume`, or configuration change. Other adapters retain native access.
Source: official Codex App Server documentation, “API overview” and “Message
schema” (`https://learn.chatgpt.com/docs/app-server`).

Latest-page reads refresh every two seconds while visible. The existing Host
also exposes its most recent public assistant delta as a volatile, bounded
6,000-character projection fenced to Thread/Turn/item; history supplies replay,
not this cache. A lost/older Host is explicitly reported as live-unavailable.
Historical pages
pause latest-page refresh; **Latest / reconnect** returns to the latest page.
Messages retain exact item and Turn identity; only public user/assistant text
and allowlisted tool summaries are rendered. Reasoning and raw tool results are
excluded. Long messages are explicitly excerpted at 12,000 characters; native
access remains available for complete items. Native history is not Task status.
Reference-only native queue notifications retain their original text. The view
also labels the original **delivered Yui input** and Message ID when the named
notification, saved selected-Session fence and delivery evidence agree. These
are linked source records, not reconstructed native messages or a full Task
Message feed. Each page includes at most 40 such inputs and 48,000 linked text
characters; omissions/excerpts are explicit. Refresh preserves expanded reading
state. Switching owners resets pagination without replaying input.

Sending reuses durable queue input when idle and exact-Turn steer when active.
Stop uses the existing native interrupt, not Task cancellation or process kill.
Each request retains its ID in session storage before submission; the original
receipt can be queried after reconnect, without repeating the write. Submitted,
accepted, failed and unknown are separate dispositions. An interrupt acceptance
means cancellation was requested, not that execution is already stopped.
Stop never clears an unsent draft; message acceptance clears only the submitted
text if the draft still matches it.
Native questions/approvals remain on the native entry in this minimum surface.

## Lightweight input and Session model controls

Drafts and unresolved input identities stay scoped to owner and selected Session
in the current browser tab. Input receipts are read automatically while the
latest page is open; only confirmed acceptance clears the unchanged submitted
draft. Plain-language states distinguish sending, saved/queued, accepted, failed
and unknown, with the exact receipt available separately. Storage failure is
visible. Ctrl/Command+Enter sends; Enter still inserts a newline.

The small Slash menu implements `/help`, `/status`, `/model`, `/stop` and
`/latest`. Tab completes a unique match; clicking a suggestion fills the draft,
not an execution request. These are local Yui actions, not arbitrary shell or
native CLI commands. Unknown commands remain in the draft; **Send as ordinary
text** explicitly bypasses command interpretation. `/stop` uses the existing
exact-Turn interrupt and preserves the draft.

**Session model** reads the existing Agent capability catalog, including its
source, freshness and discovery errors. Only catalog models are admitted, and
fallback/failing discovery is not treated as support. Adoption is restricted to
the current, controlled Codex Operator or Task Leader with no active/unsettled
Turn or terminal writer. The Host serializes adoption with input, checks native
idle state, and calls `thread/resume` with only the same Thread ID, model and
`excludeTurns: true`. It never starts/forks a Thread, edits account settings,
permissions, Role/default configuration, or rewrites the immutable launch.

The UI separates the fixed launch request from the latest timestamped native
model confirmation. A response naming another Thread/model is not success.
Preflight rejection leaves the draft and permits an explicit corrected attempt;
an uncertain native mutation invalidates the observation and blocks automatic
replay. The browser retains its unresolved selection across reopening. Inspect
confirmation first; if it cannot be established, explicitly select a new Session
through existing lifecycle controls rather than retrying an unknown mutation.

This is a **live-connection selection**, not a permanent Session override:
Host restoration reapplies the fixed launch configuration. No deferred active-Turn
switch is scheduled. Older or incompatible native servers fail visibly instead
of receiving a simulated successful switch. CLI Session inspection and Web read
the same Host run-configuration observation; only the model axis is reported.
The protocol basis is the official Codex App Server “Start or resume a thread”
contract. Deterministic fake-Provider/real-Host checks do not prove support in
every installed native version or access to a particular real model.

Storage 1.3 adds an optional selected-Session fence to new structured inputs.
Ordinary CLI Role-addressed inputs preserve their existing semantics. A selected
Session changing before admission retains the original input with nondelivery
evidence instead of sending it to its successor. Upgrade uses the normal
centralized 1.2→1.3 transition; no global Home is modified by development.

## Text materials and fixed results

The Task Leader conversation accepts UTF-8 text, Markdown and supported code
files up to 256 KiB. Upload saves a file in the existing Task Artifact Git
repository; it does **not** send a message or execute work. Sending explicitly
adds verified same-Task `taskId / commit / relativePath / sha256` references to
the durable Message, alongside its existing selected-Session fence. Material
contents are untrusted data, never additional instructions or authorization.
The original Session is recorded in the artifact commit. Later Sessions can
read the same references through existing Task context and artifact commands.
This uses existing records and storage 1.3, without a new attachment schema.

Delivery → Saved files lists 40 entries per page at one pinned commit. Select a
file or enter a relative path and full commit to open historical evidence.
Text and same-path two-commit diffs load at most 12,000 characters per page,
without splitting a Unicode surrogate pair. Markdown is read whole, up to
256 KiB, so code fences and tables are not broken across page boundaries.
The shared escaped renderer supports headings, emphasis, strike-through,
inline/fenced code, nested ordered/unordered lists, task lists, quotes, rules,
tables (up to 32 columns), and explicit/reference HTTP(S)/mailto links.
This is a bounded prose reader, not full CommonMark, Math, Mermaid or HTML:
HTML and code stay text and never execute. The rendered document is shown
first; its source remains available in a disclosure.
Reference copy, page-text copy and explicit full-text download preserve the
selected version. **Discuss these versions** fills the current Leader's draft
with the exact file (or both diff references); it does not send automatically.

The Web boundary rejects unsupported types, invalid UTF-8, control bytes,
oversize uploads, escaping paths, missing revisions and cross-Task material
references. Existing Artifact limits still bound reads (8 MiB per file); diff
generation has a 20 MiB output cap and five-second budget and fails explicitly
when exceeded. Unknown upload outcomes show the exact material path to inspect
in Saved files before any retry. Reading files, diffs or receipts never starts
an Agent or replays input.

## Fixed-version images

Saved files also reads static PNG, JPEG and WebP, up to 4 MiB, 8192 pixels per
side and 16 million pixels. Image type and dimensions come from the bytes, not
the extension or supplied MIME. Header/container validation bounds the read;
the browser performs decoding and visibly reports corrupt/unsupported images.
GIF, SVG, animation and other formats are explicitly unsupported; save a
static PNG/JPEG/WebP instead. No SVG, iframe, script or external image request
is admitted by Markdown. Images offer fit-width and 50–400% zoom, a scrollable
viewport, original-byte download, and exact-source feedback to the draft.

Markdown images load only when clicked. Relative and URL-encoded paths resolve
against the document's directory in its **same Task and commit**, never HEAD,
the working tree, or a network URL. Parent-directory references must remain
inside the artifact repository. Each displayed image shows its own path,
commit and digest. Per document the reader allows at most 12 image slots,
two simultaneous requests, 16 MiB of loaded image bytes and 32 million pixels.
Beyond those bounds, open the individual file instead.

The existing `artifact.save` capability accepts `encoding: "base64"` for these
raster files; the CLI equivalent is
`yui task artifact save <task> plot.png <canonical-base64> --encoding base64`.
Default saves remain UTF-8. Image `artifact.read` responses carry
`encoding: "base64"`, `content`, `mime`, dimensions and the same immutable
reference/digest. CLI arguments remain subject to the operating system's
argument-size limit; the capability's decoded image limit is 4 MiB.
There is no new file store, persistent schema, automatic upload/send, or Web
image-upload flow. The existing conversation upload remains text-only.
