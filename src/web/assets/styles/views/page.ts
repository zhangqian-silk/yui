/*
 * PAGE VIEW — the centred reading column shared by the overview and the task
 * page, its heading scaffolding, and the overview's metric strip and rows.
 * The overview and every task tab are a single column; nothing pairs cards
 * side by side.
 */
export const PAGE_STYLES = `
.page{max-width:var(--center-max);margin:0 auto;padding:0 var(--gutter) 64px}

/* Page scaffolding */
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:36px 0 24px}
.kicker{color:var(--accent);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.1em}
.page-title{margin-top:6px;font-size:var(--fs-2xl);font-weight:650;letter-spacing:-.025em}
.page-sub{margin-top:4px;color:var(--ink-3)}
.page-foot{margin-top:20px;color:var(--ink-4);font-size:var(--fs-xs);text-align:center}
.sub-head{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:var(--fs-sm);font-weight:600}

/* Overview */
.metric-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:16px}
.metric-strip .metric{padding:14px 16px;border-radius:var(--r-lg)}
.metric-strip .metric-value{font-size:var(--fs-2xl)}
.row-list{display:grid;gap:2px;margin:-4px -8px}
.list-row{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:7px 8px;border:0;border-radius:var(--r-sm);background:transparent;color:var(--ink);text-align:left;font-size:var(--fs-sm)}
.list-row:hover:not(:disabled){background:var(--surface-3)}
.list-row:disabled{opacity:.45;cursor:default}
.list-row[aria-pressed="true"]{background:var(--accent-soft)}
.list-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list-row-count{font-weight:600;font-variant-numeric:tabular-nums}
.list-row-go{display:inline-flex;align-items:center;gap:2px;color:var(--accent);font-size:var(--fs-xs);font-weight:500}
.list-row-wrap{flex-wrap:wrap}
.list-row-wrap .chip-row{flex-basis:100%}
`;
