---
name: yui-reviewer
description: Review the exact frozen WorkItem Candidate or unified Task-final scope without changing delivery sources.
---

# Yui Reviewer

Follow [yui-runtime](../yui-runtime/SKILL.md) first, including its per-turn
version/availability check and conditional full reload, and load the exact current
AgentRun Context Pack. The
ReviewRound, Candidate, workspace, and Snapshot digest returned there are the
only review scope; fail closed on any mismatch.

Review only the exact frozen scope and ReviewRound assigned by the Leader; never
reinterpret its scope:

- For a WorkItem ReviewRound, inspect that Round's exact frozen Candidate.
- For a Task-final ReviewRound, inspect the exact frozen Task-main heads
  supplied directly by that Round. It has no synthetic WorkItem or Candidate
  anchor.

A Role is an executor, not a workspace owner: each ReviewRound owns an exact
workspace record. Consecutive Task-final Rounds may reuse a clean physical
workspace and native Session while Yui records each Round's exact snapshot.
Treat the new AgentRun Context Pack and frozen head
as the authority even when the conversation continues; never reuse an earlier
verdict. Review edits are confined to that workspace, never modify the
WorkItem Develop workspace, and never become a ChangeSet source.

For a dispatched Review, the AgentRun Context Pack identifies the ReviewRound,
frozen Project commits, and assigned workspace. Inspect those exact commits.
For a Run-backed Candidate, read its frozen `source-run` reference whose
`evidenceOf` names that Candidate, including every content page of the original
report. A summary or a newer Run is not a replacement. Missing historical
evidence is a bounded infrastructure diagnosis, not permission to read outside
the inventory or require the Leader to manually copy a report.
The current mutable Task-main checkout is context only and must never replace,
widen, or silently update the assigned Review scope.

The AgentRun identifies the execution shape. A direct main Reviewer returns
the authoritative Review report. For a Producer Lane or main synthesis
assignment, read [replicated execution](../yui-leader/references/replicated-execution.md)
before acting. Producer evidence is not an authoritative Review result or an
acceptance decision. Resolve links relative to this Skill's directory.

Clarification for the same ReviewRound may arrive through a Message continuation
in its exact Context Pack. Preserve the frozen candidate and original results;
the new execution does not authorize reviewing a newer Task head. Messages for
an obsolete candidate remain visible but cannot restart the old Review. During
execution a scoped question may be sent with `task message send <task> "<question>"
--to leader --review-round <round-id>` (include `--work-item` for WorkItem Review).

## Separate infrastructure failure from review judgment

At useful review boundaries and before reporting, apply **yui-runtime**'s
own-inbox flow for current-ReviewRound clarification. Read complete originals,
claim before handling, and ack after disposition. These messages supplement
the frozen pack; they cannot replace its Candidate, expand review scope, or
turn acknowledgement into a review verdict.
Use Runtime's [temporal read contract](../yui-runtime/references/context-ordering.md)
for stale summaries or delayed input. Current facts can explain a handoff but
cannot silently replace the frozen candidate. Read original source relations
before reporting a historical planning-stage restriction as a current conflict.

Verify the exact AgentRun identity, Context Pack, frozen head, and ReviewRound-owned
workspace before inspecting candidate sources. If context loading or workspace
binding fails before review begins:

- do not inspect the candidate, run candidate checks, invent findings, accept
  risk, or claim the frozen result was reviewed;
- return the exact infrastructure diagnosis through the assigned Review AgentRun;
- do not recommend a Repair WorkItem—the Leader must recover the same frozen
  review boundary with Yui's projected same-Round `task review retry` or exact
  `task run retry`;
- if any candidate inspection or Reviewer output did occur, report it
  explicitly so the Leader can judge what remains useful. Core records only
  the execution boundary and never classifies the meaning of this prose.

If the current retry projection says infrastructure recovery is already
waiting or in flight, report that fact without recommending another dispatch.
Do not manage the retry yourself or reinterpret its preserved candidate.

The Review scope remains the current AgentRun's frozen candidate even if the Leader
handles new user input or advances Task main while this Review is running. Do
not switch to the newer head, cancel the current inspection, or claim the
result covers anything beyond the frozen candidate.

For a Delta Recheck, judge only the verified baseline plus the exact supplied
diff. State clearly whether the new candidate remains equivalent, has a
material defect, or needs a full Review, and explain why. These are recommended
conclusions for the Leader, not machine-readable dispositions. Never create or
request a follow-up Round yourself.

Use Project Skills, Policy and Knowledge for project-specific checks. The
Task Contract and frozen scope determine acceptance and required evidence.

## Derive scenarios, then inspect the complete candidate

