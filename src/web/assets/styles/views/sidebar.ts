/*
 * SIDEBAR VIEW — the task index: brand and sync state, search, attention
 * pills, status filter tabs, grouped task rows, the catalog pager and the
 * footer buttons. Region sizing lives in layout/workspace.
 */
export const SIDEBAR_STYLES = `
/* Brand and sync state */
.brand-mark{width:28px;height:28px;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:15px;font-weight:700;line-height:1}
.brand-name{font-size:var(--fs-lg);font-weight:650;letter-spacing:-.02em}
.sync{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:var(--r-pill);background:var(--surface-3);color:var(--ink-3);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.sync i{width:6px;height:6px;border-radius:50%;background:var(--ink-4)}
.sync[data-state="ok"] i{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}
.sync[data-state="syncing"] i{background:var(--info);animation:blink 1s ease-in-out infinite}
.sync[data-state="error"] i{background:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}
.sync[data-state="error"]{color:var(--bad)}
@keyframes blink{50%{opacity:.35}}

/* Search and attention filters */
.search-field{position:relative;display:flex;align-items:center;flex:none;margin:12px 12px 0}
.search-field>.icon{position:absolute;left:10px;color:var(--ink-4);pointer-events:none}
.search-field input{height:34px;padding:0 34px 0 32px;border-radius:var(--r-md);background:var(--surface-2)}
.search-field input::-webkit-search-cancel-button{display:none}
.search-field kbd{position:absolute;right:8px}
.attention-list{display:flex;flex-wrap:wrap;gap:6px}
.attention-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid transparent;border-radius:var(--r-pill);background:var(--tone-soft);color:var(--tone);font-size:var(--fs-xs);font-weight:500}
.attention-pill b{font-weight:700;font-variant-numeric:tabular-nums}
.attention-pill:hover{border-color:var(--tone)}
.attention-pill[aria-pressed="true"]{background:var(--tone);color:var(--canvas)}
.attention-clear{display:flex;align-items:center;gap:6px;color:var(--ink-4);font-size:var(--fs-xs)}
.attention-clear .icon{color:var(--ok)}

/* Status filter tabs (the strip itself is a ui/controls .tabs-row) */
.status-tab{position:relative;display:inline-flex;align-items:center;gap:5px;flex:none;height:32px;padding:0 8px;border:0;background:transparent;color:var(--ink-3);font-size:var(--fs-xs);font-weight:500;white-space:nowrap}
.status-tab:hover{color:var(--ink)}
.status-tab[aria-pressed="true"]{color:var(--ink)}
.status-tab[aria-pressed="true"]::after{left:6px;right:6px;bottom:-3px}
.status-tab-count{color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}

/* Task groups and rows */
.task-group{margin-top:8px}
.task-group-head{display:flex;align-items:center;gap:6px;padding:4px 8px 4px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em}
.task-group-head .count{background:transparent;padding:0;min-width:0}
.task-row{position:relative;display:flex;align-items:flex-start;gap:9px;width:100%;padding:7px 10px;border:0;border-radius:var(--r-md);background:transparent;text-align:left;transition:background var(--t-fast)}
.task-row>.dot{margin-top:5px}
.task-row:hover{background:var(--surface-3)}
.task-row[aria-current="true"]{background:var(--surface-3);box-shadow:inset 0 0 0 1px var(--line-2)}
.task-row[aria-current="true"]::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.task-body{display:grid;gap:1px;flex:1;min-width:0}
.task-line{display:flex;align-items:center;gap:8px;min-width:0}
.task-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:var(--fs-md);font-weight:500;line-height:1.35}
.task-time{flex:none;color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.task-sub{gap:8px;height:18px;color:var(--ink-4);font-size:var(--fs-2xs)}
.task-id{font-size:var(--fs-2xs);line-height:1;color:var(--ink-3)}
.task-count{display:inline-flex;align-items:center;gap:3px;line-height:1;white-space:nowrap}
.task-count .icon{width:11px;height:11px}
.task-signals{display:inline-flex;gap:4px;margin-left:auto}
.signal{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;border-radius:var(--r-pill);background:var(--tone-soft);color:var(--tone);font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
.signal .icon{width:11px;height:11px;stroke-width:2}
.list-empty{display:grid;justify-items:center;gap:8px;padding:36px 16px;color:var(--ink-4);font-size:var(--fs-sm);text-align:center}
.list-empty.is-error{color:var(--bad)}

/* Catalog pager and footer */
.pager-btn{height:28px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:transparent;color:var(--ink-2);font-size:var(--fs-xs)}
.pager-btn:hover:not(:disabled){border-color:var(--line-3);color:var(--ink)}
.pager-btn:disabled{opacity:.4}
.pager-count{grid-column:2;text-align:center;color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.pager-clear{height:28px}
.foot-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 8px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:transparent;color:var(--ink-2);font-size:var(--fs-xs);font-weight:500;min-width:0}
.foot-btn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot-btn:hover{color:var(--ink);border-color:var(--line-3);background:var(--surface-3)}
.foot-btn[aria-pressed="true"]{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.foot-btn kbd{margin-left:2px}
.side-foot .icon-btn{margin-left:auto}
`;
