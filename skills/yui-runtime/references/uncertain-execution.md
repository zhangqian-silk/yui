# Unknown execution and unavailable Controller

Read for unknown delivery, an unavailable Controller or failed exact cleanup.
Apply the common boundaries in [Runtime recovery](recovery.md) first.

## Handle uncertainty and failed cleanup

Never replay a notification whose acceptance is unknown. After evidence
establishes shared-native quiescence, an authorized supervisor can use:

```sh
yui task wake resolve <task> <wake> --reason "<quiescence evidence>"
```

This releases only the claim, preserves the original unknown record, and lets
independent later inputs proceed. It neither asserts acceptance nor implements
the Message. Uncertain native activity still blocks conflicting execution;
unrelated authorized local work can continue.

If the Controller is unresponsive, an authorized Operator can use
`controller status` and explicit `controller restart` without a successful
preliminary RPC. Preserve the resource and restart authorization boundary.
If exact native stop or inspection fails, read the persisted diagnostic and
resolve that resource boundary; do not kill arbitrary processes, clear unknown
execution records, or modify managed refs, tmux Sessions or state files.

After repeated failure of the same bounded recovery, report the observed
cause, impact and smallest remaining options. Do not broaden cleanup or add
a private retry loop. A failed recovery does not erase the pending requirement.