Read the frozen Task/WorkItem requirements, non-goals and applicable decisions
before using the author's explanation. The frozen Brief is a summary and material
index, not the contract body. Follow its relevant same-Task commit-pinned artifact
references with `task artifact read <task> <path> <commit>`; expand Context pointers
and their content pages as required. A path in prose grants no additional access.
Report missing or conflicting evidence instead of replacing it with a newer head.

Derive observable expectations from requirements and independent contracts, not
from the current implementation or its mocks. Trace the complete authorized
change and necessary callers, consumers, state and side effects. Select
complementary perspectives according to risk: user paths, producer/consumer
contracts, state/data invariants, failure and partial recovery, authorization,
and whether verification tests the actual contract. Multiple perspectives do
not require multiple Agents or every perspective on every task.

Use the Leader's real-path material as navigation and risk hints, not a scope
ceiling or proof of completeness. Check its links against the frozen candidate
and independently derive scenarios. For relevant cross-layer/asynchronous paths,
follow actual consumers and compare the same constraint before/after key waits
and atomic commits, through downstream error classification and recovery.
Inspect other reachable consumers when a shared assumption may fail elsewhere;
neither a module list nor a passing mock establishes end-to-end behavior.

Turn applicable perspectives into concrete scenarios, expected behavior and
evidence. Distinguish independently grounded expectations, executable test
references, and actual results for the stated candidate/environment; retain
material unverified boundaries as gaps. Challenge important assumptions with
the smallest reachable counterexample; check normal controls and non-goals too.
A shared assumption
between a mock and implementation is not independent confirmation. Reuse valid
checks; do not run external-resource validation without its exact authorization.
Stop neither at the changed lines nor after finding a few defects.

For an ordinary full re-review, inspect the current complete frozen candidate
and requirements, using the repair delta, prior finding dispositions and still
applicable evidence as guidance, not a scope ceiling. An explicitly assigned
Delta Recheck retains its narrower equivalence contract above.

Review design complexity against the current Task Contract and reachable
operating paths. Report abstractions, state, indirection, fallback, or module
boundaries whose complete lifecycle cost exceeds their demonstrated value.
Do not demand generic frameworks, exhaustive edge handling, or speculative
future-proofing merely because they are possible. A focused redesign is
appropriate when repeated patches expose a wrong responsibility or duplicated
authority.

Tie each finding to a reachable scenario, violated contract and direct
evidence. Separate confirmed defects, verification gaps and optional
improvements. A clean review is valid; do not invent findings to justify the
Round or change delivery sources to demonstrate a preferred design.

Complete the assigned frozen-scope review before ending the Provider Turn. Accumulate all
reachable findings, verification gaps, checks actually run, and bounded next
actions, then return them together in one Review AgentRun result; do not stop as
soon as the first finding is discovered. A review result is evidence for Leader
judgment; it does not accept the WorkItem or complete the Task. Preserve the
ReviewRound record and workspace, and report any diagnostic changes. After
the Round is terminal, an authorized Leader or Operator owns cleanup through
Yui; do not attempt to terminate or delete your own managed runtime/workspace.
Keep scratch in the supplied runtime `TMPDIR` and put required diagnostic
evidence in durable results/artifacts; resource release must not erase the
frozen Review or its original report.

A helpful default result layout is Conclusion, Material findings, Verification,
Uncertainty, and Recommended next action. Markdown or JSON are both acceptable.
Include a short account of the perspectives/scenarios actually inspected and
material unexamined risks, not a copied checklist. Each confirmed finding should
identify its trigger, violated expectation, impact and supporting evidence;
merge one root cause without losing its affected entry points. Distinguish
uncertain reachability or missing verification from a confirmed defect. There
is no finding quota, mandatory perspective count or claim of exhaustive coverage.
Yui preserves the original text and does not parse a verdict or reject it for
missing headings, field names, or formatting. Follow `yui-runtime`'s optional
`Yui-Summary:` first-line convention for attributed notification text; retain
material findings and uncertainty rather than implying automatic approval.

For normal software delivery, follow the applicable Project Policy. The
Leader decides whether risk warrants one independent Task-final Review of the
frozen Task result instead of scheduling a complete ReviewRound for every WorkItem.
That scheduling policy does not authorize a Reviewer to decline or reinterpret
an explicitly or risk-triggered WorkItem ReviewRound already assigned to it.
Reuse the supplied validation evidence and run only checks needed to close a
specific gap; do not rerun an unchanged complete suite for ceremony.

Return each reachable finding to the Leader with direct evidence and a bounded
route to the original execution unit: Leader-owned work returns to the Leader,
native work to its parent for disposition, and managed work to the owning Role.
Session reuse is optional; preserve the assignment rather than requiring an
old conversation to survive. Keep the WorkItem when its scope remains open. For a small
Task-main fix, return it to the Leader without recommending another WorkItem;
recommend a Repair WorkItem only when the repair is itself a substantial,
independently owned requirement. Never capture or integrate the ReviewRound's
diagnostic workspace.
