# Global input controls

Read before sending, steering or interrupting GlobalRole input, enabling
controlled Global delivery, or inspecting classified delivery diagnostics.
This is not required just to receive an input;
use [yui-runtime](../SKILL.md)'s own-inbox flow for that.

A GlobalRole's durable input uses the same three actions as a Task Role,
addressed by the Role's own name instead of a Task. The local-user Web surface
exposes this contract. Use `yui role message queue|steer <role> <text>` or
`yui role interrupt <role>` through the public CLI. Queue/steer require a stable
`--request-id`; steer/interrupt require the exact `--expected-target`.
Configuration remains under `config role` and lifecycle under `session`.
Do not fabricate Task/Run ownership or borrow the browser's user authority to
bypass a managed Session boundary.

Queue and steer
save an owned Message; bare interrupt records a control request, not a new
Message. Each uses a stable request id and that Role's own Session; none fabricates a Task or
runId to reuse Task-scoped delivery. `queue` delivers at the Role's next legal
opportunity and is idempotent by request id. `steer` and `interrupt` affect only
the exact current native Turn — a stale `--expected-target`, an incapable plan,
or an unproven delivery leaves the Message saved and reports the reason, and
`interrupt` stops only through the Provider's native cancel with an optional
`--then-message` naming one already-saved GlobalRole Message. When the Role holds
no live managed Turn, a steer or interrupt is `NO_ACTIVE_TURN` and never falls
back to another action.

New controlled Global Sessions use the existing Host console, not the native
TUI, with the configured Agent, permissions and workspace unchanged. A live
unmanaged Session is not silently replaced or adopted; use an explicit Session
lifecycle action before enabling controlled delivery.

Only an exact terminal and the original Session/writer boundary release a then
handoff. Never resubmit accepted/unconfirmed steer through changed request IDs
or composed then; only conclusive rejection permits an explicit new attempt.

## Inspect delivery diagnostics

`role message list <role> --diagnostics` reports classified original failures
with first/latest occurrence, distinct-observation count and recovery evidence,
not repeated polls of one observation. `--diagnostic <key>` pages originals.
Recovery notices neither ACK input nor prove effects undone;
`interrupt-requested` proves neither Turn nor background stop.
