# Task artifact operations

These operations apply to planning and delivery results. The current Leader
adopts contributions from other Agents' authorized workspaces; do not share
an uncoordinated Git index or edit Yui storage directly.

```sh
yui task artifact list <task-id>
yui task artifact save <task-id> plans/design.md "<UTF-8 content>" --message "Revise design"
yui task artifact read <task-id> plans/design.md
yui task artifact read <task-id> plans/design.md <full-commit>
```

`save` writes and locally commits exactly one relative path, creating the
repository on first save. The `artifact.save` capability takes `taskId`,
`relativePath`, `content`, optional `message` and optional `expectedHead`;
the CLI equivalent is `--expected-head <commit>`. A head conflict leaves
the save unapplied: re-read and reconcile the intended update, not overwrite
blindly. The text interface accepts UTF-8 files up to 8 MiB, not arbitrary
binary payloads or an invented directory-upload command.

Current reads use Task and relative path at HEAD. Frozen Candidate, Review,
Context and completion evidence use the returned `taskId + commit +
relativePath`; do not replace a pinned read with a current read. For same-Task
string reference lists, use `git:<full-commit>:<relativePath>`, including
`task complete ... --artifact-ref "git:<full-commit>:plans/design.md"`.
The commit must be the artifact repository's returned commit, not the Project
code head. Preserve fixed old references when updating the current document.

After a meaningful save, update the Brief's summary/reference; keep Decisions
to the choice, reason and boundary. No document-body, HEAD or timestamp mirror
is needed. The artifact repository has no remote or transport; this does not
prohibit a Project code repository's legitimate remote. Saving in Draft grants
no delivery authority; Session handoff and archive preserve the artifacts.
Stored scripts/HTML remain data and are never implicitly executed or previewed.

These commands describe this source version's interface. A managed Session
still uses its authorized CLI and actual available capabilities. If an older
installation lacks them, report that version boundary; do not switch it to
an unapproved checkout CLI, migrate a shared Home, or upgrade the installation
merely to save a result.
