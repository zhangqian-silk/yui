# Context navigation and observable usage

Historical context-evaluation report; conclusions apply only to the recorded
candidate and evidence. Not a current framework contract. [Report index](README.md).

Base: `4b63ab6263c4c45f5ed7c309a22f9526b4dcd7c0`.
This iteration changes review-material navigation and supplemental evaluation
reports. It does not change product Skills, business gates, old grades/seals,
shared services or the stopped managed roles.

## Retained implementation

- `history-quant/2` exposes each Turn's observed cumulative usage increments,
  reported last-request usage, repeated-total count and input range. Details
  retain at most the first/last 32 unique updates; aggregates cover all unique
  updates. Summary reports point to that detail.
- Missing baselines, decreasing counters and missing fields remain unknown.
  An increment different from reported last input exposes a coverage gap or
  non-one-to-one update relationship. Matching values do not prove completeness.
  Neither tools nor usage updates are advertised as provider request counts.
  This makes investigation easier; it does not infer text-level attribution,
  actual compaction, hidden requests or billing.
- `readable-trajectory/3` keeps the complete directory and source order. It
  factors consecutive identical Role/Thread/Turn metadata into a shared heading,
  retaining every document ID, title and size. It uses the old flat rendering
  when grouping would cost more bytes. Each body still carries its own identity.
  This does not add a memory receipt or require a directory lookup.

Synthetic repeated-source directories of 6/30/120 documents measured
932→497B, 4,236→1,713B and 16,696→6,343B respectively. These are directory-only
static measurements with UUID-length source identities, not session savings.
The complete guide adds a short explanation of the shared heading.

## New experiments and the rejected intermediate design

Authorized resource: existing Task decision-3, `gpt-6-luna/medium`, fresh
read-only native executions. Eight processes completed normally, without
retrying or repairing outputs. They use synthetic planning originals, not the
production Home, real business effects or actual native compaction.

First we tested a bounded directory window (12 main, 8 appendix entries).
Both arms had batching and body source metadata. All answers and literal
citations passed, but the window did not reliably reduce discovery:

| Scenario | A/B cumulative input | Change | A/B tool calls |
| --- | ---: | ---: | ---: |
| First request | 123,490 / 228,269 | +84.85% | 2 / 4 |
| Second-request revision | 206,171 / 166,819 | −19.09% | 4 / 3 |
| Simulated fourth-request reconstruction | 172,392 / 256,643 | +48.87% | 3 / 5 |

The first-request B read the whole index/seal, reader source and then catalog.
This is observable extra discovery, not proof of the model's internal reason
or causality. The bounded-directory change was removed, not accepted or tuned
by retrying the same condition until success. Its original evidence is retained.

We then froze a distinct complete, grouped-directory comparison, focused on
the fourth-request reconstruction. Both arms could use the same batching and
catalog interface, with identical business originals and common guidance:

| Metric | Flat complete A | Grouped complete B |
| --- | ---: | ---: |
| Entry guide UTF-8 bytes | 3,849 | 2,863 |
| Cumulative input tokens | 223,236 | 167,444 |
| Output tokens | 907 | 794 |
| Cached input tokens | 209,408 | 158,720 |
| Tool calls | 4 | 3 |
| Tool-output bytes | 23,020 | 9,626 |
| Wall time | 36.523s | 32.718s |

Both answers and literal citations passed. A fetched the whole index in
addition to its guide; both fetched six originals together and subsequently
queried the catalog. Thus the extra post-read catalog call remains unresolved.
The −24.99% input result is a single positive signal, not demonstrated majority
benefit, causal savings or independent semantic acceptance. Cache exposure
differs. These two experiment versions must not be pooled.

The frozen experimental guides are controlled synthetic representations of
the directory designs, not the full production review export. The second
probe calls the actual retained `directoryLines` implementation. Neither probe
establishes managed Operator/Leader behavior or a complete four-Turn chain.
Native `exec --json` exposes Turn totals, not the app-server usage-update stream:
the new usage profile has deterministic regression coverage, not per-request
coverage from these experiments.

## Verification and evidence

- Final `npm test`: 998 passed, 8 skipped, 0 failed (test phase 27.056s).
- Final `npm run eval:check`: 95 passed, 0 failed (1.175s).
- Focused history tests: 7 passed, including usage gaps/deduplication/bounds,
  complete source discovery, exact originals and source-order preservation.
- Self-review completed; no independent code or semantic acceptance claimed.
- No packaged runtime/Skill change, so no redundant package smoke was added.

Local restricted evidence (not source-published):
`output/action-working-set-probe-v3-20261102/` and
`output/action-working-set-probe-v4-20261102/` contain frozen runner, prompts,
cases, native results, archives, cleanup receipts and seals. The latter also
preserves the exact directory function. Eight exact case directories were
verified unchanged and archived before removal after normal native exit.
No Home/Controller was started and no old unknown resource was touched.

Remaining framework issues are separate: historical exact-hash Skill obligation
mapping, fail-fast rather than per-criterion review diagnostics, and native
request/compaction observation coverage. None was waived or claimed fixed.
Next work should address those concrete interfaces without weakening quality
checks or restoring the old automatic experiment loop.
