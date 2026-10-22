// Jobs: one calm, dense surface. Hairline separators instead of nested cards,
// the workbench's own list head and "new" action, a two-line index, a scannable Run table and a properties
// column. Only shared tokens (ink, line, surface, tone, radius, type scale).
export const JOBS_STYLES = `
.jobs-manager { min-width: 0; display: grid; gap: 14px; container-type: inline-size; }
.jobs-manager [hidden] { display: none !important; }
.jobs-manager textarea { width: 100%; font-family: var(--font-mono); font-size: var(--fs-xs); }
.jobs-manager .settings-observation { max-width: 100%; max-height: 420px; margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: var(--fs-xs); }
.jobs-manager .btn { height: 30px; padding: 0 11px; }
.jobs-layout { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); gap: 20px; align-items: start; }
.jobs-list, .jobs-detail { display: grid; gap: 12px; min-width: 0; }

/* Page bar */
.jobs-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; min-width: 0; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.jobs-bar-title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.jobs-bar-title h1, .jobs-bar-title h2 { font-size: var(--fs-lg); font-weight: 650; letter-spacing: -.01em; }
.jobs-bar-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
.jobs-bar-actions .settings-receipt { margin: 0 6px 0 0; color: var(--ink-4); font-size: var(--fs-xs); white-space: pre-line; }
.jobs-bar-actions .settings-receipt:empty { display: none; }
.jobs-bar-actions .settings-receipt.settings-error { order: 9; flex-basis: 100%; margin: 4px 0 0; padding: 8px 10px; border-radius: var(--r-sm); background: var(--bad-soft); color: var(--bad); text-align: left; }
.jobs-receipt .settings-receipt { margin: 0; color: var(--ink-3); font-size: var(--fs-xs); white-space: pre-line; }
.jobs-receipt .settings-receipt:empty, .jobs-receipt:has(.settings-receipt:empty) { display: none; }
.jobs-receipt .settings-receipt.settings-error { padding: 8px 10px; border-radius: var(--r-sm); background: var(--bad-soft); color: var(--bad); }
.job-notice { margin: 0; padding: 8px 12px; border-radius: var(--r-sm); background: var(--surface-3); color: var(--ink-2); font-size: var(--fs-sm); }

/* Job index (left rail): two lines per Job, status at the right edge. */
.jobs-area .jobs-index { display: grid; gap: 10px; min-width: 0; padding-top: 2px; }
.jobs-area .side-create { margin-bottom: 2px; }
/* The area title stays whole beside the Jobs sync; a long clock gives way. */
.manage-rail .side-head:has(#jobs-sync:not([hidden])) .side-title { flex: none; }
#jobs-sync { min-width: 0; overflow: hidden; white-space: nowrap; }
#jobs-sync time { overflow: hidden; text-overflow: ellipsis; }
.jobs-scope { display: grid; gap: 4px; padding: 0 2px; }
.jobs-scope label { color: var(--ink-4); font-size: var(--fs-2xs); font-weight: 600; text-transform: uppercase; letter-spacing: .07em; }
.jobs-scope select { width: 100%; min-width: 0; height: 32px; padding-top: 4px; padding-bottom: 4px; font-size: var(--fs-sm); }
.jobs-scope-help { margin: 0; color: var(--ink-4); font-size: var(--fs-2xs); line-height: 1.4; }
.jobs-scope-help.is-error, .jobs-index-empty.is-error { color: var(--bad); }
.jobs-index-body { display: grid; gap: 8px; min-width: 0; }
.jobs-index-tools { display: grid; gap: 6px; }
.jobs-index-tools .search-field input { width: 100%; height: 32px; font-size: var(--fs-sm); }
.jobs-index-count { margin: 0; padding: 0 2px; color: var(--ink-4); font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; }
.jobs-index-empty { margin: 0; padding: 24px 12px; color: var(--ink-4); font-size: var(--fs-sm); text-align: center; }
.jobs-list { gap: 1px; }
.job-row { position: relative; display: flex; align-items: flex-start; gap: 9px; width: 100%; min-width: 0; padding: 7px 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background var(--t-fast); }
.job-row > .dot { margin-top: 6px; }
.job-row:hover { background: var(--surface-3); }
.job-row[aria-current="true"] { background: var(--surface-3); }
.job-row[aria-current="true"] .job-row-name { font-weight: 600; }
.job-row-body { display: grid; gap: 1px; flex: 1; min-width: 0; }
.job-row-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.job-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); font-size: var(--fs-sm); font-weight: 500; line-height: 1.45; }
.job-row-line > .badge { flex: none; height: 18px; padding: 0 6px; font-size: var(--fs-2xs); }
.job-row-sub { color: var(--ink-4); font-size: var(--fs-2xs); }
.job-row-sub > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-row-type { flex: none; max-width: 50%; color: var(--ink-3); }
.job-row-plan { flex: 1; }
.job-row-plan::before { content: "·"; margin-right: 6px; color: var(--ink-4); }
.job-row-none { flex: none; color: var(--ink-4); font-size: var(--fs-2xs); }

/* Focus is always visible. */
.job-row:focus-visible, .job-run-row:focus-visible, .job-copy:focus-visible, .job-more:focus-visible,
.job-section-action:focus-visible, .job-raw > summary:focus-visible, .job-log > summary:focus-visible, .job-fold > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; box-shadow: none; }

/* Job header */
.job-page { display: grid; gap: 16px; min-width: 0; }
.job-header { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 10px 16px; min-width: 0; }
.job-title { display: grid; gap: 6px; flex: 1 1 360px; min-width: 0; }
.job-title h2 { font-size: var(--fs-xl); font-weight: 650; letter-spacing: -.015em; line-height: 1.25; overflow-wrap: anywhere; }
.job-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.job-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 0; color: var(--ink-3); font-size: var(--fs-xs); }
.job-meta-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.job-meta-item + .job-meta-item::before { content: "·"; margin: 0 8px; color: var(--ink-4); }
.job-meta a { color: inherit; }
.job-actions { display: flex; flex-wrap: wrap; gap: 6px; flex: none; }
.job-note { margin: 0; color: var(--ink-4); font-size: var(--fs-xs); line-height: 1.5; }
.job-note.is-error { color: var(--bad); }

/* Overview strip: numbers first, the last 30 Runs as a status strip. */
.job-overview { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); }
.job-stats { display: flex; flex-wrap: wrap; gap: 10px 0; min-width: 0; }
.job-stat { display: grid; align-content: start; gap: 2px; min-width: 0; padding: 0 18px; border-left: 1px solid var(--line); }
.job-stat:first-child { padding-left: 0; border-left: 0; }
.job-stat-label { color: var(--ink-4); font-size: var(--fs-2xs); white-space: nowrap; }
.job-stat-value { color: var(--ink); font-size: var(--fs-lg); font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; }
.job-stat-sub { color: var(--ink-4); font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.job-stat-run { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; min-height: 26px; }
.job-stat-run code { font-size: var(--fs-xs); color: var(--ink-2); }
.job-stat-run .badge { height: 20px; padding: 0 7px; font-size: var(--fs-2xs); }
.job-spark { display: flex; align-items: stretch; gap: 2px; height: 26px; }
.job-spark-bar { width: 6px; border-radius: 2px; background: var(--tone, var(--line-3)); opacity: .9; }
.job-spark-bar.tone-idle { background: var(--line-3); }

/* About the Job: description and configuration | plans and definition */
.job-purpose { display: flex; align-items: flex-start; gap: 4px; min-width: 0; padding: 10px 6px 10px 12px; border-left: 2px solid var(--line-3); border-radius: 0 var(--r-sm) var(--r-sm) 0; background: var(--surface-3); }
.job-purpose .job-prose { flex: 1; max-height: 180px; line-height: 1.6; }
.job-purpose.is-note { display: block; margin: 0; padding: 8px 12px; color: var(--ink-2); font-size: var(--fs-sm); }
.job-about { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 300px); gap: 24px; align-items: start; min-width: 0; }
.job-primary, .job-aside { display: grid; gap: 22px; min-width: 0; }
.job-section { display: grid; gap: 8px; min-width: 0; }
.job-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 26px; }
.job-section-head h4 { color: var(--ink-2); font-size: var(--fs-sm); font-weight: 600; }
.job-section-count { color: var(--ink-4); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.job-section-title { margin: 6px 0 0; color: var(--ink-3); font-size: var(--fs-xs); font-weight: 600; }
.job-section-action { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 8px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--ink-3); font-size: var(--fs-xs); font-weight: 500; }
.job-section-action:hover { background: var(--surface-3); color: var(--ink); }
.job-section-action .icon { width: 14px; height: 14px; }
.job-empty-block { margin: 0; padding: 14px 12px; border: 1px dashed var(--line-2); border-radius: var(--r-md); color: var(--ink-4); font-size: var(--fs-sm); text-align: center; }
.job-blank { display: grid; justify-items: center; gap: 10px; padding: 64px 16px; color: var(--ink-4); text-align: center; }

/* Run history: a table on wide containers, two lines on narrow ones. */
.job-history { display: grid; gap: 8px; min-width: 0; }
.job-filters { gap: 4px; }
.job-filters .chip-tab { height: 26px; padding: 0 9px; }
.job-filters .count { color: inherit; opacity: .7; font-variant-numeric: tabular-nums; }
.job-history-body { border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; background: var(--surface); }
.job-runs-head, .job-run-row { display: grid; grid-template-columns: 104px minmax(0, 1fr) 112px 72px 16px; align-items: center; gap: 12px; }
.job-runs-head { padding: 6px 12px; border-bottom: 1px solid var(--line); color: var(--ink-4); font-size: var(--fs-2xs); font-weight: 500; }
.job-runs-head > :nth-child(n+3), .job-run-when, .job-run-span { text-align: right; }
.jobs-runs { display: grid; }
.job-run-row { scroll-margin-top: calc(var(--header-h, 56px) + 12px); width: 100%; min-width: 0; padding: 7px 12px; border: 0; border-top: 1px solid var(--line); background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background var(--t-fast); }
.jobs-runs > .job-run-row:first-child { border-top: 0; }
.job-run-row:hover { background: var(--surface-3); }
.job-run-row[aria-current="true"] { background: var(--surface-3); box-shadow: inset 2px 0 0 var(--accent); }
.job-run-caret { display: inline-grid; place-items: center; color: var(--ink-4); }
.job-run-caret .icon { width: 14px; height: 14px; transition: transform var(--t-fast); }
.job-run-row[aria-expanded="true"] .job-run-caret .icon { transform: rotate(90deg); color: var(--ink-2); }
.job-run-status .badge { height: 20px; padding: 0 7px; font-size: var(--fs-2xs); }
.job-run-main { display: grid; gap: 1px; min-width: 0; }
.job-run-summary { overflow: hidden; color: var(--ink); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.job-run-sub { display: flex; gap: 8px; min-width: 0; color: var(--ink-4); font-size: var(--fs-2xs); white-space: nowrap; }
.job-run-sub code { color: var(--ink-3); }
.job-run-when, .job-run-span { color: var(--ink-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.job-more { width: 100%; padding: 8px 12px; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--ink-3); font-size: var(--fs-xs); font-weight: 500; }
.job-more:hover { background: var(--surface-3); color: var(--ink); }

/* Selected Run: opened in place, directly under its row */
.job-run-inline { padding: 4px 12px 14px; border-top: 1px dashed var(--line); background: var(--surface-3); box-shadow: inset 2px 0 0 var(--accent); }
.jobs-runs > .job-run-inline:first-child { border-top: 0; }
.job-run-inline .job-run-panel { border-color: var(--line); box-shadow: var(--shadow-1); }
.job-run-inline:empty, .job-run-panel > section:empty, .job-run-artifacts > div:empty { display: none; }
.job-run-panel > .job-kv { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 24px; }
.job-run-panel > .job-kv > .job-kv-row:nth-child(2) { border-top: 0; }
.job-run-panel { display: grid; gap: 12px; min-width: 0; padding: 14px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--surface); }
.job-run-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.job-run-head > .job-badges { flex: none; flex-wrap: nowrap; }
.job-run-title { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; min-height: 28px; }
.job-run-title h4 { font-size: var(--fs-sm); font-weight: 600; }
.job-run-close { width: 28px; height: 28px; }
.job-result { margin: 0; padding: 8px 10px; border-left: 2px solid var(--tone, var(--line-3)); border-radius: 0 var(--r-sm) var(--r-sm) 0; background: var(--tone-soft, var(--surface-3)); color: var(--ink); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.job-result-label { margin-right: 8px; color: var(--ink-3); font-size: var(--fs-xs); font-weight: 600; }
.job-run-steps { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: var(--r-sm); }
.job-run-step { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 6px 10px; border-top: 1px solid var(--line); font-size: var(--fs-xs); }
.job-run-step:first-child { border-top: 0; }
.job-run-step .badge { height: 20px; font-size: var(--fs-2xs); }
.job-run-step-meta { margin-left: auto; color: var(--ink-4); font-variant-numeric: tabular-nums; }
.job-logs { display: grid; gap: 6px; }
.job-log { border: 1px solid var(--line); border-radius: var(--r-sm); }
.job-log > summary { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: var(--fs-xs); cursor: pointer; }
.job-log-text { max-height: 320px; margin: 0; padding: 10px; overflow: auto; border-top: 1px solid var(--line); background: var(--sunken); font-size: var(--fs-2xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.job-artifact-list { display: flex; flex-wrap: wrap; gap: 6px; }
.job-inline-action { justify-self: start; height: 26px !important; padding: 0 8px !important; color: var(--ink-3); font-size: var(--fs-xs); }
.job-run-evidence, .job-run-artifacts { display: grid; gap: 6px; min-width: 0; }
.job-advanced { display: grid; gap: 6px; }

/* Label/value lists (configuration, definition, Run facts) */
.job-kv { display: grid; margin: 0; min-width: 0; }
.job-kv-row { display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 12px; padding: 6px 0; border-top: 1px solid var(--line); font-size: var(--fs-sm); }
.job-kv-row:first-child { border-top: 0; }
.job-kv dt { color: var(--ink-4); font-size: var(--fs-xs); line-height: 1.7; overflow-wrap: anywhere; }
.job-kv dd { margin: 0; min-width: 0; color: var(--ink); overflow-wrap: anywhere; }
.job-kv.is-compact .job-kv-row { grid-template-columns: 84px minmax(0, 1fr); padding: 5px 0; }
.job-kv.is-nested { padding-left: 10px; border-left: 2px solid var(--line); }
.job-kv.is-nested .job-kv-row { grid-template-columns: minmax(80px, 120px) minmax(0, 1fr); padding: 3px 0; border-top: 0; }
.job-key { color: var(--ink-3); font-size: var(--fs-xs); }
.job-empty { color: var(--ink-4); }
.job-muted { color: var(--ink-4); font-size: var(--fs-xs); }
.job-text { white-space: pre-wrap; }
.job-kind { font-weight: 600; }
.job-prose { max-height: 240px; margin: 0; overflow: auto; color: var(--ink); font-family: inherit; font-size: var(--fs-sm); white-space: pre-wrap; overflow-wrap: anywhere; }
.job-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.job-chip { padding: 1px 6px; border-radius: var(--r-xs); background: var(--surface-3); color: var(--ink-2); font-size: var(--fs-2xs); overflow-wrap: anywhere; }
.job-chip-key { color: var(--ink); font-weight: 600; }
.job-list { margin: 0; padding-left: 18px; }
.job-fold > summary { color: var(--ink-3); font-size: var(--fs-xs); cursor: pointer; }
.job-time { display: inline-flex; flex-wrap: wrap; gap: 0 8px; font-variant-numeric: tabular-nums; }
.job-time-ago { color: var(--ink-4); font-size: var(--fs-xs); }
.job-id, .job-path { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; min-width: 0; }
.job-path code { min-width: 0; overflow-wrap: anywhere; font-size: var(--fs-xs); }
.job-copy { display: inline-grid; place-items: center; width: 22px; height: 22px; flex: none; padding: 0; border: 0; border-radius: var(--r-xs); background: transparent; color: var(--ink-4); }
.job-copy:hover { background: var(--surface-3); color: var(--ink); }
.job-copy .icon { width: 13px; height: 13px; }
.job-copy.is-copied { color: var(--ok); }
.job-copy-text { display: inline-flex; align-items: center; width: auto; gap: 4px; padding: 0 6px; font-size: var(--fs-2xs); white-space: nowrap; }

/* Configuration: steps as numbered rows with their command */
.job-config { display: grid; gap: 14px; min-width: 0; }
.job-steps { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
.job-step { display: grid; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--line); min-width: 0; }
.job-step:first-child { border-top: 0; }
.job-step-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.job-step-index { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: var(--r-pill); background: var(--surface-3); color: var(--ink-3); font-size: var(--fs-2xs); font-weight: 600; font-variant-numeric: tabular-nums; }
.job-step-name { color: var(--ink); font-size: var(--fs-xs); font-weight: 600; }
.job-tag { max-width: 100%; padding: 0 6px; border: 1px solid var(--line-2); border-radius: var(--r-xs); color: var(--ink-3); font-size: var(--fs-2xs); line-height: 18px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-command { display: flex; align-items: flex-start; gap: 4px; min-width: 0; padding: 6px 6px 6px 10px; border-radius: var(--r-sm); background: var(--sunken); }
.job-command pre { flex: 1; min-width: 0; margin: 0; padding-top: 2px; color: var(--ink); font-size: var(--fs-xs); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.job-command.is-prose pre { font-family: inherit; font-size: var(--fs-sm); }
.job-step-env { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.job-step-label { color: var(--ink-4); font-size: var(--fs-2xs); }

/* Exact JSON, one disclosure away */
.job-raw { position: relative; min-width: 0; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface); overflow: hidden; }
.job-raw > summary { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 7px 110px 7px 12px; color: var(--ink-3); font-size: var(--fs-xs); cursor: pointer; list-style: none; }
.job-raw > summary::before { content: "›"; font-size: 16px; line-height: 1; transform-origin: center; }
.job-raw[open] > summary::before { transform: rotate(90deg); }
.job-raw > summary:hover { color: var(--ink); }
.job-raw-hint { padding: 0 5px; border: 1px solid var(--line-2); border-radius: var(--r-xs); color: var(--ink-4); font-family: var(--font-mono); font-size: 10px; line-height: 16px; }
.job-raw-body { min-width: 0; border-top: 1px solid var(--line); }
.job-raw-tools { position: absolute; right: 8px; top: 4px; display: flex; }
.job-raw .settings-observation { display: block; margin: 0; padding: 14px; max-height: 320px; overflow: auto; background: var(--sunken); color: var(--ink-2); font: var(--fs-xs)/1.65 var(--font-mono); white-space: pre; tab-size: 2; }
.job-form-advanced { min-width: 0; color: var(--ink-3); font-size: var(--fs-xs); }
.job-form-advanced > summary { cursor: pointer; padding: 8px 0; }
.job-form-advanced[open] > :not(summary) { margin-top: 8px; }
.job-form-advanced .job-raw { margin-top: 10px; }
.job-form-advanced:has(:focus-visible), .job-raw > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Plans */
.job-plans { display: grid; margin: 0; padding: 0; list-style: none; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); }
.job-plan { display: grid; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); min-width: 0; }
.job-plan:first-child { border-top: 0; }
.job-plan-main { display: grid; gap: 4px; min-width: 0; }
.job-plan-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
.job-plan-line .badge { height: 20px; padding: 0 7px; font-size: var(--fs-2xs); }
.job-plan-rule { font-size: var(--fs-sm); font-weight: 600; }
.job-plan-exact { color: var(--ink-4); font-family: var(--font-mono); font-size: var(--fs-2xs); overflow-wrap: anywhere; }
.job-plan-sub { color: var(--ink-4); font-size: var(--fs-2xs); }
.job-plan-sub code { color: var(--ink-3); overflow-wrap: anywhere; }
.job-plan-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.job-plan-actions .btn { height: 26px; padding: 0 8px; font-size: var(--fs-xs); }

/* Editor (a modal dialog, as the workbench's new Task) */
.job-dialog { width: min(760px, calc(100vw - 32px)); }
.job-dialog .job-form { gap: 14px; }
.job-dialog .dialog-actions { position: sticky; bottom: -20px; margin: 0 -20px -20px; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--surface); }
.job-dialog-receipt { margin: 0; color: var(--ink-3); font-size: var(--fs-xs); white-space: pre-line; }
.job-dialog-receipt:empty { display: none; }
.job-dialog-receipt.settings-error { padding: 8px 10px; border-radius: var(--r-sm); background: var(--bad-soft); color: var(--bad); }
.job-fieldset { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 12px 0 0; border: 0; border-top: 1px solid var(--line); }
.job-fieldset > legend { padding: 0 8px 0 0; color: var(--ink-2); font-size: var(--fs-sm); font-weight: 600; }
.job-field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 12px; }
.job-field-stack { display: grid; gap: 10px; }
.job-field-stack[hidden], .job-form [hidden] { display: none; }
.job-bound-target { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--r-sm); background: var(--sunken); color: var(--ink-3); font-size: var(--fs-sm); }
.job-bound-target strong { color: var(--ink); font-weight: 500; overflow-wrap: anywhere; }
.job-weekdays { display: flex; flex-wrap: wrap; gap: 6px; }
.job-weekdays .btn { min-width: 38px; height: 34px; padding: 0 10px; }
.job-weekdays .btn[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--surface); }
.job-rule-preview { padding: 10px 12px; margin: 0; border-left: 2px solid var(--accent); background: var(--sunken); color: var(--ink-2); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.job-rule-preview { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; border-radius: var(--r-sm); }
.job-rule-preview.is-error { border-color: var(--bad); color: var(--bad); background: var(--bad-soft); }
.job-plan-expression { color: var(--ink-3); font-size: var(--fs-xs); overflow-wrap: anywhere; }
.job-clock input { font-variant-numeric: tabular-nums; }
.job-time-shortcuts { display: flex; flex-wrap: wrap; gap: 6px; }
.job-time-shortcuts .btn { height: 28px; padding: 0 10px; color: var(--ink-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.job-cron-guide { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin: 0; padding: 12px; gap: 8px; border: 1px solid var(--line); border-radius: var(--r-sm); }
.job-cron-guide dt { color: var(--ink-3); font-size: var(--fs-xs); }
.job-cron-guide dd { display: grid; gap: 6px; margin: 6px 0 0; overflow-wrap: anywhere; }
.job-cron-guide dd span { color: var(--ink-4); font-size: var(--fs-2xs); }
@media (max-width: 480px) {
  .job-cron-guide { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
.job-edit-row { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-sm); min-width: 0; }
.job-edit-row > .btn, .job-field-stack > .btn { justify-self: start; }
.job-form textarea { width: 100%; resize: vertical; min-height: 88px; font-size: var(--fs-sm); }
.job-form input, .job-form select, .job-form textarea { min-width: 0; }
.jobs-manager form .field > span { color: var(--ink-3); font-size: var(--fs-xs); font-weight: 500; }
.jobs-manager form input, .jobs-manager form select { height: 32px; padding-top: 4px; padding-bottom: 4px; font-size: var(--fs-sm); }
.job-config-preview { display: grid; gap: 8px; padding: 12px; border: 1px dashed var(--line-2); border-radius: var(--r-md); }
.job-preview-label { color: var(--ink-4); font-size: var(--fs-2xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }

@media (max-width: 720px) { .jobs-layout { grid-template-columns: minmax(0, 1fr); } }
@container (max-width: 860px) {
  .job-about { grid-template-columns: minmax(0, 1fr); }
}
@container (max-width: 640px) {
  .jobs-layout { grid-template-columns: minmax(0, 1fr); }
  .jobs-bar-refresh > span { display: none; }
  .job-actions { flex-wrap: wrap; }
  .job-overview { padding: 10px 12px; }
  .job-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; width: 100%; }
  .job-stat { padding: 0; border-left: 0; }
  .job-spark { width: 100%; }
  .job-spark-bar { flex: 1; width: auto; max-width: 8px; }
  .job-runs-head { display: none; }
  .job-run-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "main status" "main when"; gap: 2px 10px; padding: 8px 10px; }
  .job-run-caret { display: none; }
  .job-run-inline { padding: 2px 8px 10px; }
  .job-run-status { grid-area: status; justify-self: end; }
  .job-run-main { grid-area: main; }
  .job-run-when { grid-area: when; }
  .job-run-span { display: none; }
  .job-run-summary { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .job-kv-row, .job-kv.is-compact .job-kv-row { grid-template-columns: 92px minmax(0, 1fr); gap: 10px; }
  .job-kv.is-nested .job-kv-row { grid-template-columns: minmax(0, 1fr); }
  .job-run-panel { padding: 12px; }
  .job-run-panel > .job-kv { grid-template-columns: minmax(0, 1fr); }
  .job-run-panel > .job-kv > .job-kv-row:nth-child(2) { border-top: 1px solid var(--line); }
}
`;
