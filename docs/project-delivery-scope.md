# Task Project delivery scope

Project bindings, delivery obligations, observed code changes and remote merge
facts have different meanings. A Task may retain a temporary implementation in
one Project while delivering its accepted result from another. Do not delete a
binding or fabricate a Publication to express that decision.

Read the original scope instruction and `yui task remote-delivery <task>`.
An authorized user, Operator or current delivery Leader can record one bounded,
append-only decision:

```sh
yui task project delivery task-1 project-2 \
  --requirement excluded \
  --reason "The accepted standalone implementation replaces the temporary one" \
  --source-message message-3 \
  --purpose "Only deliver the standalone implementation" \
  --if-current none
```

The Message must be original user/Operator input in this Task and the purpose
must be an exact quote. The Agent judges whether it authorizes this Project
change, including an explicit delegation of scope judgment; the CLI verifies
identity/provenance, not natural-language permission. A Role report, convenient
reason or invented quote is not authorization to abandon unmet requirements.

Use the latest `scopeDecision.id` from remote-delivery instead of `none` for
subsequent decisions. To restore delivery, record `--requirement required` with
its current guard and an appropriate original source. A stale guard fails
without overwriting the current decision. After an uncertain write, inspect
the decision before retrying; do not issue a new decision blindly.

Active and completed, unarchived Tasks with enabled execution accept these
management decisions. Completed Tasks stay completed; frozen heads, acceptance
and Publication history remain intact. No new execution or cleanup permission
is created. Archived, cancelled and stopped Tasks cannot use this operation to
resume or replace lifecycle intent.

The shared projection exposes `deliveryRequirement`, `scopeDecision` and
`deliveryRequired` alongside unchanged `codeDelivery` and merge/verification
facts. `codeProjectCount` still counts all changed or unknown Projects;
`requiredCodeProjectCount` is the obligation denominator, and
`excludedProjectCount` identifies explicit exclusions. Aggregate merged/verified
counts and `allMerged`/`allVerified` cover required code Projects only. A zero
denominator yields `status: none` (no delivery obligation), not evidence that
excluded code was merged. Missing heads/bases are unknown, never no-change.

CLI, current context, Web and ordinary archive use that projection. An unchanged
Project needs no exclusion; a required changed Project needs exact verified
remote coverage. Ordinary archive still requires settled WorkItems, inputs,
reviews, integrations/jobs and stopped execution. Physical cleanup separately
protects dirty files and excluded, unverified local commits. Logical archive can
succeed with retained resources, which remain owned and inspectable through
archive diagnostics and explicit cleanup. Exclusion never authorizes deletion
or force archive, nor changes Project-global state.

Storage 1.11 → 1.12 only admits the new event semantics through the centralized
minor upgrade chain. It does not rewrite old records or invent scope decisions.
No new table, workflow state, scan or background recovery service is added.
