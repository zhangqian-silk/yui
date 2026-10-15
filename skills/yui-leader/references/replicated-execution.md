# Replicated execution and synthesis

Read this only when choosing replication or executing a Producer/main
synthesis assignment. Ordinary assigned WorkItems and direct Reviews do not
need an ExecutionGroup or Lane.

## Leader selection

Replication means independent attempts at the same frozen Assignment, not
different WorkItems executing in parallel. Choose it only when the extra
evidence repays comparison, coordination and Integration cost.

Use at least two distinct Producer Lane Roles. Replicated Review also has a
separate main Reviewer for authoritative synthesis. Automatic policy-triggered
Candidate Review stays direct. Do not treat a success count or a majority vote
as Core acceptance.

Select the original source AgentRuns explicitly:

```sh
yui task review synthesize <task>/<round> --source-run <task>/<run> ...
yui task work synthesize <task>/<work> --source-run <task>/<run> ...
```

Lane completion or settlement does not dispatch synthesis automatically.
A Lane retry remains the same replica. On failure, choose whether to retry
that Producer, settle the Lane, or synthesize selected available results.
Retry main synthesis through its exact AgentRun, preserving the source snapshot.

## Producer and main Agent responsibilities

A Producer independently inspects or implements its exact frozen Assignment
in the supplied Lane workspace and returns one complete original result.
For Review, give Producers common requirements/contracts and the same candidate.
Different risk emphases are not file ownership or permission to omit cross-layer
interactions. Form independent initial results before reading sibling conclusions.
Its evidence does not authorize a Candidate, ChangeSet, Integration or
acceptance decision outside the assigned protocol.

The main synthesis Agent reads every selected source AgentRun's original
result, checks it against the frozen sources, resolves disagreement through
judgment, and returns one authoritative report. Do not mutate source results,
omit selected evidence, rerun Producers, or substitute a winning Lane for
synthesis. A Review report remains evidence for Task acceptance, not acceptance
itself.
Deduplicate by root cause while retaining distinct triggers, coverage and
unexamined risks. Explain disagreements and unresolved evidence; do not discard
a valid minority finding or substitute voting for checking its contract and
reachability.
