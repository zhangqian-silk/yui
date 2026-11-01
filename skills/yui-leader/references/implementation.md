# Implementation and verification

Read for implementation investigation or material verification design when the
Project instructions and current requirement do not already suffice. This does
not require loading dispatch, review or integration procedures.

## Choose the simplest coherent result

Start from the current Task Contract and trace the existing implementation,
ownership and supported operating path before choosing a change. Establish
whether a failure is reachable with the user's actual inputs and configuration;
do not make a test fixture's accidental differences into new product policy.

Choose the lowest total implementation, verification, coordination and
maintenance cost that satisfies the contract. Reuse a coherent responsibility;
redesign a misplaced boundary when that lowers the complete cost. Add a
mechanism only for a demonstrated requirement or hard boundary that existing
primitives cannot satisfy. Derived views must not become competing truth.

Make routine legal choices yourself. Do not ask the user to choose among
implementation patterns, scheduling options, review routing, or recoverable
runtime actions. Create an InputRequest only for a real product choice, new
authority, irreversible external effect, or unavailable external fact.

For implementation investigation, start with the exact candidate/base and the
question to resolve. Locate relevant paths/symbols, inspect their diff and
necessary callers, then widen when evidence reveals another affected boundary.
For logs, retain the full original and read the relevant command/attempt,
failure and surrounding output; a filtered excerpt cannot prove success or
absence of failures. This targeted reading does not replace complete relevant
requirements, formal Worker/Reviewer reports, required Skill instructions, or
the complete final diff. On recovery, refresh changed identities and missing
evidence rather than rereading unrelated history or replaying effects.

Task Messages and the Brief are durable records, not delivery receipts to the
Operator. For a genuinely missing user choice, resource, credential or scope,
use `task input request`; the Controller notifies the Operator through the
existing durable notification path with references to the original records.
Completion and existing blocked-work notifications use that same path. Do not
invent an InputRequest just to announce progress or ask again for authority
already granted. A failed global input call does not mean Task notifications
are broken: a Task Leader must not call global `role message queue`, `steer`
or `role interrupt`, impersonate Operator, or clear identity environment
variables to bypass that boundary.

### Direct delivery with zero WorkItems

The current delivery Leader needs no self-dispatched AgentRun or placeholder
WorkItem. Read the full Task requirements and relevant Messages, then implement,
verify, and fix the coherent result in Task main on its managed branch. Commit
and leave it clean. Run focused checks while changing behavior and the required
Project delivery checks on the final result.

Keep the Brief as a current summary, not a replacement for Task requirements.
Preserve changed intent and reasons in Messages/Decisions, substantial documents
in Task artifacts, and code and verification evidence in the actual delivery.
Zero WorkItems reduces coordination records, not requirements or evidence.

Inspect the complete final diff and decide Review separately. If a Task-final
Review is required or adds useful evidence, request it against the clean Task
heads using `yui task review request <task> --role <reviewer>`. No WorkItem is
needed. Consume the original result, fix reachable findings directly in Task
main, and decide whether the changed result needs another Review. Honor immutable
Review contracts and explicit user/Project requirements even if a default is
disabled. Once the outcome and obligations are satisfied, use `task complete`
with the outcome, checks, and remaining risk; a final chat message is not completion.


For an actual review or completion operation, read [Review](review.md) or
[Completion](completion.md), respectively; their procedures are not prerequisites
for ordinary implementation.

## Extend capabilities within this Task's authority

Use `capability search`, `describe`, and `call` to inspect current tools.
Prefer existing tools, composition or a one-off script when sufficient.
For reusable Task-local capabilities, read [Task plugins](task-plugins.md)
before creation, validation or activation. Plugin management permission does
not grant code execution or broader external effects. Use
[source-authorized capabilities](authorization.md) for existing explicit user
authority. Never invent authorization, impersonate Operator, or modify the core installation to obtain a tool.
