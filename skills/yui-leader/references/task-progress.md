# Durable working context

Read when materially updating Brief, Milestones or cross-Task
Knowledge. Routine unchanged continuation needs no update or manual reload.
Runtime’s read-only intent boundary applies.

The DB Brief holds current focus, next action, unresolved commitments/unknown
effects and fixed plan/report/activation/input references, not full documents
or chronological history. At meaningful progress, requirement changes and phase
handoffs, read `task brief show`, then update only intended fields using
`task brief update --if-current <writeGuard>`. Replace superseded text; retain
history in original records/artifacts. Read `task event list` before deliberately
restoring an older value. On stale guard, read and reconcile new input rather
than replaying old text; Core's lifecycle diagnostics do not rewrite history.

Before `task complete`, reread Brief and correct resolved blockers or obsolete
waiting/plans. Unchanged routine steps need no update; do not duplicate the
terminal completion summary or create a new completion gate.

Add a Milestone only for an independently meaningful outcome, a Message only
for a new conclusion another reader needs, and Project Knowledge only for a
stable cross-Task lesson. Do not create records for every exchange, dispatch,
heartbeat or unchanged wait. Ordinary fact edits need no self-wake.
