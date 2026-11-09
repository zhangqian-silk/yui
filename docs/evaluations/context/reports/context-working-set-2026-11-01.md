# Action working sets and semantic-unit reading

Historical context-evaluation report; conclusions apply only to the recorded
candidate and evidence. Not a current framework contract. [Report index](README.md).

## Scope and disposition

Base: `1a5e1e2c0dc50d687662b6688419b0f3c36de071`, clean Task main.
This is a new bounded implementation and experiment, not a continuation of the
stopped historical run loop. No historical scorer, grade, source or seal changed.
Existing roles remain disabled. No publication, global installation or shared
service change was performed.

The candidate contains:

- Runtime/Leader/Operator action-level navigation: select the known applicable
  set together, retain full original reading, use whole semantic units rather
  than serial field discovery, and reconstruct the current action after loss
  rather than restoring every previously read manual.
- A case-local review directory with exact filters, recorded timestamps,
  hashes, sizes and literal excerpts. Missing source edit times stay null;
  recorded time does not establish precedence.
- Explicit multi-document reading: 1–8 selected documents, a total UTF-16 text
  budget, per-document errors, exact pinned continuations, unmodified text and
  citation spans. A bad selection does not hide successful independent reads.
- Body responses also carry source title/time/Role/Thread/Turn, so ordinary
  source identification does not require a second directory/index read.

This changes the **review-material interface**, not the product Task-message
CLI. The underlying exact citation validator and business gates are unchanged.
The Skill entries grow by 564/323/250 bytes respectively (1,137 bytes total);
this is an action-navigation candidate, not a demonstrated static size saving.
These are current branch VERSION 31/14/16, not historical candidates with
coincidentally equal version numbers.

## New real-model reading probes

Existing authorization: Task `decision-3` and the current direct request.
Two batches, each three paired **fresh** `gpt-6-luna/medium`, read-only executions.
Each pair shares newly authored synthetic rules, originals and irrelevant
archives. No Yui CLI, Home, Controller or external business effect was exercised.
There were 12 executions in total, no retries or output repairs.

The model chooses its reading approach: baseline can already group shell reads;
candidate exposes the directory/batch entry and action-grouping guidance.
Both can read files directly. We did not force candidate API use or prohibit
baseline batching. Outputs check cohort allocations, dispatch prohibition,
unknown ETA and literal source citations. These deterministic assertions do not
replace independent semantic review or prove complete instruction reading.

The first batch was calibration. Its revision question did not explicitly name
the current request number while a correction applied only to the fourth
request. Both automated answer checks were false, but that result cannot
unambiguously establish a model failure. Original prompts, outputs and results
remain unchanged. A second, separately frozen batch explicitly identifies the
second request. Do not pool these two versions into a success rate.

### Latest frozen batch

| Scenario | A input tokens | B input tokens | Change | A/B tool calls | A/B tool-output bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| First planning request | 168,680 | 164,226 | −2.64% | 3 / 3 | 10,218 / 4,458 |
| Explicit second-request revision | 169,942 | 163,764 | −3.64% | 3 / 3 | 13,032 / 4,663 |
| Simulated fourth-request reconstruction | 169,239 | 209,433 | +23.75% | 3 / 4 | 16,286 / 8,817 |

All six native processes exited normally; six business-answer checks and six
literal-citation checks passed. These are fresh-context reconstruction probes,
**not actual native compaction or a four-Turn Operator/Leader collaboration**.
The modified product Skills were not exercised as managed live Role instructions.

Across these three cases, input is 507,861 → 537,423 (+5.82%), output tokens
2,012 → 2,223, tools 9 → 10, and visible tool-output bytes 39,536 → 17,938
(−54.63%). Smaller returned text did not produce smaller total input overall.
This sample does not establish a population benefit or causal effect.

Cache exposure is unequal: A uncached input is 9,192 / 77,526 / 11,415;
B is 74,242 / 74,292 / 76,185. Do not infer money or compute savings from the
input reductions. Native exec JSON exposes Turn usage and completed tools,
not every model request; tool count is not a model-request count.

### Fourth-request mechanism

