# Failed execution and Provider recovery

Read when a native Turn or launch failed, before retry or a manual successor.
Apply the common boundaries in [Runtime recovery](recovery.md) first.

## Inspect the failed execution

Read the referenced `runtime.agent-error`, exact AgentRun, Role Session and
affected WorkItem, ReviewRound or Integration. Use `task next-action` and
`execution audit` as decision support, not as an automatic plan.
Active or quiet observations are not a Task-wide lock or proof of failure.

### Configuration and model-name failures

The already-running caller handles a failed launch: Worker/Reviewer failures
go to their Leader, and an unavailable Leader's failure goes to the existing
Operator channel. A target that did not start cannot repair itself. Read the
referenced error once; do not create a recovery Agent, a polling loop or a new
Task merely to handle it.

Use the error's capability-query pointer to inspect native metadata with the
recorded failed configuration:

```sh
yui task event show <task> <error-event>
yui task role capabilities <task> <role> --error <error-event> --refresh
```

The query uses the Controller's Provider environment, not your own Agent's
possibly different account variables, and requires that Controller to be running.
It preserves the requested model, workspace, profile/settings selection and
configured Agent identity. Native settings files and credentials are still read
currently, not copied into error history. A historical error without a recorded
configuration, or a changed Agent command/bindings, returns a diagnosis instead
of borrowing today's Role configuration. To inspect the desired next launch
explicitly, omit `--error`. Distinguish live enumeration, identity-matched cached
observations, declared static adapter inputs, and unavailable fields. Read field
reasons, warnings, observation/attempt times and the current query error: a live
query can contain static or unavailable fields, and a cache hit is not current
Provider confirmation. Do not treat an alias list as a complete Provider
whitelist or a static/custom choice as proven native support.

Reconcile the original user requirement with exact native IDs and alias
mappings. Correcting the name of the same authorized model is routine recovery;
selecting another model, account, permission or cost boundary is not. If there
is no proven equivalent, preserve the failure and report the missing choice.
Do not guess names, select a similarly named variant, or silently fall back.

After correcting only the intended configuration, choose the existing operation
that matches current facts. A rejected notification retains its input:

```sh
yui task wake show <task> <wake>
yui task wake retry <task> <wake> --reason "<correction and evidence>"
```

Retry does not replace a Session or change its immutable effective configuration.
If an existing Session must adopt changed settings, read
[Session replacement](session-replacement.md) before that operation; an assigned
Run uses its own legal retry operation.
Accepted or uncertain input cannot be replayed through notification retry.
Configuration failure is not transient infrastructure recovery, and unchanged
configuration does not justify another attempt.

### Bounded infrastructure retry

The Controller, not the Agent, counts and schedules qualifying transient
Provider retries: at most five automatic executions after the initial failure,
within one ten-minute recovery window. Native acceptance, activity and partial
output do not reset that count. Only proven native success resets the chain;
it neither accepts a WorkItem nor completes a Task. Unknown delivery remains
fenced for exact readback; it is never replayed.

Inspect the current `providerRetry`/`retry` projection in Context, or use
`task role session retry <task> <role> show`; Global Sessions use
`session retry <role> show`. While `waiting` or `in-flight`, do not dispatch a
duplicate or add a private retry loop/resend. After recovery inspect prior work
and external receipts before continuing; recovery instructions grant no new
authority. A readable failed Run remains immutable evidence while its recovery
successor handles the same responsibility and frozen Review boundary.

`cancel` withdraws pending automatic recovery; `disable` additionally disables
future automatic chains on that Provider binding. Neither stops an admitted
native Turn. `enable` permits future failures to qualify, without replaying
old failures. These controls require the existing user/supervisor authority.

`exhausted`, `cancelled` and `needs-attention` preserve the error, input and
work. Read their exact reason, then choose an authorized next action. Unsupported
Hosts/Adapters or unprovable Session/background state do not trigger automatic
replacement, cleanup, model switching or a new grant.

A failed AgentRun is immutable; retry creates a new attempt. Reuse a recoverable
Session when useful and load the new attempt's current context, not an old
Assignment from memory. A new Host process need not mean a new native Session.
Preserve frozen Review candidates and selected synthesis sources on retry.
An infrastructure failure is not a defect in the business result.

Native internal retries are not failed terminals: observe without submitting
another input. A missing automatic retry record is not evidence of exhausted
budget or a damaged Session. An explicit `task run retry <task>/<run>` can
continue from the current exact failed Turn even without an earlier automatic
chain. Codex `systemError` alone does not require replacement; the normal
submission path checks that the latest Turn is that failed Turn and background
execution is empty. Missing or changed proof is a refusal, not permission to
replay, change models or silently replace the Session.
