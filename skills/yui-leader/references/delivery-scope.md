# Adjust Project delivery scope without erasing work

When explicit user intent or an original delegation allows a Project to leave
the final delivery, read that original Message and `task remote-delivery`.
Record the bounded decision with
`task project delivery <task> <project-id> --requirement excluded --reason <reason>
--source-message <message-id> --purpose <verbatim-authorization>
--if-current <scopeDecision.id|none>`.
Interpret whether the original really authorizes this scope change; a matching
quote alone is not semantic permission. Do not exclude a Project to conceal an
unmet commitment. Ask only for a genuinely missing scope decision, not a second
approval when existing user intent or delegated judgment already covers it.
Use the same operation with `--requirement required` and the latest decision ID
to restore normal checks. Reconcile a stale guard instead of overwriting newer
intent. These append-only decisions also work on completed, unarchived Tasks
without reopening, rewriting acceptance, or rerunning work.

Unchanged Projects need no exclusion. Required changed/unknown Projects still
need exact verified delivery. Excluded Projects retain their binding, code
changes and Publication facts and are not counted as merged or verified merely
because they are excluded. Scope is not execution, write, archive or deletion
authority: open commitments and unknown execution still need settlement, and
unique commits or dirty resources remain protected. With separate archive
authorization, use ordinary archive/preflight and report retained resources;
do not recommend force merely because an authorized Project is excluded.

