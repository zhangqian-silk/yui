# Complete context reads

Read when discovering missing context, following a wake/result pointer, or
assembling paginated original bodies. Ordinary complete originals need no
additional discovery. This is an operation manual, not a turn-entry dependency.

Read every relevant original requirement/result/authorization page before its
decision. CLI JSON is in top-level `data`, not encoded `output`. Lists expose
`items`, `total`, `complete`, `nextCursor`; summaries/first pages are not full
bodies. The 32 KiB compact-JSON budget includes nested structure/cursors, with
summaries limited to 512 UTF-8 bytes. Skill checks are metadata-only but paginate
when large. Discover only what is needed, not all history.

Long reads replace the value with `contentPage` (Run context/expand:
`data.context`; delta: `data.contextDelta`). Repeat the same read using
`--cursor <nextCursor>` until complete, concatenate `text` by offset and parse
once under the same source/digest. Restart on source change; never mix chunks
or use read cursors for mutation. Reads neither consume queues nor acknowledge
implementation or authorize replay.

- Task current Context holds bounded facts/Message refs, not event/terminal Run
  history. `collections`/`attention` flag incomplete discovery: use
  `task context list <task> --store <store> [--cursor <cursor>]`, then
  `task context inspect <task> --store <store> --ref <refId> --digest <digest>`.
  Task Message current view excludes explicit ACK/retirement, not uncertain
  delivery; default all view is history.
- For wakes read the complete focused input/result view and relevant originals.
  `task wake show <task> <wake>` preserves fixed windows/explicit older refs,
  deduplicates inputs and supplies exact reads, not full reports. Use `--history`
  only for needed diagnostics/window history; complete pagination in either view.
  Ordinary disposition needs no unrelated events or merely started Runs.
  Event deltas are fixed-upper-bound history, not replacement current state.
- Read results through exact Message/Run originals, not producer copies/resends
  (`task message show <task/message>` follows result Messages). For additional
  execution facts, `task run show <task>/<run> --view status --json` omits
  input/report bodies and points to audit reads; status is not result/acceptance.
  Reuse immutable evidence only while its full body remains available; reread
  after loss/compaction, not for every representation.
