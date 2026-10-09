/*
 * COMPONENTS — reusable controls and primitives: buttons, segmented
 * controls, badges, dots, chips, cards, disclosures, key/value lists, empty
 * states, metrics, dialogs and the toast. Colour comes only from tokens.
 *
 * Task and overview surfaces are one reading column of flat panels: a card
 * head (icon tile, title, count, hint, actions) above a hairline, then the
 * body. List cards divide their rows with hairlines instead of nesting boxes.
 */
export const COMPONENT_STYLES = `
/* Tones: one semantic colour per tone, used by dots, badges and signals */
.tone-info{--tone:var(--info);--tone-soft:var(--info-soft)}
.tone-ok{--tone:var(--ok);--tone-soft:var(--ok-soft)}
.tone-warn{--tone:var(--warn);--tone-soft:var(--warn-soft)}
.tone-bad{--tone:var(--bad);--tone-soft:var(--bad-soft)}
.tone-idle{--tone:var(--idle);--tone-soft:var(--idle-soft)}
.tone-accent{--tone:var(--accent);--tone-soft:var(--accent-soft)}

/* Buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:var(--surface-2);color:var(--ink);font-size:var(--fs-sm);font-weight:500;white-space:nowrap;transition:background var(--t-fast),border-color var(--t-fast),color var(--t-fast),transform var(--t-fast)}
.btn:hover:not(:disabled){border-color:var(--line-3);background:var(--surface-3)}
.btn:active:not(:disabled){transform:translateY(1px)}
.btn:disabled{opacity:.45}
.btn .icon{width:15px;height:15px}
.btn-primary{background:var(--accent);border-color:transparent;color:var(--accent-ink);font-weight:600}
.btn-primary:hover:not(:disabled){background:var(--accent);border-color:transparent;filter:brightness(1.08)}
.btn-ghost{background:transparent;border-color:transparent;color:var(--ink-2)}
.btn-ghost:hover:not(:disabled){background:var(--surface-3);border-color:transparent;color:var(--ink)}
.btn-ghost[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.btn-link{height:auto;padding:2px 0;border:0;background:transparent;color:var(--accent);font-weight:500}
.btn-link:hover:not(:disabled){background:transparent;text-decoration:underline;text-underline-offset:3px}
.link-btn{justify-self:start;padding:0;border:0;background:none;color:var(--accent);font-size:var(--fs-xs);font-weight:500}
.link-btn:hover{text-decoration:underline;text-underline-offset:3px}
.icon-btn{display:inline-grid;place-items:center;width:32px;height:32px;flex:none;padding:0;border:0;border-radius:var(--r-sm);background:transparent;color:var(--ink-3);transition:background var(--t-fast),color var(--t-fast)}
.icon-btn:hover:not(:disabled){background:var(--surface-3);color:var(--ink)}
.icon-btn[aria-pressed="true"]{background:var(--accent-soft);color:var(--accent)}
.icon-btn:disabled{opacity:.4}
.icon-btn .icon{width:17px;height:17px}

/* Segmented control */
.seg{display:inline-flex;gap:2px;padding:3px;border-radius:var(--r-md);background:var(--sunken);border:1px solid var(--line)}
.seg-btn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border:0;border-radius:var(--r-sm);background:transparent;color:var(--ink-3);font-size:var(--fs-sm);font-weight:500;white-space:nowrap;transition:background var(--t-fast),color var(--t-fast),box-shadow var(--t-fast)}
.seg-btn:hover:not(:disabled){color:var(--ink)}
.seg-btn[aria-selected="true"],.seg-btn[aria-checked="true"]{background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-1),0 0 0 1px var(--line-2)}
.seg-btn:disabled{opacity:.4}
.seg-btn .icon{width:15px;height:15px}
.seg-sm .seg-btn{height:24px;padding:0 9px;font-size:var(--fs-xs)}

/* Badges, dots, chips */
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:var(--r-pill);background:var(--tone-soft,var(--idle-soft));color:var(--tone,var(--ink-2));font-size:var(--fs-xs);font-weight:600;white-space:nowrap;line-height:1}
.badge-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dot{display:inline-block;width:8px;height:8px;flex:none;border-radius:50%;background:var(--tone,var(--idle));box-shadow:0 0 0 3px var(--tone-soft,transparent)}
.chip{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:var(--r-xs);background:var(--surface-3);color:var(--ink-2);font-size:var(--fs-2xs);font-weight:500;white-space:nowrap}
.chip-strong{color:var(--ink);background:var(--line-2)}
.chip-row{display:inline-flex;flex-wrap:wrap;align-items:center;gap:4px}
code.id{padding:1px 6px;border-radius:var(--r-xs);background:var(--surface-3);color:var(--ink-2);font-size:var(--fs-2xs);white-space:nowrap}
.when{color:var(--ink-3);font-size:var(--fs-xs);white-space:nowrap}
.count{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:var(--r-pill);background:var(--surface-3);color:var(--ink-3);font-size:10.5px;font-weight:600;line-height:1}
.spacer{flex:1}
.small{font-size:var(--fs-xs)}
.mono-line{font-family:var(--font-mono);font-size:var(--fs-2xs);overflow-wrap:anywhere}

/* Chip tabs (local filters) */
.chip-tabs{display:flex;flex-wrap:wrap;gap:6px}
.chip-tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r-pill);background:transparent;color:var(--ink-3);font-size:var(--fs-xs);font-weight:500}
.chip-tab:hover{color:var(--ink);border-color:var(--line-3)}
.chip-tab[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--canvas)}
.chip-tab[aria-pressed="true"] .count{background:rgba(127,127,127,.25);color:inherit}

/* Cards: flat panels. Actions sit beside the heading and wrap below it when
   the column is too narrow for both. */
.card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:12px 16px}
.card-heading{display:grid;gap:3px;flex:1 1 260px;min-width:0}
.card-title{display:flex;align-items:center;gap:10px;min-width:0;font-size:var(--fs-md);font-weight:600;color:var(--ink)}
.card-title>span:not(.card-icon):not(.count){min-width:0;overflow-wrap:anywhere}
.card-icon{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:var(--r-sm);background:var(--surface-3);color:var(--ink-3)}
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

/* Disclosure */
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

/* Key/value */
.kv{display:grid;grid-template-columns:minmax(96px,max-content) minmax(0,1fr);gap:7px 16px;margin:0;font-size:var(--fs-sm)}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;min-width:0;color:var(--ink);overflow-wrap:anywhere}
.kv dd code.id{white-space:normal;overflow-wrap:anywhere;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.kv-compact{gap:3px 12px;font-size:var(--fs-xs)}

/* Prose */
.prose-block{display:grid;gap:5px;min-width:0}
.prose-label{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.prose-block.is-collapsed .md{max-height:180px;overflow:hidden;-webkit-mask-image:linear-gradient(#000 65%,transparent);mask-image:linear-gradient(#000 65%,transparent)}
.callout{padding:10px 12px;border-radius:var(--r-md);background:var(--tone-soft,var(--surface-3));border-left:2px solid var(--tone,var(--line-3))}
.bullets{margin:0;padding-left:18px;display:grid;gap:3px;font-size:var(--fs-sm);color:var(--ink-2)}
.checklist{list-style:none;margin:0;padding:0;display:grid;gap:5px;font-size:var(--fs-sm)}
.checklist li{display:flex;gap:8px;align-items:flex-start;color:var(--ink-2)}
.checklist li .icon{margin-top:3px;color:var(--ink-4)}
.checklist li.is-done .icon{color:var(--ok)}

/* Notes, empty states, receipts */
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
.show-more{justify-self:start;display:inline-flex;align-items:center;height:30px;padding:0 12px;border:1px dashed var(--line-3);border-radius:var(--r-sm);background:transparent;color:var(--ink-3);font-size:var(--fs-xs);font-weight:500}
.show-more:hover{color:var(--accent);border-color:var(--accent-line)}
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

/* Forms */
.field{display:grid;gap:6px;min-width:0;margin:0;padding:0;border:0;font-size:var(--fs-sm)}
.field>span,.field>legend{color:var(--ink-2);font-size:var(--fs-xs);font-weight:500;padding:0}
.field-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.form-actions{display:flex;gap:8px;justify-content:flex-end}
.inline-form{display:grid;gap:8px}
.inline-row{display:flex;gap:8px}
.inline-row input{flex:1}

/* Dialogs */
.dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;overflow:auto;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-2)}
.dialog::backdrop{background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.dialog-body{display:grid;gap:16px;padding:20px}
.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dialog-head h2{font-size:var(--fs-lg)}
.dialog-sub{margin-top:4px;color:var(--ink-3);font-size:var(--fs-xs)}
.dialog-actions{display:flex;gap:8px;justify-content:flex-end}
.settings-dialog{width:min(460px,calc(100vw - 32px))}
.theme-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.theme-option{display:grid;gap:8px;padding:8px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2);text-align:left;font-size:var(--fs-sm);font-weight:500}
.theme-option:hover{border-color:var(--line-3)}
.theme-option[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.theme-swatch{display:flex;height:34px;overflow:hidden;border-radius:var(--r-sm);border:1px solid var(--line)}
.theme-swatch i{flex:2}
.theme-swatch i[data-part="2"]{flex:1}
.shortcut-list{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:var(--fs-sm);color:var(--ink-2)}
.shortcut-list dt{display:flex;gap:3px;align-items:center}
.shortcut-list dd{margin:0}

/* Toast */
.toast{position:fixed;left:50%;bottom:24px;z-index:90;max-width:min(520px,calc(100vw - 32px));padding:10px 16px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-2);font-size:var(--fs-sm);opacity:0;transform:translate(-50%,8px);pointer-events:none;transition:opacity var(--t-med),transform var(--t-med) var(--ease)}
.toast.show{opacity:1;transform:translate(-50%,0)}
`;
