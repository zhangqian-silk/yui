# Task usage and cost evidence

`yui task usage <task> --json` reads a compact, read-only Task-lifetime summary.
`--limit 20 --offset 0` explicitly reads a page of Session and cost evidence;
follow `details.nextOffset` for another page. Web uses the same facts and
projection, with evidence loaded only when its usage disclosure is opened.
The authenticated read endpoint is `GET /api/tasks/<task>/usage`.
The CLI summary and details span all Task Roles, so they are available only to
the human caller, Operator or matching Task Leader, not a Worker/Reviewer
Assignment.

The query reads at most 2,000 retained runtime/lifecycle observations and 2,000
compact Run identities, never Run report bodies or transcripts. Above either
limit it marks consumption as partial (`usage-history-limited`); it does not
silently call the retained subtotal a lifetime total. Detail pages contain at
most 50 entries per evidence family. Pages are current reads, not frozen audit
snapshots; refresh the summary when new observations arrive.
Web retains already-read pages across Context redraws and labels each page's
observation time. Reselect the Task to start a fresh detail read.

`known` means known within the declared observed sources, not billing
completeness. Missing values are `null`, not zero. Tool and native-turn history
may be compacted and remains partial. Task elapsed time and summed native
execution intervals are not billable durations.
Partial or unavailable source coverage makes monetary subtotals partial even
when that boundary carries no amount; known receipts remain visible.

## Monetary observations

Drivers may emit `activity.observed` with `payload.cost` through the existing
canonical observation boundary:

```json
{
  "activity": "model",
  "activityId": "stable-provider-request-id",
  "cost": {
    "kind": "actual",
    "semantics": "request",
    "amount": 0.25,
    "currency": "USD",
    "source": "provider receipt identifier"
  }
}
```

This is independent of token observations; reporting an amount never fabricates
token counts. Request revisions replace the same request, and replay does not
add another charge. Cumulative Session amounts exclude the first nonzero
baseline; a single nonzero snapshot cannot establish consumption. Rollbacks,
mixed meanings, overlapping sources, and ambiguous Session ownership remain
unknown. Cumulative Session costs are not allocated to WorkItems.

For `kind: "estimated"`, `basis` is required with `model`, `source` (the price
reference), `version` (a version or effective date), `scope`, and `excluded`
(an explicit list, possibly empty). Separate price bases are retained in the
details. Estimated and actual amounts are never summed together. Currencies
are kept separate; no exchange-rate lookup or conversion occurs.

There is no built-in price catalog or automatic fee inference. Existing
providers that emit only tokens continue to show unknown costs. Only monetary
facts actually supplied through a Driver are reported; a model name, elapsed
time, subscription, or token subtotal is not a price source. No paid Provider
request is made to fill a missing price. These records are evidence, not a
payment ledger or budget gate.

Storage 1.5 → 1.6 declares the optional cost payload using the central minor
upgrade chain. Valid prior observations are unchanged, with unknown costs;
the physical SQL layout and package version do not change.
