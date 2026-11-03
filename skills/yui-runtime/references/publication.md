# Record external delivery

Read after an authorized PR/MR operation or before recording, verifying or
adopting its evidence. This does not authorize push, publish, merge, external
reads or archive. Reopening and archive have separate action-specific routes
in [yui-runtime](../SKILL.md).

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