A read `READING.md`, fetched six originals in one shell call, then fetched the
full index: three calls. B read `READING.md`, fetched the same six originals
with `--batch`, enumerated files, then fetched the original-document directory:
four calls. Thus B did use batching but added discovery after reading.
Do not infer private reasoning or that the extra discovery was unavoidable.
The other two B cases used ordinary file reads, not the batch API.

The post-probe candidate returns source metadata in body-page headers. This
addresses the missing metadata capability directly instead of adding another
mandatory discovery step. That last addition has deterministic regression
coverage but **has not been tested in another real-model batch**. No additional
samples were launched to obtain a favorable result. Keep it as a reversible
candidate; do not label the combination a validated context optimization.

## Current framework findings

1. **Skill applicability is coupled to old exact hashes.** In `common.mjs`,
   `lifecycleWorkingSet` recognizes one Runtime29/Leader13/Operator15 triple;
   `obligations.mjs` also has exact historical carrier mappings. Current valid
   Skill edits do not inherit those mappings. A new body can fall back to a
   different reference set or unknown carrier without violating its actual
   instructions. Before a full new collaboration experiment, freeze the
   applicable obligations from current originals explicitly. Do not add
   version exemptions, waive required reads or retroactively change old grades.
2. **Overall grading cannot answer the exploratory question alone.** The runner
   explicitly retains `observation-unknown` for otherwise successful observed
   chains; full `comparable()` requires stronger evidence. Use business quality,
   handling/authority, observed cost, observation coverage and infrastructure
   separately. Missing memory evidence must not masquerade as business failure,
   and incomplete chains must not masquerade as complete cost savings.
3. **One bad quote rejects an entire imported review.** `validateReview` throws
   at the first invalid criterion/citation. Strict rejection is appropriate for
   that evidence, but the interface lacks a complete per-criterion diagnostic
   result for valid siblings. A future improvement should report all defects
   without repairing quotes, accepting the invalid criterion or rerunning a
   model merely to make the importer green.
4. **Per-request cost attribution is missing from the normal report.**
   `quantifyEvents` reports Turn cumulative differences and the last request,
   not all observed request-level context sizes around compaction. Investigation
   still requires separate raw-trace work. Add bounded observed samples/counts
   with explicit missing coverage, not guessed requests from tool count.
5. **Reading navigation was itself an experimental confound.** Whole indexes,
   field-level pagination and source confirmation can increase calls even when
   text shrinks. The new reader addresses this, but the latest probes show that
   API availability is not adoption and batching alone is insufficient.
6. **Scenario applicability needs preflight clarity.** The new probe's initial
   revision ambiguity illustrates why the current request/stage and effective
   source versions must be explicit before model startup. This is a fixture
   correctness check, not permission to constrain the model to an expected answer.

None of these findings justifies rewriting historical results or expanding the
framework into another workflow/policy engine. The next meaningful validation
is a current frozen whole-action comparison, with valid input timing and
request-level accounting, rather than repeated old experiments until a pass.

## Evidence and checks

Local retained evidence, intentionally excluded from source commits:

- `output/action-working-set-probe-20261101/`: first frozen prompts/cases,
  launch/transport/terminal-derived results, archives, cleanup and seal.
- `output/action-working-set-probe-v2-20261101/`: latest batch, also including
  its runner source. Each case's `result.json` and `case.json` link original
  output, native Thread and exact materials. No private transport is published.
- Baseline reader SHA256:
  `e8c7c28256b084684d17566ff071d3657a7170706cbbba26492cb537c079d1bc`.
- Latest measured reader SHA256:
  `896f0595f1082135e2709fdc5adc94b6ea6aff583aeab239f64f35cc8dd6234d`.
- Post-probe reader SHA256 (source metadata addition):
  `d0b356e896d439f60b58829022c6f43c213c510ede09613efbc9b5250f236a00`.

Validation: `npm test` 997 passed, 8 skipped, 0 failed; `npm run eval:check`
95 passed; focused collaboration-history tests 6 passed; all three Skill format
checks passed; assembled-package compatibility smoke passed and released its
fixture. New regressions cover budgets, Unicode continuation, sealed-source
changes, filtered directory continuation, per-item failures and case-local CLI.

All 12 synthetic case directories were checked against their frozen hashes and
removed only after normal process exit and archive preservation. They can be
recovered from the retained per-case archives. No old unknown resource was
touched. Self-review and tests are not independent code/semantic acceptance.
