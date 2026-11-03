# Continue a completed result

Read before reopening a completed, unarchived Task for authorized same-result
follow-up or an explicitly identified unfulfilled commitment. This grants no
new authority.

## Post-completion routing boundary

An authorized same-result follow-up or explicitly identified unfulfilled
commitment may require reopening for tracked diagnosis, evidence handoff,
necessary coordination, implementation or delivery. A simple factual query
does not. Diagnosis remains read-only unless changes are requested; reopening
does not turn discussion into implementation. The current matching Leader may call `task reopen <task>` for
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
  --task <task> --intent <discuss|develop> --request-id <id>
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
independent execution stop. Choose `discuss` for diagnosis/explanation and
`develop` only with implementation authority. Simple queries, record-only input,
ordinary notifications, Session recovery or an opportunity for improvement do
not themselves authorize resumption. New goals need their own Task, not an
expanded old result.
Cancelled intent needs explicit
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
