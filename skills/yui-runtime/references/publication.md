# Record external delivery

Use this when routing authorized follow-up delivery or after creating, updating,
closing, reopening or merging a PR/MR. This procedure does not grant permission
to push, publish, merge, query an external provider or archive.

## Post-completion routing boundary

An explicit user request to continue implementation or delivery of the same
completed, unarchived result authorizes its necessary reopening within that
request's scope. The current matching Leader may call `task reopen <task>` for
its own Task and continue that request; an Operator handoff is not mandatory,
and neither Role needs the user to additionally say “reopen.” Read the original
completion, fixed heads/reports, Publication, new request and current authority
first. Inspect the reopen result and current Context before executing; delivery
still requires the current Session's delivery authority, legal workspace and an
enabled execution gate.

If the Leader already received the request, use its original durable input and
continue after reopening; do not resend it or create a self-wake. Preserve a
direct-conversation request and its boundaries in Task records when needed,
without impersonating user/Operator input. When the Operator or user is routing
new input, use the existing two operations:

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
recovery do not authorize resumption. Cancelled intent needs explicit
user/Operator restoration authority and cannot be restored by the Leader;
archived Tasks cannot reopen. A stopped gate still needs
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
deployment status. Verification is tool-neutral: the Leader may use any available
CLI or API within the existing external-read authority. No particular brand,
installation or second gh/glab query is required. A summary saying "merged" is
reported evidence, not a tool observation; `upsert --verified` is refused.

First record the exact local candidate, PR/MR URL (including its service host)
and target branch. Inspect that object with an authorized tool, checking the
repository, PR/MR identity, target branch, remote source head and integrated
commit against the actual output. Then use
`task publication verify <task>/<publication> --observation '<json>'`.
The JSON fields are `taskId`, `publicationId`, `projectId`, `provider`,
`repository`, `externalKind`, `externalId`, `externalUrl`, `targetBranch`,
`localCommit`, `state`, `headCommit`, `remoteCommit` (required for merged),
`observedAt`, `tool`, `command`, `output`, and optionally `mergedAt`.
Use full lowercase SHAs and ISO timestamps; `output` is a sanitized relevant
tool-response excerpt, not an unsupported conclusion or credentials. `command`
describes the exact CLI query or API request; Yui does not execute it.
Read the original output and resolve ambiguous/conflicting results before
asserting a known state. Do not fabricate evidence or normalize failure into merge.

The observation must name the current immutable Publication, match its candidate,
URL and target, and be recorded within 24 hours without future dating. The tool
read may precede the first upsert or a title-only update: these are bookkeeping,
not changes to the observed object. Observations must not predate the latest
material change in the immutable lineage (candidate, object, target or remote
facts), including a changed-then-restored candidate. When only bookkeeping has
changed, read the current record and bind the same actual result to its current
ID; do not repeat the external query just for that update.
Identical immediate retries reuse the saved receipt.
Later candidate/URL/target changes invalidate verification; use fresh evidence,
not an old JSON edited to look current. Inspect `publication show` after an
uncertain save before retrying. Original records and their full evidence remain.
These are caller-attested tool facts: Core checks exact binding and freshness,
not the semantic truth of arbitrary output. It trusts the authorized Leader's
inspection, not the executable's brand.

Without `--observation`, `verify` uses the optional gh/glab adapter and performs
an external read, requiring that read's existing authority. Missing adapters
are not missing user authorization when another authorized tool is available.
If no usable evidence or authorized read exists, retain reported evidence and
state that specific gap. A recorded verification is fixed evidence, not live
monitoring; no clock-based re-query is required just to archive it. Known later
changes must be recorded as successors before relying on delivery.

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
an authorized tool or the optional adapter and records contrary head/state facts as reported successors,
invalidating previous verification. Metadata and verification updates may retain
adoption while the candidate is unchanged; a changed candidate needs a new
decision. Archived history is read-only to these adopt/verify operations.

Use `yui task remote-delivery <task>` to explain external delivery. Publication
is not Candidate acceptance, Review, Integration or Task completion.

## Archive separately

Completion does not authorize archive. A delivery Leader with original user
authorization may use [ordinary archive](../../yui-leader/references/authorization.md);
this grants no force or abandonment authority. Otherwise the Operator obtains authorization for
the exact Task, checks archive eligibility, then uses `--integrated` for verified
merged delivery or `--abandon` for deliberate non-delivery. General archive
approval never implies `--force` authority. Preserve the Task record.

Ordinary archive requires settled business, exact delivery (or authorized
abandonment), and proven stopped execution. It commits logical archive before
one foreground resource cleanup. Safe physical retention—dirty diagnostics,
missing-path recovery gaps, or remaining Git registrations—is not a reason to
force archive or rewrite old Integration outcomes. Terminal failed/superseded
Integration history stays readable; an active/conflicted attempt or unknown
execution still requires settlement.

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
`data.archive.retainedResources` and `data.archive.cleanupEvents`. These bounded
views include counts and inspection actions; read the existing paginated
`task event list` and Task context resource inventory for omitted evidence.
A successful archive
exit means `archived=true`, not that cleanup fully succeeded. `cleanupFinished`
means the foreground pass finished, not that every resource was removed.
`allResourcesReleased` separately requires release evidence and no retained
resources. Historical warnings do not disappear after a successful later pass.
If cleanup was interrupted, the Task stays archived. Repeating archive only
reports current facts. After inspecting the exact retained owner/reason, use
`task archive-cleanup <task>` for one new bounded pass, or the reported
WorkItem/Review/Integration cleanup entry. Every pass rechecks current identity,
runtime and Git registration facts; it is not an atomic batch and does not
discard unknown material. Registry-only remnants require the existing resource
inspection route, not a global `worktree prune`. No background retry is implied.
