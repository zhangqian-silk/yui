# Long-running experimental Tasks

Create an explicit experiment mode, independently of the project-defined type:

```sh
yui task create "Reduce latency without losing quality" --mode experiment --type feature
yui task iteration init task-1 --json
yui task iteration overview task-1 --json
```

Creation still produces a Draft. Submit discussion/development intent through
the normal Task entry; this mode never starts a measurement or grants access to
models, quota or shared resources. Existing Tasks remain ordinary and are not
automatically converted.

## One Leader, ordinary Task configuration

The logical Role remains `leader`. Experiment mode uses the same creation path
as an ordinary Task Leader: copy the global configuration once, then maintain
Task Agent/model/effort, permissions, profile and draft/develop settings independently.
Later global template changes do not rewrite existing Task settings. The only
additions are experiment responsibilities, the experimental Skill and knowledge
capabilities. There is no experimental configuration overlay or execution engine.

Skills remain references to current shared files in the installation/Home.
The experimental entry reuses the ordinary Leader operation manuals; configured
custom Skills are copied as references, not duplicated bodies. Both modes use
the same version checks and reload changed Skills. Changing a global Role's
attached Skill list is a template configuration change, not a shared Skill file
update; it does not retroactively replace existing Task/Session lists.

### Task-local launch settings

```sh
# Bind/select the default Agent exactly as for ordinary Task Leaders.
yui task role bind <task> leader codex
yui task role update <task> leader --agent codex --model <model> --effort medium
yui task role update <task> leader --stage draft --model <planning-model>
yui task role show <task> leader --json
yui task role session inspect <task> leader --json

# Clear a binding field, or a stage field/whole stage.
yui task role update <task> leader --clear-model
yui task role update <task> leader --stage draft --clear-effort
yui task role update <task> leader --stage draft --clear-agent
yui task role update <task> leader --stage draft --clear-agent-config
# Reset the selected binding's config; other bindings/stages are unaffected.
yui task role update <task> leader --clear-agent-config
```

`codex` is an example registered Agent id. Without `--stage`, `role update --agent`
targets a binding; `role bind` selects the default Agent. Stage Agent overrides
win over the Task default Agent; stage model/effort win over the selected Task
binding. Clearing stage fields falls back to that Task's binding, never today's
global template. Stage fields retain ordinary Leader semantics when changing
Agent; provider capability validation applies before saving.

Session inspection separates desired settings from the immutable effective
launch snapshot. Changes apply at the ordinary next-launch boundary; a live
Session keeps its existing Agent/model/effort. No implicit stop, replacement or
input replay occurs, and existing lifecycle guards still apply. Adopt settings
through the authorized `yui task role session new <task> leader --reason
"Adopt launch configuration"` path after settling active work.

Storage **1.32 → 1.33** snapshots each old inherited experiment binding using
the global configuration effective at upgrade time. Original creation-time
values were not stored and cannot be reconstructed. Ordinary Roles and historical
Sessions/Runs remain unchanged. Use the normal Home upgrade path with a backup;
do not edit stored Role records manually.

Help, completion and discovery share the specialized view. Knowing a command
does not authorize it: execution checks the current Session and Task binding.
Ordinary Leaders cannot manage experiments through a forged type label.

## File knowledge

All records use `schemaVersion: 1`, `kind` and a stable `id`. They live in the
Task's existing local Git artifact repository, with no new database tables.

| kind | Required content |
| --- | --- |
| `direction` | `title`, `problem`, `goal`, `metrics`, `constraints`, `priority` (low/medium/high), `status` (active/paused/closed/abandoned), `next`, `unresolved` |
| `plan` | `title`, `method`, expanded-default `parameters` object, `document` |
| `experiment` | `title`, `directions` IDs, `hypothesis`, fixed `plan`, expanded `parameters`, `baseline`, `candidate`, `conditions` |
| `execution` | fixed `experiment`, distinct `sample`, actual `conditions`, `observations`, `evidence`, collection `outcome` (observed/failed/unknown), `limitations` |
| `analysis` | `title`, fixed execution `inputs`, fixed plan `method`, `conclusion`, `limitations`, `evidence`, `relations`, `document` |

Before constructing records, use the installed
[record contract](../skills/yui-experiment-leader/references/records.md) for
field types, optional fields, bounds and dependency ordering. The Experiment
Leader loads it before writes; command help alone is not the JSON schema.

