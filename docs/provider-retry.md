# Bounded Provider recovery

Yui can continue an owned input after a transient or unrecognized Provider
failure without discarding its Session or local work. The Driver supplies failure
and native-state evidence; the Controller schedules and atomically admits the
next input. Agents still own semantic recovery and acceptance.

- Known transient errors allow at most five automatic attempts after the initial
  failure, within ten minutes. An unrecognized error (missing `retryable`, not
  an explicit `false`) allows only the first automatic attempt of that same chain.
  This is one shared counter, not an extra allowance per error: unknown → transient
  can use the remaining attempts up to five; transient → unknown stops if any
  automatic attempt has already been spent. Neither change resets the deadline.
  Known permanent errors always stop, even with a nested transient cause.
- Exponential windows start at five seconds and cap at sixty seconds, with
  50–100% jitter. A trusted Retry-After is a minimum, with positive jitter.
  A wait beyond the remaining deadline ends automatic recovery.
- Busy/admission waiting does not consume a model attempt. Acceptance, heartbeat
  and partial output do not reset the streak. Only the matching successful
  native terminal ends the chain; the displayed attempt count and audit history
  remain. Native recovery is not Task/business acceptance.
- A rejected input retains its original durable reference. An accepted failed
  Turn gets a new Turn in the same Session with a system recovery instruction:
  inspect existing work and receipts and continue only unfinished actions.
- Unknown acceptance is never replayed. Existing exact-identity reconciliation
  may supply the missing outcome. Restarting the Controller does not reset the
  counter, deadline, pending input or writer fence.
- An explicit manual retry of the same Run retains its recovery lineage,
  automatic count and original deadline. It is not charged as an automatic
  attempt, but a further failure cannot replenish automatic allowance.
  If no automatic chain exists, it can still use the current binding's exact
  accepted failed Turn and original input. The error need not have qualified
  for automation; manual intent does not waive Session, authority, latest-Turn
  or background-quiescence checks.
- A current-owner manual execution retry can recover that same failed Turn
  across a message continuation and subsequent retries only when the durable
  chain proves every intervening attempt was rejected before a Provider write.
  Session, authority, Assignment, launch configuration and workspace must match.
  It carries the current continuation input, not the earlier business directive,
  and preserves the original automatic budget. Missing proof or any intervening
  accepted/unknown input leaves ordinary admission fenced.
- Once that exact recovery is accepted, its Agent can claim and acknowledge
  the original continuation Message through the same verified lineage. This
  is handling authority, not another delivery: recipient, continuation target,
  prior claims and failure records stay unchanged; no Message is requeued.

The records live on the existing Provider binding, with indexed pending-record
reads and the existing Controller deadline timer. There is no retry Task status,
second queue, automatic Session replacement, account-wide circuit breaker or
model switch. The original failed AgentRun stays failed; ordinary Run/Review
retry primitives own its successor and keep the original ReviewRound.

## Inspect and control

Task Sessions:

```sh
yui task role session retry <task> <role> show
yui task role session retry <task> <role> cancel
yui task role session retry <task> <role> disable
yui task role session retry <task> <role> enable
```

Global Sessions use `yui session retry <role> show|cancel|disable|enable`.
This narrow existing Session surface does not register the unrelated
top-level Global `role` command family.

The same projection appears in Context, Session inspection and the Web role
panel. `cancel` withdraws this recovery chain; `disable` also disables future
chains on the current Provider binding. Neither interrupts an admitted Turn.
`enable` does not replay historical failures. Existing Task/Role authority applies.

## Failure evidence and Agent handoff

The retry projection includes the original input reference (never copied console
text), exact Session/attempt identities, the preserved error, the latest Turn
failure and earlier chain references. A changed error that still satisfies the
same safe retry rule continues within the original budget. Loss of that rule,
authority or budget stops automatic submission.

