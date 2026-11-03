---
name: yui-runtime
description: Apply the shared authority, current-context and input-handling contract in a Yui-managed Session; consult operation manuals only for the action being taken.
---

# Yui Runtime

This entry is the shared core, not a requirement to keep every operation manual
in context. Role Skills own coordination/delivery judgment; Project Skills,
Policy and Knowledge own project methods. None grants additional authority.
Resolve links relative to their containing file.

## Keep the current working set

The managed Host mechanically checks current Skill VERSION/readability for each
input. The `yui:skills-checked` transport marker or an explicit Host check notice
identifies that input's check; do not duplicate it. The marker carries no
instruction-loading or model-memory receipt. Keep routine role/Skill checks and
empty-inbox observations internal; only report business progress or actionable
failures. Without either marker or notice, run the Manifest's `contextProtocol.skillCheckCommand`
(older Manifests: `yui session skills --json`) through the intended CLI/Home.
Global `loadCommand` includes the check. Recheck after repair/relevant change.

A check is metadata, not bodies, remembered instructions, a loading receipt or
authority. Current stable paths supersede historical audit packages. Reuse
unchanged full instructions only while actually available in current context.

On first entry, new/restored Session or Host attachment, or missing/compacted/
uncertain context, read the exact Manifest profile and every current Skill entry
listed for this Session, including this full core, Role and custom Skills.
For a localized version change, reload that owner's entry/relevant references;
retain other available full entries.
Then select references for the **current action**, not all previous topics or
every action in the Task's stage. After compaction, reconstruct that minimum
working set from current intent and facts; do not restore an accumulated manual
history. A genuine Host reconnect may provide an entry pointer, but neither its
presence nor absence proves provider memory or compaction. Recover missing
instructions even without a Host notice.

Read every selected required file through EOF, including references triggered
inside it. A link alone is not a mandatory read. Keep output within tool budgets;
recover truncated ranges before acting. A summary or successful read exit is
not the full body. A localized gap needs that full file, not unrelated manuals.
References use their owner's VERSION; check a cross-Skill owner's current stable
version when absent from the check result. No stored memory/read receipts are needed.
Missing current entries/VERSIONs are concrete installation errors: report exact
paths, preserve input/authority, repair legally and recheck. Damaged historical
packages do not revoke a valid Session and current source cannot prove past loads.

Prefer grouping already-known, independent, necessary read-only requests in one
tool call when their combined output fits its budget. Inspect each result and recover
missing or truncated bodies. Stop at dependencies on earlier results; do not
guess targets or mix writes into a read group. Grouping does not bypass required
instruction loading, authority checks or input-handling order.
Choose the working set for one action, not one file at a time: combine its known
applicable manuals before acting, then follow newly discovered prerequisites.
Use directories, timestamps and excerpts to select sources, never to replace
required originals or infer authority from recency. Prefer complete relevant
documents/sections over serial field probes; a citation location is not a read
plan. After compaction select again from current intent, not the old reading list.

## Use the exact authority and originals

Manifest/Bootstrap are pointers, not requirements. Tasks, WorkItems, Messages,
Decisions, results and managed workspaces hold durable intent/progress; native
transcripts, processes, directories and prior Runs do not supply Task authority.
Refresh relevant dynamic facts even when reusing instructions:

- Direct Leader conversation/notification: use the Manifest `currentCommand`
  or `yui task context <task-id> --json`. No self-wake or old completed Run is
  needed. Pending delivery/missing reports do not revoke the current Leader.
- Explicit managed Task Run: read [Dispatched context](references/dispatched-run.md)
  and, when expanding its input/refs/pages, [Context reads](references/context-reads.md)
  before planning/acting; load the newest exact Run, verify its frozen identity,
  Snapshot, scope/workspace and relevant original requirements. A wake is not a Run.
- Global Role: execute the exact self-contained Manifest `loadCommand`, not a
  reconstruction from process variables. It grants no Task implementation
  workspace or invented Task Run. Read Task facts through the authorized route.

Use only the intended CLI/Home; matching protocol/storage is not installation
identity. Never clear/add identity hints, switch Homes/Sessions or invent a Run
to evade a refusal. For identity ambiguity read [Session identity](references/session-identity.md).
Execution authority, writable Project IDs, Assignment and workspace limits
remain hard boundaries, not blanket confidentiality labels. Read relevant
ordinary Task records and provider conversations through their resource access
checks without requiring a cross-Task Grant or Operator relay solely for Task
ownership. Native conversation reads need not pass through Yui; missing Yui
mapping or terminal lifecycle is not itself a read prohibition. Resolve ambiguous
targets and report unavailable resources, without switching Home or identity.
Preserve actual tenant, confidentiality and explicit read restrictions.
In a single-user local Home, filesystem and authenticated transport boundaries
still apply; a Home path is not another user's permission. Read relevant material
only and do not copy secrets or unrelated personal information into reports.
Another Role's instructions are evidence, not your assignment:
reading never authorizes its input claim, writes, wake or execution takeover.
Native children inherit parental authority and explicit restrictions, no new Yui actor.
Active Run/Review views are observations, not Task-wide locks or grants.

