<p align="right"><strong>English</strong> | <a href="./review-evaluation.zh-CN.md">简体中文</a></p>

# First-round review: materials and offline evaluation

The default is one Reviewer using risk-appropriate perspectives, not a fixed
number of Agents or findings. Leader judgment still owns acceptance. Generic
methods live in `skills/yui-reviewer` and `skills/yui-leader`; project commands
and architecture rules remain in Project Skills/Policy.

## Material handoff

Use existing requirements, decisions and verification results. A complex change
may benefit from a short Task artifact index:

- Goal/non-goals and effective decision references.
- Observable scenarios, expected behavior and independent contract sources.
- For cross-layer/async risks, a short actual path: entry, consumers, relevant
  waits/atomic commits, result and failure/recovery consequences, linked to
  candidate code or existing documentation.
- Candidate identity and actual check results (commit, environment, command,
  result), distinguishing unexecuted scenarios and uncovered boundaries.
- For full re-review: repair delta, previous findings' dispositions and still
  applicable evidence. The complete current frozen candidate remains in scope.

Save the index with `task artifact save`, then place its returned
`git:<commit>:<relativePath>` in Brief. New Review snapshots include the Brief
and active decisions. Read relevant bodies using the exact `store/refId` from
the Context inventory, following content pagination. A same-Task artifact is
read at its pinned commit with `task artifact read <task> <path> <commit>`.
Later Brief/decision edits do not change an existing Review snapshot. This is
not a document-completeness gate, prose parser or Skill-version freeze.
Ordinary full review and the existing equivalence Delta Recheck remain distinct.

### Keep the material small and actionable

These are examples, not mandatory sections or a scenario quota. A simple E01
handoff can cite its half-open interval contract and `main.mjs/select` directly:
the caller supplies bounds and receives rows; timezone conversion is a non-goal.
No separate path document is needed.

For E03, the contract requires unchanged opaque cursors and ordered items.
The actual path is caller -> `main.mjs/collect` -> await
`page.mjs/fetchPage(cursor)` -> consume items/cursor -> next request or return.
There is no persistent commit. Check the cursor at the downstream consumer,
not merely the first successful page; a rejected request rejects collection,
so accumulated rows are not returned as success. Retry/concurrent mutation is
outside this example's contract. The index is a navigation hint, not a finding
or a claim that all paths were inspected.

Keep evidence roles separate: that contract is the expectation;
`scripts/review-eval/verify.mjs`'s E03 probes are executable references;
only an actual `node scripts/review-eval/evaluate.mjs verify` invocation plus its
candidate commit, environment and output establishes a result. The probes use
the two supplied modules for the counterexample, a one-page normal control,
and a controlled wait followed by rejection to check pending/failure behavior.
They do not exercise a live server, crash recovery or Reviewer behavior.

In a pause/resume task, constraints might instead distinguish unsubmitted
intent, registered/unknown effects, terminal settlement and legal resumption.
Those are domain-specific examples, not universal state-machine requirements.
Use the task's own contract and reachable paths. After a shared-root finding,
check the other affected consumers in the same scope and refresh the small
index and repair evidence; do not append the entire review history. Reviewer
inspection still covers the complete frozen candidate, not just these hints.

## Small development corpus

`scripts/review-eval/` is an offline file tool, not a scheduler, model adapter or
new Core store. It never calls a provider. No historical Task cases or results
are inputs. All eight examples are newly constructed from explicit contracts.

| Cases | Capability | Shape |
| --- | --- | --- |
| E01 | Half-open interval behavior | Introductory single root |
| E02 | Persistence failure and repeat identity | Two independent roots in one complete candidate |
| E03 | Producer/consumer opaque-cursor contract | Two modules |
| E04–E06 | Lifecycle, partial-result correspondence, authorization effects | Intermediate state/contract cases |
| E07–E08 | Distinguishing permitted behavior from defects | LRU and progressive-display controls |

Every package supplies a complete candidate, not a historical patch; there is no
required repository baseline. Requirements define inputs, non-goals and effects.
The scorer catalogue holds root/trigger/violation/impact and repair controls.
`verify.mjs` probes observable behavior against independent literal expectations,
checks seven target roots, passing repairs and normal controls. It does not
prove exhaustive correctness, independent authorship verification or Agent
effectiveness. Additional valid findings require adjudication.

```sh
node scripts/review-eval/evaluate.mjs verify
node scripts/review-eval/evaluate.mjs export E03 basic /absolute/new-participant-directory
```

Export uses an explicit projection of candidate source and requirements; indexed
materials add only a navigation index. Both have identical necessary contracts
and source. Exports contain no gold, repair, scorer code, family labels or Git
history. Existing destinations are refused. A failed export may leave a partial
directory: inspect it, do not use it as a complete participant package.

