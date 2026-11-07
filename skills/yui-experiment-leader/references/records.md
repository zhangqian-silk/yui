# Experimental record contract

Use the intended CLI/Home and current Task identity. These operations only
record knowledge; they do not run experiments or authorize resources.

## Shapes

Every record has `schemaVersion: 1`, `kind` and `id`. IDs use 1–96 ASCII letters,
digits, underscores or hyphens, starting with a letter or digit. Supply all
required fields below and no undeclared top-level fields.

| kind | Required fields beyond schemaVersion/kind/id | Optional fields |
| --- | --- | --- |
| `direction` | `title`, `problem`, `goal`, `metrics`, `constraints`, `priority`, `status`, `next`, `unresolved` | `currentExperiment`, `currentConclusion` |
| `plan` | `title`, `method`, `parameters`, `document` | `source` |
| `experiment` | `title`, `directions`, `hypothesis`, `plan`, `parameters`, `baseline`, `candidate`, `conditions` | `revises`, `workItemIds` |
| `execution` | `experiment`, `sample`, `conditions`, `observations`, `evidence`, `outcome`, `limitations` | `runId`, `jobRunId`, `retryOf` |
| `analysis` | `title`, `inputs`, `method`, `conclusion`, `limitations`, `evidence`, `relations`, `document` | `decisionId` |

- `parameters`, `conditions`, `observations`: JSON objects. Use domain-specific
  keys for actual data, not invented top-level record fields.
- `metrics`, `constraints`, `unresolved`, `directions`, `workItemIds`, `evidence`,
  `limitations`: arrays of nonempty strings (at most 100). Empty arrays are
  allowed except `directions`, which contains unique existing direction IDs.
- Other ordinary text fields are nonempty strings, including plan `method` and
  `document`. An analysis's `method` is instead a fixed plan reference.
- Direction `priority`: `low` / `medium` / `high`; `status`:
  `active` / `paused` / `closed` / `abandoned`.
- Execution `outcome`: `observed` / `failed` / `unknown`. Failed attempts are
  evidence, not zero measurements or automatic retry instructions.
- `inputs`: 1–100 fixed execution references. `relations`: zero to 100 objects
  `{relation: "supports" | "refutes" | "supersedes", report: ANALYSIS_REF}`.
- A fixed reference is `{taskId, kind, id, commit}` with the full artifact Git
  commit, not a source-code commit or current HEAD substituted for a saved ref.
  Use the corresponding kind: experiment `plan`, analysis `method` and plan
  `source` reference plans; execution `experiment` and direction
  `currentExperiment` reference experiments; direction `currentConclusion`
  and relation `report` reference analyses. `revises` references an experiment;
  `retryOf` references an execution of the exact same experiment revision.
- `baseline` and `candidate` are code conditions:
  `{repository: STRING, commit: FULL_CODE_COMMIT_OR_"unknown",
  tree: "clean" | "dirty" | "unknown", diff?: STRING}`.
  Dirty code requires a diff evidence reference. Do not invent code identities.
- Experiment `parameters` explicitly expands every parameter in its fixed
  plan. Record actual dataset/tool/model/build conditions and intentional
  overrides in `conditions`; never credentials.

Text fields are at most 32 KiB, a direction at most 32 KiB, other records at
most 64 KiB. Reference larger retained evidence. References must resolve; local
dependencies belong to this Task. Cross-Task plan reuse uses the explicit
`source` import described in the Skill, not a foreign experiment dependency.

## Save and verify

Read `yui task iteration overview <task> --json`. If its `commit` is null,
`yui task iteration init <task> --json` creates the initial artifact HEAD.
Build a record from authorized facts and save it:

```sh
yui task iteration save <task> '<record-json>' --request-id <stable-id> --expected-head <full-artifact-head> --json
yui task iteration read <task> '<fixed-reference-json>' --json
```

JSON CLI output is inside `data`. Save returns `{ref, commit}`; retain the exact
`ref` for dependent records and `commit` for the next save's `--expected-head`.
Read returns `{ref, value}`. Overview returns current `commit` and directions.
The successful save's `commit` already supplies the next expected HEAD; a
separate overview solely to rediscover it is unnecessary. Refresh on a conflict,
uncertain effect or when current direction selection is needed.
Use ordinary JSON serialization for shell arguments; do not discover schemas
by trial writes. Save dependencies before dependent records. Reconcile a HEAD
conflict from current facts. After an uncertain save, retain the exact request
identity and inspect its effect/receipt rather than issuing a different write.
Uncommitted files are not effective knowledge; preserve and inspect them rather
than overwriting them to force a save.

Plans, experiments, executions and analyses have immutable IDs. A revision or
reanalysis gets a new ID; preserve previous records and failed evidence.
Directions are explicitly updated with their full record. Saving an analysis
or linking it as superseding another report does not select it: update the
direction's `currentConclusion` explicitly, retaining its other intended fields.
A selected conclusion needs at least one input from an experiment in that
direction. Its fixed inputs may compare multiple experiments; selection of
`currentExperiment` does not silently rewrite or narrow the analysis inputs.
Read back fixed evidence and overview; newest commit is not current conclusion.

## Read the needed evidence together

Once exact references are known, group independent `iteration read` commands
in one shell/tool call when their complete combined outputs fit its budget.
For example, a saved plan, experiment and executions can be verified together;
do not take a separate model turn for each small known record. Inspect every
result and recover failures or truncation before using the evidence. Split large
groups; do not replace bodies with summaries to fit.

Reuse an already-read immutable reference only while its complete value remains
available in the same context. New turns alone do not require rereading it.
After context loss or uncertainty, read the exact references again. Fresh Task
intent, pending originals and mutable direction selection still need current
reads; a fixed old direction is not evidence of today's selection. Honor
explicit requests for independent rereads and before/after verification.

Group reads, not dependent writes: each save consumes the preceding successful
HEAD and may create a reference needed next. Stop at that dependency. Keep
unknown effects fenced and retain exact request identities; never hide failure
with a blind write loop, parallel saves or a guessed commit.
