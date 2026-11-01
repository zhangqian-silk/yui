# Deliberate Session replacement

Read before an authorized Session replacement, not merely because a Turn failed.
Apply the common boundaries in [Runtime recovery](recovery.md) first.

## Replace a Session deliberately

An authorized Leader or Operator may request:

```sh
yui task role session new <task> <role> --reason "<reason>"
```

The old Run may still be active, the Session may already be released, or fresh
context may simply be preferable. Save necessary requirements, decisions,
progress and results first. Yui persists replacement intent, stops the exact
execution and retires its engineering attempts while retaining Task history and
workspaces. Do not manipulate Run status, delete context or change models to
make replacement legal.

When replacing yourself, end the native turn. The successor reads durable Task
context and fixed notification references, then chooses which still-valid
assignment to continue. Released Leaders retain scoped diagnostic reads but
cannot regain write authority.

Leader initialization is delivered separately from old inbox handling and
new queued business. A retained claim cannot block this lifecycle notification.
The current Leader reads `yui inbox list --view history --json`, then the exact originals and
prior effects. Claims survive unchanged; use `inbox ack` only after actual
handling, with the successor's own disposition. Do not claim an already-claimed
entry again. Repeated reconciliation or Controller restart does not settle
anything or repeatedly wake an idle handler.

A legally started GlobalRole successor with claims from a previous Session
receives one Session-pinned recovery Message in its existing inbox. It requests
the same inspection, not replay of those Messages. A stopped Global Session
is not started by this notice. Worker/Reviewer Assignment changes still require
the existing explicit handoff or retirement; no bulk transfer is implied.

Replacement waits for exact native/resource stop and writer release. Missing
proof requires repairing that observation or a genuinely missing user decision,
not a timeout, another name, force-ACK or record deletion. Uncertain old
notification submissions are released from scheduling without replay, retaining
their fixed wakes and `notification.resolved` evidence. They become explicitly
inspectable/settleable, not automatically accepted or resubmitted.
