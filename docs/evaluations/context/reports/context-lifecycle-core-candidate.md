# Lifecycle instruction working-set candidate

Historical candidate design and validation report, not current testing policy
or deployment status. [Report index](README.md).

## Scope and evidence identity

This is W7's run-122 candidate for original inputs message-342 and message-344,
not another wording-only pass. Parent `016e6912` and its run-116 audit remain
intact. The comparison source is the exact read-only Git object `8c5ed3d3`,
including Runtime, Leader, Operator and their references. In particular, the
Operator safe-body transport added on Main is preserved verbatim (apart from
the trailing empty line) in
`skills/yui-operator/references/body-transport.md`; it was not restored from the
older W7 Role entry.

Only Skills, their integer versions and this report change. No Host, CLI,
evaluation, global installation, persistent schema or loading-receipt mechanism
is added. Runtime/Leader/Operator versions are 29/13/15. This patch must be
integrated with Leader-owned Host commit `72e1dd5b`, not used to overwrite its
source changes. That commit was inspected as a read-only interface reference:
the Host mechanically checks every input, emits a short ordinary marker and
provides current entry pointers on first attachment/reconnection or metadata
change. It does not prove provider memory or compaction.

## Responsibility architecture

The entry points are current shared/Role cores with action indexes. They retain
identity, sources, authority, actor/operation ownership, original-reading,
claim/ACK and unknown-effect boundaries. They do not initialize every procedure
in a Task stage. Project/custom Skills remain applicable; every current
Session-listed entry is loaded on initial/reconstructed entry, including custom
Skills. This candidate does not omit them from the contract.

Leader's former `active -> execution.md` mandatory edge is removed.
`execution.md` is now an optional operation index, not a hidden mandatory
handbook. The former body is separated into implementation, allocation,
review/result disposition and acceptance/completion actions. Brief maintenance
and artifact operations have separate triggers; delivery artifact work no
longer requires loading the entire Draft activation procedure.

Operator separates outcome selection, submission, safe body transport,
progress/user decisions and lifecycle actions. A known Task request does not
force catalog traversal, and merely routing a failure does not require the
Leader's resumption proof. Main's routing, explicit intent, submission
idempotency, transport and delivery boundaries remain available at those action
owners. No special fixture key, Task ID or failure string is encoded.

Runtime retains the earlier publication/recovery leaf split. Detailed context
discovery/pagination and Global pending/diagnostic operations are also routed.
Moving text is not the claimed improvement: the important difference is removing
unconditional stage-entry and history-restoration edges.

## Behavioral paths and complete instruction sets

Let `C` mean the current exact Manifest profile plus Runtime entry, applicable
Role entry and every other current Session-listed Skill entry. Let `P` mean the
actual applicable Project Skill/Policy/Knowledge instructions. Original current
requirements, relevant input, results and authorizations are facts required in
addition to these instruction files. Their identities and full bodies cannot
be replaced with this table.

| Path | Required working set / read | Conditional material, not a bundle |
| --- | --- | --- |
| Direct simple Task implementation | `C + P`, current Task requirements/input and legal delivery workspace. Implement/verify/commit directly; no placeholder WorkItem. | Implementation manual when investigation/verification design needs it. Completion manual at actual `task complete`; independent Review/Integration only when those operations apply. |
| Long Task, ordinary next turn | Host mechanical check, fresh relevant facts; reuse unchanged full `C/P` and current-action instructions actually still present. No repeated body read just because a new input/turn exists. | Newly selected or changed action file in full; meaningful Brief changes use progress manual. Do not reload every previously visited topic. |
| Compaction, continue same Task | Check/current pointers, exact profile and full current `C`; recover applicable `P`, relevant originals and the current action's full references. Restore current authority, not the old transcript or manual history. | A previous configuration/review/retry procedure is absent unless that action still applies. Instruction loss alone does not trigger Session replacement/recovery. |
| First genuine execution recovery | `C + P` as applicable, exact failure/operation/receipt and prior effects; Runtime recovery router plus the actual leaf, e.g. execution-failure for a retry or uncertainty for Controller/unknown-effect intervention. | Replacement, Host custody and inbox recovery only for their distinct triggers. Current retry ownership is checked before a manual successor. Reading recovery does not grant Worker/Reviewer supervisor powers. |
| Ordinary known-Task Operator routing | Operator `C`, full user original/current target facts, submission manual before submitting; preserve chosen operation request identity. Claim before handling and ACK after legal routing. | Outcome discovery only if identity/outcome is unclear; safe transport for quoted/nested/long bodies; Leader recovery procedures only if Operator actually undertakes authorized recovery, not for submission alone. |
| Draft discussion | Leader `C`, planning manual, authorized current requirements and relevant `P`. Discuss requested outcome, save only permitted revisions, wait for feedback. | Artifact manual only on saving/citing a document; no delivery, dispatch, Review, Integration or completion merely to end discussion. |

An explicit managed Run also needs `dispatched-run.md` and exact frozen
Task/Run/Snapshot verification before planning/acting. It does not apply to a
direct Leader conversation or ordinary Global context. Paginated originals need
`context-reads.md` in full before assembling the pages. Body completeness remains
mandatory even when the rest of a discovery catalog is intentionally unread.

Localized version/reference changes reload their full affected bodies; other
available unchanged full instructions remain reusable. Missing or uncertain
context reloads the current set, not all historical topics. There is no server
or Agent state purporting to certify that a body is remembered.

