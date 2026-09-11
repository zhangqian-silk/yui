<p align="right"><strong>English</strong> | <a href="./capabilities-and-resources.zh-CN.md">简体中文</a></p>

# Capabilities, resources and Surfaces

## One ingress, original facts

The Controller hosts the CapabilityRegistry and InstanceHost. `capability
search`, `describe` and `call` use one authenticated ingress: it first resolves
the current Session identity and Task scope, then checks capability and resource
permissions. An actor supplied in the input, or a self-declared user scope,
cannot grant permission.

A descriptor carries its name, contract version, Provider, scope, input/output
schema, effect and requiredPermissions. A query shows only the authorized
catalog; when a Provider or version is ambiguous, the caller selects explicitly
rather than relying on load order. The schema is a bounded dialect, and unknown
keywords are rejected.

The current catalog covers context, message, artifact, environment, resource,
project, plugin and selected task/job operations. Task lifecycle and some CLI/Web
writes share domain commands directly; these are not a second business state and
do not pretend to have run through the Registry.

## Effects and operation facts

A capability's return value is separate from its real effect. A call can produce
a confirmed sub-operation even when its output validation fails, so the returned
result must preserve the original owner's operationRef and receipt. Unknown must
not be read as "did not run," and there is no automatic fallback.

A nested call rechecks current permissions and cannot widen the permissions or
effect the parent call declared. A requestId identifies the call; it does not
supply universal idempotency for every downstream operation — an owner such as a
Job runs its own exact idempotency contract. After an error, read the original
operation facts before deciding the next step.

## Implementation instances

InstanceHost manages attach, acquire, release, detach and the actual references.
After a replacement is published, new calls select the new implementation while
existing references stay bound to the original one and can be disposed only once
drained. A query is an observation; it does not start or recover code. A cleanup
failure keeps its diagnosis, does not reverse a new publication into a failure,
and does not fake a drain.

A Session's long-lived reference is pinned by the actual AgentHost to the
implementation it loaded. The Controller carries an existing pin forward and does
not silently move a live Session onto different code. Ending a client and the
shared Provider's physical quiescence are judged separately.

## Projects and workspaces

A Project stores its reference checkout, Knowledge and resource references. The
stable checkout is read-only; Task delivery happens in a managed worktree. A
multi-Project Task uses independent Git roots and explicit write scopes. A
workspace owner is a Task, WorkItem, ReviewRound or IntegrationAttempt. A Role
only selects execution configuration; it does not independently own a separate
workspace state.

Git integration captures an exact ChangeSet and advances the target by
compare-and-swap after its checks pass in a candidate worktree. A conflict,
failed check, moved target or rejection never advances the target, and the Agent
chooses the next action.

## Artifacts and environments

- `artifact.save/read/list` stores immutable content, external-version evidence,
  a Job receipt or reference material. A reference is not a fixed delivery result;
  a final result cannot select a missing or cross-Task Artifact.
- `environment.prepare` prepares an empty, scratch or authorized local directory
  without adopting it automatically.
- `environment.adopt` rechecks identity, resource intent, permissions and
  conflicts, then records ownership.
- `environment.bind` selects a Role's next native execution environment; `null`
  returns to the managed workspace.
- `environment.release` checks the real references and quiescence evidence and
  never deletes a user directory.

An adopted native launch retains the directory's identity, access, isolation and
preparation reference, and rechecks them at launch, resume and the Yui input
boundary. Revoking a grant cannot silently re-adopt an old environment on the
strength of a new grant. Read-only environment support depends on the adapter; a
directory access label is not a general OS sandbox.

## Plugins and self-extension

A Task Leader or the global Operator can manage that Task's plugins; a
Worker/Reviewer cannot self-manage or self-trust them. A declarative plugin runs
no arbitrary code; executing a trusted-local plugin additionally requires a grant
scoped to the exact source or artifact digest, environment and phase.

The Store keeps the enabled intent and validation artifacts, and the Host keeps
the actual instances. After a restart the enabled selection is still readable,
the actual instance can be empty, and activation must be explicit. The original
Task can discover and call the new capability without rewriting its own native
tool schema. A business result should be saved as an Artifact rather than
depending on the plugin staying alive.

See the [Plugin SDK](../plugin-sdk.md) for the full authoring, authorization and
failure contract.

## CLI and Web

A Surface contribution is derived from the Registry's currently authorized
catalog; there is no second catalog or Host. A CLI contribution uses the
capability's original name. A Web panel accepts only controlled text, an HTTP(S)
link or a JSON query description — not author scripts or arbitrary HTML.

The Web listener is started and stopped by the Controller and allows loopback
only. A browser write goes through an existing domain transaction, and its error
distinguishes a definite non-commit from a committed-but-unknown result. A query
panel cannot use the browser's identity to run a mutation or manage plugins. A
terminal connection only attaches a client; it does not take over durable
ownership of the native conversation.
