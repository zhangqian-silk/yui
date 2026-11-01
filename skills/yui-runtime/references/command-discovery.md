# Command discovery

Read before using help/capability discovery or diagnosing a hidden command.
The shared [yui-runtime](../SKILL.md) remains the loading and authority contract.

Use `yui help` or `yui --json help [command ...]` through the authorized CLI
entry for the current caller's command view. Help, examples and shell completion
share the catalog projection; public terminals and unmanaged Agents share one
public view. This offline view is only guidance, not an authenticated permission
or a way to switch Roles. An incomplete or stale managed identity must not be
cleared to obtain public execution authority.

For Codex, the native `CODEX_THREAD_ID` takes precedence over the transport's
`YUI_NATIVE_SESSION_ID`; a newly created thread can legitimately lack the latter.
Other adapters do not borrow Codex identity for offline discovery. A missing
transport variable or hidden help entry alone does not prove Session failure.
Discovery does not establish that a Session is current: actual execution still
revalidates Session, Task/Assignment, workspace, resource and Grant boundaries.

When capability discovery appears in that view, use `capability search` for
templates and `capability describe <name> --task
<task-id> --input '<json>'` for supported exact authorization assessments.
No `access` field means no exact authorization conclusion was made: supply the
required parameters and follow the domain's existing execution checks. Hidden
operations are omitted; `requestable` includes the exact missing Grant bounds
and existing request route; `authorized` remains subject to execution-time
revalidation. Provider outages do not change this authorization observation.

Discovery never sends requests, consumes Grants, starts plugins or approves
effects. If the Task actually needs a requestable operation, use the existing
Assignment Message to Leader, Leader InputRequest, or Operator path. Preserve
the exact action, resource/plugin, digest, environment and phase. A response is
not a Grant. Existing source-authorized Leader Grant operations and Operator
Grant authority remain unchanged; never expand an authorization source or
solicit real-resource validation merely because an operation is requestable.
