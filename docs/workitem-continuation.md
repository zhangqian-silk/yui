# Continue a WorkItem in its original conversation

Users can ask about a finished result in the original Role conversation.
Questions do not change WorkItem acceptance or create an execution.

For an explicit same-scope modification, the Role reads its WorkItem and
`yui task role session inspect <task> <role> --json`, then uses:

```sh
yui task work continue <task>/<work> --request-id <stable-id> \
  --expected-turn <native-turn-id> --input "<original user request>"
```

Core associates the **already accepted current native Turn** with a fresh
AgentRun. It neither sends another prompt nor creates another conversation.
The returned Run context supplies the frozen assignment and captured
permissions. The request text is audited as the Role's report of the user's
intent, not as permission to introduce Projects or change scope.

The operation is transactional and idempotent. Another active Run, a stale
native Turn, changed owner or scope, a pending Review or runtime transition,
unsettled Job execution, or an unknown delivery prevents admission. Preserve
the original request and use formal recovery/handover for those boundaries.
Never reset a released workspace's flag or silently replace a conversation.

For an accepted WorkItem, repair removes the current acceptance and Candidate
pointers. Historical Candidates, accepted events, Reviews, Integrations and
Runs remain. Completion of the new native Turn records a new Run result;
Leader submits/reviews/integrates/accepts the new Candidate under the normal
delivery rules. The old acceptance cannot cover it.

Host lifetime, execution lifetime, business acceptance and resource retention
are separate. To restore an idle retained WorkItem Host:

```sh
yui task role session resume <task> <role>
```

This checks the original identity and workspace and resumes the same native
conversation without submitting input or reopening business work. It cannot
resume a Task that is stopped, completed or archived, revive revoked ownership,
restore a released worktree, or replay unsettled input. Opening the provider's
original native conversation also retains this identity; use the bounded
continuation entry before making changes.

Keep the Develop workspace after completion/acceptance while repair is wanted.
Runtime-only cleanup is distinct from full WorkItem cleanup; full cleanup or
archive releases resources only through their existing ownership and dirty-file
checks and intentionally ends this direct continuation path.
