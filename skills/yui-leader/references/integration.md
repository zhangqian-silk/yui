# Integrate an isolated result

Read this before integrating a WorkItem Candidate or handling an Integration
notification. Inspect the original result, diff, checks and exact Candidate.
If insufficient, return bounded feedback to the owning WorkItem/Role while
its scope remains valid.

For acceptable isolated Git changes, capture and integrate the latest Candidate
before acceptance:

```sh
yui task work capture <work-id>
yui task integration start <task> --project <project> \
  --work-item <work-id> --strategy <ff|cherry-pick|merge|manual> \
  --check "<Project Policy command>"
yui task work accept <work-id> --summary "<decision and evidence>"
```

These are distinct decisions; confirm Integration succeeded before acceptance.
Preserve each managed workspace's owner and the Task's recorded base. Do not
silently advance that base because a remote branch moved.

## Resolve ordinary Git conflicts yourself

`conflicted` is an engineering step owned by the Leader, not a request for
user authorization. Read both sides' intent and the current Task contract,
inspect the exact Integration source, target and workspace, resolve and stage
the files there, then run `integration continue`. No preceding
`resolve --option manual-resolution` is required for an ordinary conflict.
Core completes the matching Git operation, records the candidate, runs or
recovers its exact checks and advances the original target by CAS.

Do not close the Task execution gate, stop unrelated work, create an
InputRequest or end in passive waiting merely because Git conflicted.
Escalate only a real product choice, changed scope, unavailable external fact
or new authority. The explicit `manual` strategy still requires a recorded
resolution rationale; it is not the ordinary conflict path.

## Continue from exact evidence

For direct Integration checks running as a DurableJob, Job success is not
the final target update. Read the terminal result, then use:

```sh
yui task integration continue <task>/<integration>
```

This also applies when no manual conflict resolution was needed. Do not start
a duplicate Integration or wait for an empty queue to finalize it.

Resume interrupted Git/Job work on this attempt when its source/candidate and
Job identities can be proved. A clean HEAD, leftover REBASE_HEAD or successful
Job alone does not prove source application or target advancement. Read
diagnostics when evidence is missing or the source, workspace, candidate,
target or check conditions changed. Never blindly replay a finished rebase
or repeat a successful unchanged check.

Resolve failures using the exact conflict or check evidence and the supplied
Integration workspace. Never bypass compare-and-swap, update managed refs by
hand, or create a replacement WorkItem for ordinary Integration correction.
Recheck changed behavior or unresolved failures; do not rerun unchanged
successful validation without a current reason.

## Abandon an unprovable attempt without discarding delivery

If this attempt cannot safely continue, preserve its candidate, modifications,
logs and successful evidence, then formally `integration abort --reason ...`
(or reject a pending resolution). A failed attempt does not require keeping
the same ID forever or repairing a shared installation before any delivery.
Choose a new Integration or another already-authorized delivery path.

For `validating`, `abort` checks the exact target and Jobs under the same Git
fence as `continue`. An unadvanced target can be abandoned despite changed
check conditions. If CAS already advanced the target, the action records
`committed` instead of pretending delivery was aborted. Read the returned
outcome. A concurrent operation, unknown Job, or ambiguous target requires
inspection, not a forced status change or rollback of current Project policy.

Formal abort preserves history and workspaces. It is not Git abort, branch
deletion, target advancement, or proof that a Job/process has stopped.
Inspect all Jobs owned by the exact attempt, including an unbound Job;
cancel and establish quiescence by exact identity before reusing or cleaning
resources. Successful Job evidence and Task acceptance remain separate.

Direct Task-main delivery is an alternative only when current delivery
authority, ownership and the Task contract already permit it, with no other
writer or active check using that workspace. Do not edit managed refs or the
control-plane DB, modify another owner's workspace, upgrade shared tools,
or expand publication authority to work around an Integration failure.
