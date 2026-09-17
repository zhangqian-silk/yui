# Bounded Provider recovery

Yui can continue an owned input after a positively identified transient Provider
failure without discarding its Session or local work. The Driver supplies failure
and native-state evidence; the Controller schedules and atomically admits the
next input. Agents still own semantic recovery and acceptance.

- At most five automatic attempts after the initial failure, within ten minutes.
- Exponential windows start at five seconds and cap at sixty seconds, with
  50–100% jitter. A trusted Retry-After is a minimum, with positive jitter.
  A wait beyond the remaining deadline ends automatic recovery.
- Busy/admission waiting does not consume a model attempt. Acceptance, heartbeat
  and partial output do not reset the streak. Only the matching successful
  native terminal ends the chain; audit history remains.
- A rejected input retains its original durable reference. An accepted failed
  Turn gets a new Turn in the same Session with a system recovery instruction:
  inspect existing work and receipts and continue only unfinished actions.
- Unknown acceptance is never replayed. Existing exact-identity reconciliation
  may supply the missing outcome. Restarting the Controller does not reset the
  counter, deadline, pending input or writer fence.
- An explicit manual retry of the same Run retains its recovery lineage,
  automatic count and original deadline. It is not charged as an automatic
  attempt, but a further failure cannot replenish automatic allowance.

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
Claude/ACP retain their normal error and explicit recovery behavior.

Storage transition 26→27 adds optional recovery/input facts and indexes without
scanning or scheduling old failures. Adoption requires the normal explicitly
authorized release/upgrade and compatible Host lifecycle. Building or completing
this Task does not enable the change in an already-running shared instance.

Deterministic checks use disposable SQLite Homes, fake native protocol and
injected time; they do not establish real-provider behavior or idempotency of
arbitrary external tools. External effects still require their normal authority
and receipt/idempotency protections.
