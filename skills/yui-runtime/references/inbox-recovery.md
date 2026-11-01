# Inbox recovery and retained handling

At an exact native terminal, engineering checks for unacknowledged inputs
correlated to that turn and emits at most one existing notification. This is
missing-evidence detection, never semantic ACK or proof of absent effects.
Reminder-only turns do not generate another reminder. The retained originals
remain inspectable if the bounded reminder is also missed; do not start a
private polling/retry loop or copy the business input to obtain another turn.
Task Assignment checks go to Leader for inspection and existing handoff or
retirement, not automatic Worker/Reviewer replay. Exact terminal can end an
active-consumption notification reservation without acknowledging its input;
it does not infer or release an uncertain native writer.

For obsolete Global input that was conclusively not submitted, use
`yui inbox retire <entry> --request-id <stable-id> --reason "<disposition>"`
after inspecting the original and current facts. Retirement preserves the
original target, claim and explicit management evidence; it is not ACK.
Accepted input uses normal claim/ack reconciliation. Unknown/pending control,
transport acceptance and interrupt-then ownership cannot be retired through
this operation. Task Messages retain the existing Leader `task message retire`
and exact-Assignment handoff paths.

Apply Runtime's claim/ACK contract: interrupted claims remain discoverable,
non-expiring and unreplayed. A rightful successor must inspect the original
input and prior effects before completing authorized handling and acknowledging;
never replay uncertain external actions.
After legal Session replacement, initialization can arrive before old handling
is settled. This recovery notification is not the original business input or
an acknowledgement. Read the current inbox and prior effects first. For
`claimed-by-previous-session`, retain the original claim: do not claim again.
Finish only the still-authorized handling and use a new stable ack request ID
with a concrete disposition; the receipt retains both the old claimant and
the current acknowledging actor. New queued input remains separate.
For an exact-Session input already claimed by its selected Session, a rightful
successor may explicitly settle that handling after inspecting the original
and prior effects. This preserves the original target and claim; it grants no
permission to submit or execute the input in a different Session.
An Assignment change does not inherit handling authority. If the original Run
stopped before acknowledgement, ask the Leader to inspect its exact native
terminal and use the existing `task message handoff` to the current authorized
Assignment. The original claim remains; handoff never resubmits it automatically.
If that Assignment is obsolete, the Leader may inspect the original and prior
effects, then explicitly use `task message retire <task/message> --reason "<disposition>"`.
Retirement preserves the original claim and records the management decision;
it neither fabricates an acknowledgement nor proves native execution stopped.
An unfinished claim fences its Assignment, not unrelated work of the same Role.

In-flight, unknown, not-yet-delivered explicit interrupt-then and
unsettled steer inputs retain their existing owner/receipt and report a bounded
reason instead of being taken over. Use existing exact-receipt recovery when
needed; do not change request IDs, clear identity, or copy input to bypass it.
A steer with no control receipt was not submitted; it may be explicitly handled
and acknowledged in its authorized inbox, without converting it into a queue.
Accepted Global inputs, delivered Leader windows and current Assignment
continuations remain in the inbox until explicitly handled through the normal
claim/originals/prior-effects/ACK flow above, never another native delivery.
Claiming never resends input. A current rightful successor may settle accepted
Global input or a Leader window only after inspecting prior effects, retaining
the original delivery target. Pending/unknown acceptance remains blocked;
claiming cannot bypass it or authorize replay.
An explicitly released Leader notification (`notification.resolved` with
`released-without-replay`) can be claimed for evidence inspection and settlement
after verified native stop. Its original delivery status stays unknown or
unaccepted; handling it cannot retarget Session-specific instructions or
authorize re-executing unknown effects. If a required fact or user decision is
unavailable, preserve the claim and report that exact boundary.

An ack belongs to the exact original and revision: fixed windows pin
`message.updated` event identities, including same-timestamp edits. A later
revision still needs its own handling. Before Task completion, settle handled
user-input windows; native acceptance or a terminal does not settle them.
Original Messages, wake windows and handling receipts remain readable after
acknowledgement. Lost context, Session continuation and installation upgrades
do not reset receipts. If ack fails after an external effect, read back the
original claim and the external receipt before retrying the same ack; do not
repeat the effect. This is durable handling evidence, not arbitrary external
exactly-once execution.