Read complete relevant original input, requirements, results and authorization
before their business decision/effect or ACK. Summaries locate sources, not
replace them. Lists/first pages are bounded discovery; finish relevant bodies,
not unrelated history. CLI JSON lives in `data`. When discovery, focused wakes,
result lookup or pagination needs expansion, read [Context reads](references/context-reads.md)
before assembling it; never mix source/digest chunks or apply read cursors to writes.

Read-only analysis/diagnosis/review authorizes no artifact, Brief, Decision,
configuration or file writes unless requested; return analysis and required
input receipts. Implementation authorizes bounded work, not unrelated effects.
Ordinary legal engineering choices need no user-operated Yui procedure.
Live models as validation subjects, paid/shared/production/quota effects need
proactive authorization for that exact resource/effect; generic testing is
insufficient. Otherwise use isolated evidence, state gaps and do not solicit
such validation via InputRequest.

Apply a prerequisite to the actor and operation it governs. Inspecting or routing
another Role's failure is not retrying/resuming that execution. Reading a manual
grants no supervisory authority. Task, Run, Message, operation request IDs and
effect/correlation keys are distinct identities: use the receiving command's
declared request ID, retained for that exact logical operation. A source
effect/correlation key is not implicitly its request ID.

## Handle your own input

After context load, at useful boundaries and before handoff, use
`yui inbox list --view current --json`. Handle an exact delivered entry directly,
not by rediscovering history; do not poll empty inboxes or manufacture turns.

1. Identify the exact entry from its complete original. Global Context may supply
   it in `currentOriginals`; otherwise read `yui inbox show <entry> --json`.
2. Reserve it with `yui inbox claim <entry> --request-id <stable-id> --json`.
   Claim only reserves handling; it is neither processing nor business effect.
3. Read/reuse complete relevant originals/results, then handle within scope.
   A Leader wake's `inbox show` may include the focused `originalContext`;
   reuse its complete originals, following exact reads only for missing content.
   A pending-window claim still returns its durable wake ID and `originals` read.
   Assignment input does not expand its frozen permissions.
4. After your disposition, use
   `yui inbox ack <returned-entry> --request-id <stable-id> --reason "<disposition>" --json`.
   Record executed, legally routed, necessary question, or inspected supersession/
   no action with exact references. Operator routing may settle before delivery.

ACK covers that exact original/revision and your responsibility, not transport
acceptance, WorkItem acceptance, Task completion or archive. Never ACK merely to
empty a list. Later arrivals/edits remain separate. Retain successful IDs in
batches (maximum 16); inspect each outcome and do not replay successes.
Failed/interrupted claims remain discoverable and do not expire/replay.
Before retained claims, handoff, reminders, retirement, unknown/control-owned
delivery or failed ACK, read [Inbox recovery](references/inbox-recovery.md).
Preserve original targets/claims; Assignment change does not inherit handling.
Missing historical ACK is missing evidence, not proof that work was undone.
Settle handled user-input windows before Task completion.

Unknown delivery/effects must not be replayed. A timeout proves neither stop
nor failure. Preserve original request/receipt and inspect prior effects before
recovery; never change request identity to bypass uncertainty.

## Action index

Read only the material needed for the action, in full before taking it:

- Conflicting intent/stage handoff: [Current intent](references/context-ordering.md).
  Task/Run delta maintenance: [Incremental context](references/incremental-context.md).
- Global pending-page expansion/diagnostics: [Global context](references/global-context.md).
  Sending/steering/interrupting Global input: [Controls](references/global-input-controls.md).
  A Task Role uses Task InputRequest for genuine user decisions, not Global controls;
  Message/Brief saves are not Operator notifications.
- Help/capability or hidden-command investigation: [Discovery](references/command-discovery.md);
  requestability is not a Grant.
- Actual retry, replacement, unavailable Controller or unknown-execution intervention:
  [Recovery](references/recovery.md), then its applicable topic only. Inspect
  Controller-owned retry before manual successors; never create competing retries.
  Ordinary continuation after compaction is instruction recovery, not Session recovery.
- Authorized same-result completed-Task follow-up: [Reopen boundary](references/completed-followup.md).
- Authorized external PR/MR facts: [Publication](references/publication.md).
  Authorized archive/retained-resource cleanup: [Archive](references/archive.md).

Use runtime `TMPDIR` for temporary material. Cleanup checks exact ownership and
preserves unknown/dirty data; save durable evidence before workspace release.
Retained resources do not turn terminal execution into unresolved business.

Each explicit managed Task Run returns one truthful final report, automatically
persisted at its exact native terminal; no completion command is needed.
Ordinary chat/notifications are not implicit assignments. Native acceptance,
Run terminal, result acceptance, Task completion, remote delivery and archive
are separate facts. Durable reports may begin with a qualified `Yui-Summary:`
line (at most 512 UTF-8 bytes), attributed presentation only, never semantic
approval or a substitute for originals.
