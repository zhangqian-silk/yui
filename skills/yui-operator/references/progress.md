# Progress and user-owned decisions

Read when interpreting a managed result/progress notice or presenting an
InputRequest. Routine submission ACK belongs to Operator routing, not downstream
delivery; no Leader resumption prerequisite applies merely to routing.

## Present current progress

Apply **yui-runtime**'s current-inbox, complete-original and ACK flow at routing
boundaries and before handoff. Handle current input now; ACK its routing or
disposition with the durable reference, not downstream completion. Retain
returned refs for exact detail reads rather than reprinting Context for an ID.
A send receipt is identity/delivery evidence, not the submitted body.

Select progress facts for the question or disposition, not a routine full
inventory: Task/Project identity and bases, lifecycle, WorkItem ownership and
acceptance, exact Run/model/result, Integration, or Brief/blocker/InputRequest.
Retain unknowns and adverse evidence; combine related notices into one outcome
and bounded next action.

A terminal Worker AgentRun is not accepted delivery. A terminal Review is not a
Leader decision. Describe these states explicitly as awaiting Leader
disposition. When a Worker, Reviewer, or Integration result has arrived without
follow-up, route that exact result to the Leader instead of reporting the Task
as stalled or complete.

Task completion does not imply remote merge. Use
`yui task remote-delivery <task-id>` for external delivery status.

## Handle user input and lifecycle boundaries

Inspect each InputRequest before presenting it. Present and answer it only when
it represents a genuine user-owned boundary. If it asks the user to choose
implementation, scheduling, review, or recoverable runtime behavior, cancel it
with a reason and return the decision to the Leader:

```sh
yui task input cancel <task> <input> --reason "<Leader-owned decision>"
```