A fixed reference is `{taskId, kind, id, commit}` with a full artifact commit.
A code condition is `{repository, commit, tree}`; commit may explicitly be
`unknown`, tree is clean/dirty/unknown, and dirty requires a `diff` evidence
reference. Record dataset/version, tool/model settings, build/dependency identity
and any intentional overrides in `conditions`. Never store credentials.

Save one record with a retained request ID and the HEAD from the current read:

```sh
yui task iteration save task-1 '{"schemaVersion":1,"kind":"direction","id":"latency","title":"Latency","problem":"Slow answers","goal":"Reduce p95 with unchanged quality","metrics":["p95","quality"],"constraints":["No paid experiments authorized"],"priority":"high","status":"active","next":"Design paired measurement","unresolved":["Choose dataset"]}' --request-id direction-latency --expected-head FULL_HEAD --json
```

The detail, request receipt and affected current index commit atomically.
The successful save returns `{ref, commit}` (inside `data` for `--json`);
retain its exact `ref` for dependent records and its `commit` as the next
save's `--expected-head`. An exact read returns `{ref, value}`. A fresh
overview returns `commit` and the currently selected directions. These are
artifact commits, not source-code commits.
Conflicts do not overwrite another save. Repeating the exact request returns
its original committed result; different input under the same ID is rejected.
Uncommitted iteration changes are preserved and require inspection, not blind
replay. Manual files undergo the same shape/reference validation before use.

Plans, experiments, executions and analyses are immutable identities. A plan
revision gets a new ID. A changed candidate/condition creates a new experiment,
optionally with `revises`; repeated measurement creates another execution,
optionally with `retryOf`. Provider retries do not automatically become samples.
Execution `runId` / `jobRunId` links existing runtime facts; `outcome` describes
data collection, not a second Run status.

An analysis may link reports using
`relations: [{relation: "supports" | "refutes" | "supersedes", report: REF}]`
and refer to an existing `decisionId`. Adoption remains a Decision. Review,
integration, PR and publication remain their existing authorities.

Update a direction with `currentExperiment` and/or `currentConclusion` to select
the current evidence explicitly. New reports do not automatically replace a
conclusion. Closed/abandoned directions can be reopened by changing their status;
Git history keeps prior selections. Stage publication does not complete the Task.

## Read, compare and delegate

```sh
yui task iteration read task-1 'REFERENCE_JSON' --json
yui task iteration compare task-1 'LEFT_REFERENCE_JSON' 'RIGHT_REFERENCE_JSON' --json
```

Comparison reports field differences; the Agent decides comparability and
benefit. Task context points to the live bounded direction index; read it
independently of the database event cursor. The Task overview displays goals,
current experiments/conclusions, next actions and blockers. Follow exact links
to methods, measurement evidence and older reports. History is not expanded
automatically, and Task constraints/open inputs are never replaced by this view.
Overview pages contain at most eight directions and 60 KiB of direction data.
Pass the returned `nextCursor` as `--cursor` to continue the same fixed snapshot;
reload without it to observe a new HEAD. The index supports up to 10,000
retained directions; exceeding that limit is rejected before saving.
Typed reads validate the selected record's direct local references; overview
also checks that current experiments and conclusion inputs belong to the selected
direction. Missing or malformed referenced records cannot become current
knowledge through manual artifact edits. Raw artifacts remain readable for
diagnosis, without recursively expanding the entire history. Retry references
compare Task/kind/id/commit values, independent of JSON property order.

To delegate measurement, include existing `workItemIds` on the immutable
experiment. A current execution Worker supplies `--experiment REFERENCE_JSON`;
it can read that experiment, its plan and measurements, and submit only an
execution linked to its exact current Run. It cannot update direction focus,
author a plan or adopt a conclusion. An unrelated Assignment is rejected.

For cross-Task reuse, explicitly save a local plan with a fixed `source` plan
reference. For project-wide reuse, use the existing Project Knowledge
proposal/acceptance workflow, preserving the self-contained method and fixed
source. Neither operation imports the source Task's resource authorization.

Retain useful conclusions, limitations, important failures/no-gain results,
key data and code/method provenance. This feature adds no permanent-log archive
or cleanup worker. Existing resource cleanup rules apply; retained references
must not be left dangling.
