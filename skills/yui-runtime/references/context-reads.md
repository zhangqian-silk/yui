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
  For 1–8 known independent originals in that Task, `task context inspect <task>
  --context-ref <store/refId@digest> ...` returns `items` under the same total
  budget. Repeat the flag for each reference; no JSON quoting is needed.
  `--refs '<JSON array of exact ref objects>'` is another batch form.
  Choose one form: single `--store/--ref/--digest`, repeated `--context-ref`,
  or `--refs`; do not mix them. A stale/unavailable ref rejects the group.
  Follow `contentPage` with the same ordered selection.
  Group needed reads, not the whole directory: reuse unchanged complete bodies
  still available, and fetch missing/changed originals. After loss/compaction,
  reconstruct the current action's working set, not every historical source.
  Task Message current view excludes explicit ACK/retirement, not uncertain
  delivery; default all view is history.
- For wakes read the complete focused input/result view and relevant originals.
  `task wake show <task> <wake>` preserves fixed windows/explicit older refs,
  deduplicates inputs and supplies exact reads. In the focused JSON view, a
  current Leader's `inbox show <wake>` exposes the same view in `originalContext`
  (wake metadata stays at the top level); no second wake read is needed when
  that content is already complete and current. Neither read claims the input.
  In either carrier, a
  message's `contentOmitted: false` and `value` provide its complete current
  original with a versioned `ref`; use that body rather than fetching it again.
  Long messages and result reports retain their exact read; a completion notice
  is not a report. Reconcile later revisions against the fixed wake, not by
  assuming its current value was the originally delivered version. Use `--history`
  only for needed diagnostics/window history; complete pagination in either view.
  Ordinary disposition needs no unrelated events or merely started Runs.
  Event deltas are fixed-upper-bound history, not replacement current state.
- A result Message's `context inspect` carries the report, when available, in
  `result.output` beside `value` (per item in a batch). The Message body may be
  only a completion notice; a `Yui-Summary:` first line does not make the whole
  report a summary. Finish any `contentPage` before using it.
  `task message show <task/message>` and `task run show <task>/<run> --view result`
  are alternative complete-report reads, not follow-up steps after obtaining
  that same report. Use Run `--view full` when input/launch audit facts are needed.
  Result is the original, not a summary; finish its pages. Read additional
  execution facts only when needed: `task run show <task>/<run> --view status --json`
  omits input/report bodies. Status/report receipt is not semantic acceptance.