Codex's structured `codexErrorInfo: "serverOverloaded"` qualifies as temporary
capacity failure. Its structured stream/connection failure variants and
`stream disconnected before completion: stream closed before response.completed`
also qualify. Shared structured HTTP 408/429/500/502/503/504 and recognized
transport codes supply transient evidence for the existing Adapters.
Capacity prose alone gets no positive transient evidence; it can use only the
unknown fallback, subject to the same native safety checks.
Authentication, permission/policy denial, quota/balance exhaustion, invalid
requests/models, context capacity/413, cancellation and unavailable Sessions take
precedence over transient evidence. Only error-envelope fields are inspected for
structured qualification, not echoed prompts or arbitrary tool output.
Native nonterminal error/retry notifications do not create a Yui retry; only
the exact failed terminal does. A missing retry record therefore does not
prove budget exhaustion or an unrecoverable Session: inspect the original
error and current Turn before choosing explicit recovery.

`retry show` returns a separate `decision` even when `retry` is null: policy
source, category, consumed/remaining automatic attempts, deadline when a chain
exists, failure reference and the scheduling blocker. Context and current Run/
Global health expose the same derived decision. A waiting decision still needs
fresh native admission; it is not evidence that a write already succeeded.

Task errors retain their original `runtime.agent-error` evidence and notify the
Leader, or the Operator when the affected Role is the Leader. Global failures
retain record-only Messages in their own Role inbox, including intermediate
failed attempts; these are evidence, not new input that cancels recovery.
When Global recovery stops or its effect is unknown, a deduplicated system
Message carries the facts to the existing Operator. If the Operator itself
failed, or no Operator is configured, the notice remains visible for the user
or successor without submitting a self-recovery prompt.

Malformed JSON frames and failing protocol listeners close the affected channel
with the original cause. Unrelated valid protocol notifications remain ignorable.
The existing Host Inbox carries the diagnostic to Task/Global consumers without
inventing a native terminal, clearing a writer fence or replaying input.

Endpoint cleanup preserves stop/close errors, the exact implementation and client
identities, last observed drain facts and pending effects. A failed inspection is
not an empty resource list. Later owned cleanup steps, including control-socket
closure, still run; cleanup failures retain their causes and produce a failing
Host exit rather than silent success. Timeout reports never claim quiescence.

The optional detached-child metadata reconciler retains its existing bounded
query, backoff and circuit pause. Unavailable observations preserve writer
ownership and expose their original error, exact targets and sampling count.
The first failure and circuit-limit crossing use existing deduplicated error
events; metadata sampling does not start model work or declare a parent result.
No new default metadata collector, retry worker or durable state schema is added.

## Supported boundary and adoption

Current controlled Codex Hosts advertise exact recovery support. The native
preflight checks the latest failed Turn identity for accepted-input recovery
and a complete empty background-terminal page; ordinary `systemError` admission
remains closed. Missing protocol methods, a changed/active Turn, unresolved
background execution or a changed Session/configuration require inspection,
not automatic cleanup. Native chats without an owned input reference, old Hosts,
and Adapters without this proof capability are not automatically replayed.
Claude/ACP share classification and budget policy, but without the native proof
capability they retain explicit recovery and report the unsupported admission.
Unknown `sessionDisposition` is not rewritten to `recoverable`: an accepted
terminal with an exact failed Turn and a capable Host may schedule the native
proof check, which must pass before submission. Unknown delivery never qualifies.

The finite defaults remain five attempts/ten minutes for known transient errors
and one shared-count attempt for unknown failures. No new configuration knob or
persistent field is introduced; existing valid retry records retain their count,
window, controls and lineage. New policy applies when current failures are
recorded; historical failures are not rescanned or automatically replayed.

Storage transition 26→27 adds optional recovery/input facts and indexes without
scanning or scheduling old failures. Adoption requires the normal explicitly
authorized release/upgrade and compatible Host lifecycle. Building or completing
this Task does not enable the change in an already-running shared instance.

Deterministic checks use disposable SQLite Homes, fake native protocol and
injected time; they do not establish real-provider behavior or idempotency of
arbitrary external tools. External effects still require their normal authority
and receipt/idempotency protections.
