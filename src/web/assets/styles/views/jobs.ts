export const JOBS_STYLES = `
.jobs-manager { min-width: 0; display: grid; gap: 16px; container-type: inline-size; }
.jobs-layout { display: grid; grid-template-columns: minmax(160px, 240px) minmax(0, 1fr); gap: 24px; align-items: start; }
.jobs-list, .jobs-detail, .jobs-runs { display: grid; gap: 12px; min-width: 0; }
.jobs-manager .settings-actions { flex-wrap: wrap; }
.jobs-manager .settings-observation { max-width: 100%; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.jobs-manager .btn, .job-fact { overflow-wrap: anywhere; white-space: normal; text-align: left; }
.jobs-manager textarea { width: 100%; font-family: var(--font-mono); }
.jobs-manager [hidden] { display: none !important; }
/* The Job index: one scope's Jobs as compact rows, mirroring the Task list. */
.jobs-area .jobs-index { display: grid; gap: 10px; min-width: 0; }
.jobs-scope { display: grid; gap: 4px; padding: 0 2px; }
.jobs-scope label { color: var(--ink-4); font-size: var(--fs-2xs); font-weight: 600; text-transform: uppercase; letter-spacing: .07em; }
.jobs-scope select { width: 100%; min-width: 0; }
.jobs-scope-help { margin: 0; color: var(--ink-4); font-size: var(--fs-2xs); line-height: 1.4; }
.jobs-scope-help.is-error, .jobs-index-empty.is-error { color: var(--bad); }
.jobs-index-body { display: grid; gap: 8px; min-width: 0; }
.jobs-index-tools { display: grid; gap: 6px; }
.jobs-index-tools .search-field input { width: 100%; }
.jobs-index-count { margin: 0; padding: 0 2px; color: var(--ink-4); font-size: var(--fs-2xs); font-variant-numeric: tabular-nums; }
.jobs-index-empty { margin: 0; padding: 24px 12px; color: var(--ink-4); font-size: var(--fs-sm); text-align: center; }
.jobs-list { gap: 2px; }
.job-row { position: relative; display: flex; align-items: flex-start; gap: 9px; width: 100%; min-width: 0; padding: 7px 10px; border: 0; border-radius: var(--r-md); background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background var(--t-fast); }
.job-row > .dot { margin-top: 5px; }
.job-row:hover { background: var(--surface-3); }
.job-row[aria-current="true"] { background: var(--surface-3); box-shadow: inset 0 0 0 1px var(--line-2); }
.job-row[aria-current="true"]::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); }
.job-row:focus-visible, .job-run-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.job-row-body { display: grid; gap: 2px; flex: 1; min-width: 0; }
.job-row-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.job-row-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); font-size: var(--fs-md); font-weight: 500; line-height: 1.35; }
.job-row-sub { color: var(--ink-4); font-size: var(--fs-2xs); }
.job-row-sub > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-row-sub code { color: var(--ink-3); }
.job-row-plan { flex: 1; }
.job-row-sub > .job-row-none, .job-row-sub > .badge { flex: none; margin-left: auto; overflow: visible; }
.job-row-none { color: var(--ink-4); font-size: var(--fs-2xs); }

/* Job detail: definition, plan and execution kept visibly apart. */
.job-notice { margin: 0; padding: 10px 12px; border: 1px solid var(--line-2); border-radius: var(--r-md); background: var(--surface-3); color: var(--ink-2); font-size: var(--fs-sm); }
.job-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; min-width: 0; }
.job-head > h3, .job-head > h4 { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.job-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.job-block { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-md); }
.job-block > h4 { margin: 0; color: var(--ink-3); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.job-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px 16px; }
.job-fact { display: grid; gap: 1px; min-width: 0; font-size: var(--fs-sm); }
.job-fact-label { color: var(--ink-4); font-size: var(--fs-2xs); }
.job-fact-value { color: var(--ink); overflow-wrap: anywhere; }
.job-note { margin: 0; color: var(--ink-4); font-size: var(--fs-xs); }
.jobs-runs { gap: 2px; }
.job-run-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; width: 100%; padding: 6px 10px; border: 0; border-radius: var(--r-md); background: transparent; color: inherit; text-align: left; cursor: pointer; }
.job-run-row:hover, .job-run-row[aria-current="true"] { background: var(--surface-3); }
.job-run-row code { font-size: var(--fs-xs); overflow-wrap: anywhere; }
.job-run-meta { color: var(--ink-4); font-size: var(--fs-2xs); }
@media (max-width: 720px) { .jobs-layout { grid-template-columns: minmax(0, 1fr); } }
@container (max-width: 640px) {
  .jobs-layout { grid-template-columns: minmax(0, 1fr); }
}
`;
