# Record external delivery

Use this when routing authorized follow-up delivery or after creating, updating,
closing, reopening or merging a PR/MR. This procedure does not grant permission
to push, publish, merge, query an external provider or archive.

## Post-completion routing boundary

An explicit user request to continue implementation or delivery of the same
completed, unarchived result authorizes its necessary reopening within that
request's scope. The Operator need not ask the user to additionally say “reopen.”
Read the original completion, fixed heads/reports, Publication and current
authority first, then use the existing two operations:

```sh
yui task reopen <task>
yui operator submit "<new request, authority, boundaries and prior evidence>" \
  --task <task> --intent develop --request-id <id>
```

Unaddressed `task message send` with the same intent/key options is an alternative
to the second command, not an additional send. Ordinary send/queue/submit still
refuses completed Tasks before saving new input; no intent implicitly changes
lifecycle and there is no auto-reopen option. `--to leader` instead requires an existing
WorkItem/ReviewRound Assignment.

Reopen returns the Task to active and clears its current completion fields;
original completion events, fixed commits/artifacts and Publication history stay
intact. The Leader must assess the new request and separately accept any new
result, not pretend old validation proves changed work. Reopen does not replay
historical Messages/Runs, change the Role's Agent/model/permissions, or lift an
independent execution stop. Queries, ordinary record/discussion input and Session
recovery do not authorize resumption. Cancelled intent needs its own explicit
restoration authority; archived Tasks cannot reopen. A stopped gate still needs
the separately authorized start/cleanup path.

These are two atomic operations, not one transaction. Read the reopen result and
the submission's saved/queued receipt separately. If the second step fails,
inspect current Task/Message facts and continue only the unapplied step within
unchanged authority. Keep the same submission key on a matching retry; unknown
native or external effects are never replay permission. Do not reopen again just
to retry input after another completion, cancellation or stop. A lifecycle-only
notification may precede the new Message: the Leader waits for the actual request,
without rerunning old work or immediately completing the reopened Task.

Publication recording, diff/adopt and verification remain separately authorized
atomic operations on completed, unarchived results. They need no reopening when
no further execution is requested, and never grant authority for code changes.

## Record and verify the owning Task's publication

Immediately record the confirmed operation with `yui task publication upsert`.
Supply only facts already known from the operation; do not defer recording to
another Role or depend on provider-specific discovery. Keep it with the Task
whose result is delivered; do not duplicate the same PR/MR across Tasks to
substitute for missing ownership or acceptance evidence.

Track PR/MR identity, state, commits, URL, merge time and evidence, not CI or
deployment status. After merge, use `yui task publication verify` only when
current authorization covers that external provider read. Otherwise retain
reported evidence and state the verification gap.

Preserve each completion head as that acceptance's evidence. After an authorized
reopen, finish the new work and record its own completion; retain the earlier
event and report rather than rewriting them. For a still-completed Task whose
authorized post-completion integration produced a different candidate, record
its exact local commit, then read `task publication diff <task>/<publication>`.
Inspect the complete delta against the original acceptance, including removals,
conflict resolutions and additional changes. Only when that candidate still
satisfies the result and its relevant increments are accepted, record
`task publication adopt <task>/<publication> --reviewed-diff <sha256> --acceptance <text>`.
Explain the semantic judgment and verification/review evidence in the acceptance.
When an existing Task Integration produced that exact candidate, include
`--integration <id>` in diff and adopt to bind its committed evidence.
Ancestry or Integration success alone is not acceptance; do not reopen the Task,
rewrite completion, or mark a merge verified to bridge an evidence gap.

Adoption records a fixed decision, not remote verification or publication
authority. The verify operation observes the exact Publication candidate through
its provider and records contrary head/state facts as reported successors,
invalidating previous verification. Metadata and verification updates may retain
adoption while the candidate is unchanged; a changed candidate needs a new
decision. Archived history is read-only to these adopt/verify operations.

Use `yui task remote-delivery <task>` to explain external delivery. Publication
is not Candidate acceptance, Review, Integration or Task completion.

## Archive separately

Completion does not authorize archive. The Operator obtains authorization for
the exact Task, checks archive eligibility, then uses `--integrated` for verified
merged delivery or `--abandon` for deliberate non-delivery. General archive
approval never implies `--force` authority. Preserve the Task record.

With explicit force authorization for a completed or cancelled (retired) Task, use
`yui task archive <task> (--integrated|--abandon) --force`. Force commits the
archive and stops new Task scheduling before attempting safe foreground cleanup.
Missing/stale delivery evidence, unresolved execution and cleanup errors become
warnings with retained resource references; they do not block that commit.
Authority, lifecycle, identity and mandatory audit persistence still fail closed.

Force does not verify a merge, accept work, stop unknown execution, discard dirty
data or imply abandonment. Keep the requested disposition and original
Publication/completion evidence. Unverified local commits and resources that
cannot be safely released stay owned and traceable. Late runtime events remain
source evidence, not authority to resume or settle unknown input.

Read `task show <task> --json` for `data.archive.warnings`,
`data.archive.retainedResources` and `data.archive.cleanupEvents`;
`task context` also retains the original records/events. A successful archive
exit means `archived=true`, not that cleanup fully succeeded. `cleanupFinished`
means the foreground pass finished, not that every resource was removed.
If cleanup was interrupted, the Task stays archived. Repeating archive only
reports current facts; use explicit, exact-owner resource operations after
inspection instead of re-running broad cleanup. No background retry is implied.
