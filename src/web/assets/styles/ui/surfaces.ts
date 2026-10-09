/*
 * UI SURFACES — the reading column's building blocks: cards, list cards, lazy
 * rows, disclosures, key/value lists, prose, notes, receipts, code, loading
 * states and metrics. A card is a flat panel: a head (icon tile, title, count,
 * hint, actions) above a hairline, then the body; list cards divide their
 * rows with hairlines instead of nesting boxes.
 */
export const SURFACE_STYLES = `
/* Cards: actions wrap below the heading when the column is too narrow. Icon
   tiles (brand mark, avatars, card icons) share one centring base. */
.brand-mark,.avatar,.msg-avatar,.card-icon{display:grid;place-items:center;flex:none}
.card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:12px 16px}
.card-heading{display:grid;gap:3px;flex:1 1 260px;min-width:0}
.card-title{display:flex;align-items:center;gap:10px;min-width:0;font-size:var(--fs-md);font-weight:600;color:var(--ink)}
.card-title>span:not(.card-icon):not(.count){min-width:0;overflow-wrap:anywhere}
.card-icon{width:24px;height:24px;border-radius:var(--r-sm);background:var(--surface-3);color:var(--ink-3)}
.card-icon .icon{width:14px;height:14px}
.card-hint{color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
.card-heading:has(.card-icon) .card-hint{padding-left:34px}
.card-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
.card-actions>.btn-ghost:last-child{margin-right:-8px}
.card-body{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:14px 16px 16px;min-width:0}
.card-head+.card-body{border-top:1px solid var(--line)}
.card-body:empty,.card-body:has(> :only-child:empty){display:none}
.card-body>.btn-link{justify-self:start}
.card-stack{display:flex;flex-direction:column;gap:16px;min-width:0}
.stack{display:grid;gap:10px;min-width:0}

/* List cards: one row per record, divided by hairlines */
.list-card{overflow:hidden}
.list-card>.card-body{padding:0;gap:0}
.row-stack{display:grid;grid-template-columns:minmax(0,1fr);min-width:0}
.row-stack>:is(.work-card,.run-card,.review-card,.record,.role-card,.lazy-row){border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none}
.row-stack>:is(.work-card,.run-card,.review-card,.record,.role-card,.lazy-row):first-child,
.row-stack>.row-label+:is(.work-card,.run-card,.review-card,.record,.lazy-row){border-top:0}
.row-stack>:is(.run-card,.review-card,.record){padding:12px 16px}
.row-stack>.run-card[data-status="failed"]{box-shadow:inset 3px 0 0 var(--bad)}
.row-stack>.empty{margin:14px 16px}
.row-stack>.note{margin:12px 16px}
.row-stack>.show-more{margin:6px 16px 14px}
.row-stack>.row-stack{border-top:1px solid var(--line)}
.row-stack>.row-label{padding:12px 16px 2px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.04em}
.row-stack>.row-label:only-child{padding-bottom:12px}
.row-stack.boxed{border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface);overflow:hidden}
.row-stack.boxed>:is(.record){padding:10px 14px}
.list-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;min-width:0}
.list-foot:empty{display:none}
.row-stack>.list-foot{padding:8px 16px;border-top:1px solid var(--line)}
.card-body>.list-foot{padding-top:4px;border-top:1px solid var(--line)}
.list-foot>.faint{margin-right:auto}

/* Lazy rows: a list summary that reads its exact record when opened */
.lazy-row{min-width:0}
.lazy-head{display:flex;align-items:center;gap:10px;min-width:0;padding:11px 16px;list-style:none;cursor:pointer;font-size:var(--fs-sm)}
.lazy-head::-webkit-details-marker{display:none}
.lazy-head:hover .lazy-title{color:var(--ink)}
.lazy-head:focus-visible{box-shadow:inset 0 0 0 2px var(--accent-line)}
.lazy-title{flex:1;min-width:0;color:var(--ink-2);font-weight:500;overflow-wrap:anywhere}
.lazy-body{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0;padding:0 16px 14px 40px}
.lazy-content{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0}
[data-reading="true"]>.record-actions,.record[data-reading="true"]{opacity:.7}

/* Disclosures, inline and card-sized */
.disclosure{min-width:0;border-top:1px solid var(--line)}
.disclosure>summary{display:flex;align-items:center;gap:8px;padding:10px 0;list-style:none;cursor:pointer;color:var(--ink-2);font-size:var(--fs-sm);font-weight:500;user-select:none}
.disclosure>summary::-webkit-details-marker{display:none}
.disclosure>summary:hover{color:var(--ink)}
.disclosure-chevron{width:14px;height:14px;color:var(--ink-4);transition:transform var(--t-med) var(--ease)}
details[open]>summary .disclosure-chevron{transform:rotate(90deg)}
.disclosure-meta{margin-left:auto;color:var(--ink-4);font-size:var(--fs-xs);font-weight:400}
.disclosure-body{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;padding:0 0 12px 22px;min-width:0}
.card-disclosure{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.card-disclosure>summary{gap:10px;padding:12px 16px;border-radius:var(--r-lg);color:var(--ink);font-weight:600;font-size:var(--fs-md)}
.card-disclosure>summary .disclosure-chevron{box-sizing:content-box;padding:5px;border-radius:var(--r-sm);background:var(--surface-3);color:var(--ink-3)}
.card-disclosure[open]>summary{border-bottom:1px solid var(--line);border-radius:var(--r-lg) var(--r-lg) 0 0}
.card-disclosure>.disclosure-body{padding:14px 16px 16px}

/* Key/value lists and prose */
.kv{display:grid;grid-template-columns:minmax(96px,max-content) minmax(0,1fr);gap:7px 16px;margin:0;font-size:var(--fs-sm)}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;min-width:0;color:var(--ink);overflow-wrap:anywhere}
.kv dd code.id{white-space:normal;overflow-wrap:anywhere;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.kv-compact{gap:3px 12px;font-size:var(--fs-xs)}
.prose-block{display:grid;gap:5px;min-width:0}
.prose-label{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.prose-block.is-collapsed .md{max-height:180px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 65%,transparent);mask-image:linear-gradient(#000 65%,transparent)}
.callout{padding:10px 12px;border-radius:var(--r-md);background:var(--tone-soft,var(--surface-3));border-left:2px solid var(--tone,var(--line-3))}
.bullets{margin:0;padding-left:18px;display:grid;gap:3px;font-size:var(--fs-sm);color:var(--ink-2)}
.checklist{list-style:none;margin:0;padding:0;display:grid;gap:5px;font-size:var(--fs-sm)}
.checklist li{display:flex;gap:8px;align-items:flex-start;color:var(--ink-2)}
.checklist li .icon{margin-top:3px;color:var(--ink-4)}
.checklist li.is-done .icon{color:var(--ok)}

/* Notes, empty states, receipts, code, dashed "more" buttons, loading */
.note{padding:8px 11px;border-radius:var(--r-sm);background:var(--tone-soft,var(--surface-3));color:var(--ink-2);font-size:var(--fs-xs);line-height:1.5}
.note.tone-bad{color:var(--bad)}
.note.tone-warn{color:var(--ink)}
.empty{display:flex;align-items:center;gap:10px;padding:14px;border:1px dashed var(--line-2);border-radius:var(--r-md);color:var(--ink-3);font-size:var(--fs-sm)}
.empty .icon{color:var(--ink-4)}
.receipt{color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.receipt[data-state="pending"]{color:var(--info)}
.receipt[data-state="ok"]{color:var(--ok)}
.receipt[data-state="warn"]{color:var(--warn)}
.receipt[data-state="bad"]{color:var(--bad)}
.code-block{margin:0;max-height:360px;overflow:auto;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--sunken);color:var(--ink-2);font-size:var(--fs-2xs);line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.show-more,.pager-clear{border:1px dashed var(--line-3);border-radius:var(--r-sm);background:transparent;color:var(--ink-3);font-size:var(--fs-xs)}
.show-more:hover,.pager-clear:hover{color:var(--accent);border-color:var(--accent-line)}
.show-more{justify-self:start;display:inline-flex;align-items:center;height:30px;padding:0 12px;font-weight:500}
.loading-block{display:flex;align-items:center;gap:10px;padding:32px 8px;color:var(--ink-3)}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--line-3);border-top-color:var(--accent);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* Metrics */
.metric{display:grid;gap:4px;align-content:start;min-width:0;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}
.metric-label{color:var(--ink-3);font-size:var(--fs-xs)}
.metric-value{font-size:var(--fs-xl);font-weight:600;letter-spacing:-.02em;color:var(--tone,var(--ink));font-variant-numeric:tabular-nums;line-height:1.2}
.metric-note{color:var(--ink-4);font-size:var(--fs-2xs);line-height:1.4}
.metric-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.usage{display:grid;gap:10px}
.usage-meta{display:flex;flex-wrap:wrap;gap:4px 16px;color:var(--ink-3);font-size:var(--fs-2xs)}
`;
