/*
 * TASK VIEW — the task page frame and its Overview tab: the sticky header and
 * section tabs, the hero, the "now" banner, input requests that need the
 * user, decisions and planning. Rows inside the other tabs live in
 * views/records and views/delivery.
 */
export const TASK_STYLES = `
/* Sticky header and tab strip: both bleed through the page gutter and frost
   the content scrolling beneath them. */
.task-header,.tabs-wrap{position:sticky;margin:0 calc(-1 * var(--gutter));padding:0 var(--gutter);background:color-mix(in srgb,var(--canvas) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px)}
.task-header{top:0;z-index:10}
.task-bar{display:flex;align-items:center;gap:6px;height:var(--header-h)}
.back-btn{display:none}
.crumbs{display:flex;align-items:center;gap:6px;min-width:0;font-size:var(--fs-sm)}
.crumb{padding:3px 6px;border:0;border-radius:var(--r-xs);background:transparent;color:var(--ink-3)}
.crumb:hover{color:var(--ink);background:var(--surface-3)}
.crumb-sep{color:var(--ink-4)}
.crumb-current{color:var(--ink-2);font-size:var(--fs-xs)}
.dock-toggle{height:30px}
.task-hero{padding:14px 0 18px}
.task-title{font-size:var(--fs-2xl);font-weight:650;letter-spacing:-.025em;line-height:1.25;overflow-wrap:anywhere}
.task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;color:var(--ink-3);font-size:var(--fs-xs)}
.task-meta:empty{display:none}
.meta-item{display:inline-flex;align-items:center;gap:5px}
.meta-item .when{font-size:inherit}
.tabs-wrap{top:var(--header-h);z-index:9;border-bottom:1px solid var(--line)}
.tabs{gap:4px}
.tab{position:relative;display:inline-flex;align-items:center;gap:7px;flex:none;height:42px;padding:0 10px;border:0;background:transparent;color:var(--ink-3);font-size:var(--fs-sm);font-weight:500}
.tab:hover{color:var(--ink)}
.tab[aria-selected="true"]{color:var(--ink)}
.tab[aria-selected="true"]::after{left:8px;right:8px;bottom:-1px}
.tab .icon{color:var(--ink-4)}
.tab[aria-selected="true"] .icon{color:var(--accent)}
.tab:focus-visible{box-shadow:inset var(--focus)}
.tab .count.tone-warn{background:var(--warn-soft);color:var(--warn)}
.tab-panel{display:flex;flex-direction:column;gap:16px;padding-top:20px;min-width:0}
.tab-panel [id^="detail-"]{scroll-margin-top:calc(var(--header-h) + 60px)}

/* Now banner: the execution status tone as a left stripe and a soft wash */
.now-card{border-color:var(--line-2);background:linear-gradient(100deg,var(--tone-soft,transparent),transparent 62%),var(--surface);box-shadow:inset 3px 0 0 var(--tone,var(--line-3))}
.now-card>.card-body{gap:0;padding:16px 18px 16px 20px}
.now-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.now-owner{color:var(--ink-2);font-size:var(--fs-sm);font-weight:500}
.now-summary{margin-top:10px;font-size:var(--fs-lg);font-weight:500;line-height:1.45;color:var(--ink)}
.now-reason{margin-top:4px;color:var(--ink-3);font-size:var(--fs-sm)}
.now-note{margin-top:8px;color:var(--ink-3);font-size:var(--fs-sm)}
.signal-list{list-style:none;display:grid;gap:6px;margin:12px 0 0;padding:0}
.signal-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;padding:8px 10px;border-radius:var(--r-sm);background:var(--tone-soft);font-size:var(--fs-sm)}
.signal-row>.icon{align-self:center;color:var(--tone)}
.signal-kind{color:var(--tone);font-weight:600}
.next-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin-top:12px;padding-top:10px;border-top:1px solid var(--line);color:var(--ink-3);font-size:var(--fs-xs)}
.next-line:empty{display:none}
.next-line .icon{color:var(--accent)}
.next-line strong{color:var(--ink)}

/* Needs you / input requests */
.needs-card{border-color:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
.needs-card .card-icon{background:var(--warn-soft);color:var(--warn)}
.input-card{display:grid;gap:10px;padding:14px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2)}
.input-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--ink-3);font-size:var(--fs-xs)}
.input-kicker{display:inline-flex;align-items:center;gap:5px;color:var(--warn);font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:var(--fs-2xs)}
.input-timeout{display:inline-flex;align-items:center;gap:4px}
.input-head .when{margin-left:auto}
.input-question{font-size:var(--fs-lg);font-weight:500;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.input-facts{color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.input-choices{display:flex;flex-wrap:wrap;gap:8px}
.choice{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:6px 14px;border:1px solid var(--line-3);border-radius:var(--r-md);background:var(--surface);color:var(--ink);font-weight:500;text-align:left}
.choice:hover:not(:disabled){border-color:var(--accent);background:var(--accent-soft)}
.choice.is-recommended{border-color:var(--accent-line)}
.choice:disabled{opacity:.5}
.input-form{display:flex;gap:8px}
.input-form input{flex:1}

/* Decisions, planning */
.decision{display:grid;gap:4px;padding-top:10px;border-top:1px solid var(--line)}
.decision:first-child{padding-top:0;border-top:0}
.decision-head{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm)}
.decision-head strong{flex:1;min-width:0;font-weight:600}
.planning-card .kv{font-size:var(--fs-xs)}
`;