### Source-byte accounting, not a behavioral claim

Counts include complete files, not selected excerpts. UTF-8 bytes are neither
tokens nor a measured provider-context reduction. Dynamic facts, exact profile,
other listed/custom entries and `P` are additional on both sides.

| Static shared/Role set | Main `8c5ed3d3` | Candidate |
| --- | ---: | ---: |
| Runtime + Leader entries | 29,128 | 15,526 |
| Main's mandatory active entry + execution body versus candidate direct core | 51,002 | 15,526 |
| Runtime + Operator entries | 35,766 | 14,134 |
| Known-Task Operator submission, candidate core + submission | — | 17,330 |
| Direct Leader at actual completion, core + completion | — | 20,124 |

Quote-sensitive submission additionally loads the full 1,881-byte transport file.
A retry loads the recovery router (2,046 bytes) plus the 5,817-byte execution
failure leaf; other applicable dependencies, such as inbox recovery for retained
claims, add their complete files. A growing task can legitimately use several
manuals; they are not all repeated after every compaction.

## Boundary preservation and routing map

| Necessary behavior | Constant boundary | Action owner/material |
| --- | --- | --- |
| Analysis stays read-only | Runtime core; Leader query route; Operator explanation boundary | Planning/progress/artifact guidance does not authorize writes for analysis. Required input handling receipts remain distinct. |
| Original identity is not a command key | Runtime and Operator cores distinguish source, correlation/effect and operation request identities | Submission retains a key for that exact operation; safe transport retains exact target/intent/body and verifies the saved body. |
| Operator routes; Leader executes/disposes | Both Role cores; prerequisites attach to their actor and actual operation | Routing ACK need not wait for downstream completion. Exceptional takeover reads Leader and applicable manuals, without new authority. |
| Claim is reservation, full originals before business, ACK after own disposition | Runtime core's four-action flow | Inbox recovery retains original claims/targets and exact revision; no ACK for merely receiving or emptying a queue. |
| Unknown effect is never replay authority | Runtime core, all Role recovery routes | Existing recovery router/leaves and inbox recovery require exact prior-effect/receipt inspection; no changed key or timeout-based replay. |
| Execution is not acceptance/publication/archive | Runtime/Leader/Operator cores | Review disposition, completion, Integration, publication, scope and archive preserve their separate operations/evidence. |
| Draft/activation/terminal gates remain independent | Leader core and submission creation-only stop | Planning, completed-followup and task-delivery preserve explicit activation/reopen semantics, no old-planning promotion. |
| Dispatch remains decision-complete and frozen | Allocation manual retains Main's context-ref selection and scope refusal | Assignment execution, immutable Review and Integration manuals remain distinct, not loaded for ordinary direct work. |
| Full reading and valid reuse | Runtime core; all listed/custom entries and owner versions | Context reads retains source/digest pagination; relevant bodies read through EOF, not summaries or read-success flags. |

## Existing engineering protections, not model substitutes

No new semantic engine is proposed. Current code already supplies:

- Exact Run Context/Snapshot, selected refs, writable scope and immutable
  Candidate/Review boundaries (`src/context/runContextPack.ts`,
  `test/core/frozen-run-context.test.js`). A missing Snapshot blocks that
  execution, not authorized supervision.
- Durable original claim/ACK identities and separate delivery/handling state
  (`src/message/inboxReceipt.ts`, `src/commands/inboxCommands.ts`).
  The command enforces valid request-ID shape, retained claims and original
  target/content; it does not infer business completion from a receipt.
  `test/core/agent-inbox.test.js` covers unknown delivery, exact Assignment
  access, partial batches, same-tick revisions and successor handling.
- Brief compare-and-swap and source-qualified fixed windows
  (`test/core/context-temporal.test.js`). These reject stale writes; they do
  not decide which intent supersedes which restriction.
- Current entry VERSION/readability checks. Host `72e1dd5b` uses short ordinary
  notices without a persistent loading receipt. This W7 checkout's tests do
  not independently validate the combined newer Host commit.

Agent judgment still selects the current action, interprets supersession,
decides review value and evaluates semantic disposition. Engineering cannot
prove all originals were understood or detect provider compaction. These are
material real-Agent validation questions, not reasons to introduce a rule engine.

## Verification and handoff

- Node v24.20.0 build passed.
- Existing complete core/platform suite: 924 tests, 916 passed, 8 explicitly
  skipped, zero failures, about 24.2 seconds. No wording tests were added.
- Skill Creator validation passed for Runtime, Leader and Operator.
- Local and assembled package Markdown links/anchors checked, including
  cross-Role refs; 210 links, zero missing. Main's transport body matched exactly.
- Assembled runtime `compatibility` smoke passed with isolated fake-provider
  fixtures; setup/CLI/SQLite/PTY and owned cleanup passed. No real model ran.
- `git diff --check` passed. No edits to Main, src, evaluation or global state.

This is self-review, structural availability and deterministic regression
evidence, not independent model validation or proof of unchanged model behavior.
W8 should freeze the combined candidate/Host and exercise simple direct work,
long ordinary continuation, repeated actual compression, first genuine recovery,
quoted/nested payload routing and unknown-effect non-replay. Preserve full
requirements/project rules, exact original dispositions and actual produced work
when assessing results; total instruction ratio or isolated tool failures alone
neither prove nor disprove the architecture.
