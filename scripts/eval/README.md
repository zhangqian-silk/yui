# Evaluation tooling

Start with the evaluation question, not a universal runner. This tree separates
reusable mechanics from provider contracts and topic-specific interpretation.
See [evaluation documentation](../../docs/evaluations/README.md) for methodology
and dated reports. Nothing here authorizes real-model or production execution.

```text
core/                  Byte hashing, JSONL framing, safe read-only evidence access
adapters/codex/         Codex cumulative usage observations; not a universal tokenizer
context/               Context evaluation runner, Yui fixtures, measurements and review
  support/             Yui/Operator/Leader-specific supporting observation contracts
review/                Code-review material evaluation and deterministic corpus probes
```

## Dependency and interpretation boundaries

- `core/` has no provider, Yui, topic, quality rubric or adoption assumptions.
  `openEvidence` opens a directory/archive; it does not assert that its contents
  satisfy a particular run schema. The context topic's `readSavedInvocation`
  checks its own plan, preflight, ledger and seal.
- `adapters/` interprets a named provider's protocol. Codex usage snapshots are
  cumulative per Thread; cached/reasoning counts are subsets. Missing observations
  stay unknown. Callers establish ownership and select the relevant Thread/window
  before measurement; an adapter does not prove quality or causal savings.
- Topic directories can import core and matching adapters, not each other's
  fixtures or rubrics. The context topic still owns Yui Role/Skill obligations,
  native ownership checks and four-stage business scenarios. These are **not**
  prerequisites for evaluating memory or a different Agent.
- Engineering collects facts and statistics; the analyzing Agent interprets
  actual trajectories, comparable conditions, quality and tradeoffs. A successful
  script or well-formed review is not an adoption decision.

## Current entries

| Topic/action | Entry |
| --- | --- |
| Context execution | `npm run eval:context -- ...` — [contract](context/README.md) |
| Existing sealed context-run analysis | `npm run eval:context:analyze -- <saved-A> [saved-B]` |
| Isolated fake context wiring | `npm run eval:context:wiring -- ...` — opt-in, no model |
| Review-material evaluation | `npm run eval:review -- verify\|export\|plan\|score ...` — [contract](../../docs/testing/review-evaluation.md) |
| Maintained context observation checks | `npm run eval:check` — no Home/model |
| Shared/history and review-material regressions | `npm test` — repository build-and-test gate |

Historical production-rollout cost analysis remains a separate, restricted
[read-only tool](../context-cost/README.md). It reads explicitly selected local
Codex rollout roots and continuations, not app-server context-run seals. It
does not launch Subjects/reviewers or supply a universal online importer.
Retain that directory when delivering this optional analysis entry; its native
usage/window semantics must not be silently pooled with context-run totals.

The old `scripts/collaboration-eval/framework/` and `scripts/review-eval/` entries
have moved here. There are no forwarding wrappers. The old `eval:collaboration`,
`eval:analyze`, `eval:wiring` command names are replaced by the context entries
above. Archived plans, source paths and seals are unchanged: interpret them
against their recorded commit, not today's layout. New run identities include
their shared execution dependencies; analysis provenance includes shared readers.

## Adding memory or self-developed Agent evaluations

Add a topic only when implementing its actual question and data contract:
`scripts/eval/memory/` or `scripts/eval/agent/`, with a corresponding
`docs/evaluations/<topic>/README.md` and `reports/` directory. These are examples,
not pre-created empty implementations.

A memory evaluation defines its own memory write/read, retention, correction,
retrieval and cross-session evidence. It must not infer remembering or forgetting
from token counts or compression alone. A self-developed Agent evaluation defines
its own task outputs, tool/effect boundaries, execution identities and observations;
it need not emit Codex events or use Yui Roles.

Reuse byte/evidence utilities where useful. Add a provider adapter only for a
real protocol, retaining native units and missing-data limits instead of inventing
equivalent Codex tokens. Keep topic fixtures, schemas, judgments and cost/quality
questions inside that topic. Extract more shared code only when a second concrete
consumer demonstrates the same contract; no plugin registry, universal score or
automatic experiment scheduler is required.

The remaining `scripts/collaboration-eval/` research scripts and frozen attachments
are not dependencies of these maintained entries. They are not a fallback runner
for new topics, and should not be included when delivering this tooling.
