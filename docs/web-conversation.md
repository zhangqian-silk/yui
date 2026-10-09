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

Storage 1.3 adds an optional selected-Session fence to new structured inputs.
Ordinary CLI Role-addressed inputs preserve their existing semantics. A selected
Session changing before admission retains the original input with nondelivery
evidence instead of sending it to its successor. Upgrade uses the normal
centralized 1.2→1.3 transition; no global Home is modified by development.