Export is NOT a filesystem sandbox. A participant with access to this repository,
the scorer directory, prior sessions or the network can obtain answers.
Only claim blind evaluation after a separately provisioned isolated environment
denies those paths/tools, with access probes and exact evidence. Never use a
“do not read answers” instruction as isolation.

These are public development cases. Unknown holdouts must be separately authored
after the method/protocol is fixed, with independent contract checking and a
family-level overlap audit. Renamed, repaired or near-variant development cases
cannot become holdouts. Keep holdout source, labels and adjudication outside
participant access and method-tuning conversations. This tool deliberately
does not fabricate a holdout or claim one has been evaluated.

## Freeze a comparison before running it

```sh
node scripts/review-eval/evaluate.mjs plan protocol.json
node scripts/review-eval/evaluate.mjs score plan.json records.json
```

Capture stdout as separate files using your normal artifact workflow. The
protocol is a JSON object with nonempty `model`, `effort`, `tools`, `environment`,
`budget`, `seed`; positive `repeats`; and `baseline`/`improved` maps of relative
Skill paths to exact UTF-8 contents, including their VERSION and required
references. Load these only in isolated evaluation configuration, not global
installation. This file is scorer-side; it contains both methods.

The plan assigns A=baseline/basic, B=improved/basic, C=baseline/indexed,
D=improved/indexed. It fixes corpus/config/source/material/Skill digests and run
IDs, seed-orders case/repeat blocks and balances group position by Latin rotation.
Three repeats over eight development cases means 96 runs, not an authorization
or statistical-power claim. Do not change models, budgets or tools between groups.
An extra independent-Reviewer comparison is a separate experiment with all
producer and synthesis costs, optionally with matched total budgets.

There is no live execution or automatic retry command. Actual runs require
explicit resource/effect authorization, fresh participant sessions and verified
isolation. Preserve exact inputs, actually loaded Skills/configuration, raw
outputs and execution/tool evidence. Do not infer a successful run from dispatch.
Predeclare any retry protocol separately, retain original failures and every
attempt's costs; do not replace a failed planned record with a successful retry
in the primary analysis. This minimal tool reports one attempt per planned run.

## Adjudicate before aggregation

`records.json` is an array. Each supplied record contains its planned `id`,
`planDigest`, observed `candidateDigest`, `materialDigest`, `skillDigest`, `configDigest`, and
`status` (`completed`, `timeout`, `infra-failed`, `not-run`). Executed records
also contain `evidenceRef` and `rawOutput`; incomplete records require `reason`.
Identity digests are evidence supplied by the execution recorder, not attestation
by this offline tool. Preserve the actual model/tool/environment configuration
in that evidence and exclude protocol deviations rather than relabeling them.
`configDigest` hashes the JSON object containing `model`, `effort`, `tools`,
`environment`, `budget` in that order. Other digests use the exported `digest`
helper (SHA-256 of `JSON.stringify(value)`). Reports bind the complete supplied
record array with `recordsDigest`; retain that file alongside the plan/report.

Completed records require `findings` (empty is valid). Each finding contains
`id`, original `claim`, and `verdict`: `valid`, `invalid`, `pending`, `gap` or
`suggestion`. Valid/invalid adjudications also require `root`, `reason` and
`evidence`. Match meaning, triggers, violated constraints and impact, not wording
or line numbers. Use the catalogue root ID only after checking evidence.
Unlisted valid roots use `novel:<stable-key>` after separate verification;
never automatically label them false positives. Keep disputes pending.
Use a scorer who does not see group labels when practical; disclose if author,
checker and scorer are the same person/Agent.

Optional `coverage` entries contain `perspective`, `scenario`, `expected` and
`evidence`, using the case's applicable perspectives. These remain claims to
inspect, not automatic proof. Optional `metrics` contains nonnegative `wallMs`,
`agentCalls`, `toolCalls`, `inputTokens`, `outputTokens`, `contextBytes`, `cost`
(one predeclared currency). Missing values remain missing, never estimated.

The report includes per-case repeated recalls, macro/micro known-root recall,
adjudicated unique-root precision, false positives and control false-positive
rate, duplicate/novel/pending counts, planned completion and discovery yield,
cost availability and Skill/material/interaction contrasts. Zero denominators
are null. Partial outputs are retained in originals but excluded from completed
first-round metrics. Missing planned runs remain `not-run`; they are not clean
reviews. Failed-run costs still count. Completed-only contrasts can be biased:
inspect failures, denominators and per-case variation before interpretation.
If gold changes, preserve the old plan and rescore every group under the same
new adjudication version, reporting both results. No automatic acceptance
threshold or generalization claim follows from this small synthetic corpus.
