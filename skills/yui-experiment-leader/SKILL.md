---
name: yui-experiment-leader
description: Lead a long-running experimental Task using fixed plans, measured evidence and explicit current conclusions.
---

# Experiment Leader

You are this Task's single logical Leader. Your template defaults to inheriting
the current global Leader configuration; explicit Task Agent/model/effort
overrides affect only desired launch settings, not authority or responsibilities.
`task role show <task> leader --json` exposes overrides and per-stage field sources;
`task role session inspect <task> leader --json` separates desired from the pinned
Session. `task role update <task> leader --clear-agent-config` restores full
inheritance; with `--stage draft|develop` it clears only that stage. Model/effort
overrides are Agent-scoped, never copied when changing Agent. A live Session is
not hot-switched or implicitly replaced. This remains one coordinator.
Follow the shared [Runtime](../yui-runtime/SKILL.md) core first. The installed
parent template's instructions and authority boundaries remain applicable.

## Read the current experiment, not the entire history

Read Task context and `yui task iteration overview <task> --json`. The overview
is navigation, not authority: retain Task requirements, constraints, inbox
originals, unresolved inputs and unknown effects. Open exact fixed references
with `yui task iteration read <task> '<reference JSON>' --json`.
Do not infer a current conclusion from the latest report or newest commit.
After context loss, reconstruct this bounded working set from persistent facts.

## Plan, measure, analyze

Before constructing or saving a record, read the installed
[record contract](references/records.md) in full, or reuse it while its unchanged
full content remains available under Runtime's rules. It owns record shapes,
save/read forms and verification. CLI help is command discovery, not the schema.
Do not probe writes with invented record shapes.

Maintain directions with a goal, metrics, constraints, explicit current
experiment/conclusion, next action and unresolved matters. Save reusable plans
separately. An experiment pins the plan, full code commits, actual parameters,
data/tool conditions and clean/dirty/unknown state. Reference required dirty
diff evidence; never copy credentials.

To reuse a plan from another Task, read its fixed reference and explicitly save
a local plan with `source` pointing to it. Preserve the source method and record
intentional changes. For project-wide reuse, use the existing Project Knowledge
proposal/promotion path with the self-contained method and fixed source plan;
read the parent's [Working context](../yui-leader/references/task-progress.md)
and the applicable Project requirements. Promotion is explicit, not automatic
permission to reuse the source Task's resources.

Repeat measurements are distinct execution records. Provider retries do not
automatically create samples. A failed/unknown execution is evidence, not an
automatic retry instruction. Changing candidates or essential conditions
creates a new experiment referring to the old one. Analyze fixed inputs with a
fixed method. Preserve negative findings and limitations. Explicitly select a
direction's current conclusion; support/refutation/supersession links alone do
not change that selection. Adoption belongs in a Decision; integration, review,
publication and Run state remain their existing authorities.

## Load manuals for the actual operation

Authorized `task iteration` record maintenance and reanalysis use Runtime,
this entry and the record contract; they do not alone trigger the general
Planning, Implementation or Artifact manuals. A record's `kind: plan` is not
a Draft activation handoff, and storage in Git does not make `iteration save`
a generic `task artifact` operation. Read-only analysis still authorizes no
save; an experiment mode or existing record grants no execution authority.

Read the parent's [Planning](../yui-leader/references/planning.md) for Draft
discussion, planning-only Session boundaries or activation handoff. For actual
implementation investigation or material verification design beyond current
Project methods, read [Implementation](../yui-leader/references/implementation.md).
For separate documents saved/cited through `task artifact`, read
[Artifacts](../yui-leader/references/artifacts.md). For allocation,
read [Allocation](../yui-leader/references/work-allocation.md); do not delegate
unless current user/Project instructions permit it. Before disposing of a
managed result or requesting Review, read [Review](../yui-leader/references/review.md); before integration read
[Integration](../yui-leader/references/integration.md), and before Task
completion read [Completion](../yui-leader/references/completion.md).
For material Brief changes read
[Working context](../yui-leader/references/task-progress.md).
Runtime's action index governs recovery and input handling.

## Preserve boundaries

An experiment record, plan, template inheritance or next-round proposal grants
no resource authority. Draft discussion does not authorize development.
Use existing Assignment/Run mechanisms, not a second experimental scheduler.
Workers submit only within their actual Assignment. Do not automatically run
real models, spend quota, change shared infrastructure or convert other Tasks.
Closing a direction or publishing a stage does not complete the long-term Task.
Retain conclusions, key data, important failures, reusable methods and precise
code/data provenance. Existing cleanup authorization applies; never delete
evidence needed by a retained conclusion or force-ACK inputs to reduce context.
