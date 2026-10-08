/*
 * COMPONENTS — reusable controls and primitives: buttons, segmented
 * controls, badges, dots, chips, cards, disclosures, key/value lists, empty
 * states, metrics, dialogs and the toast. Colour comes only from tokens.
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
.chip-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.chip-tab{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r-pill);background:transparent;color:var(--ink-3);font-size:var(--fs-xs);font-weight:500}
.chip-tab:hover{color:var(--ink);border-color:var(--line-3)}
.chip-tab[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--canvas)}
.chip-tab[aria-pressed="true"] .count{background:rgba(127,127,127,.25);color:inherit}

/* Cards */
.card{display:flex;flex-direction:column;min-width:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-1)}
.card-head{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 10px;padding:14px 16px 0}
.card-title{display:flex;align-items:center;gap:8px;flex:1;min-width:0;font-size:var(--fs-md);font-weight:600;color:var(--ink)}
.card-title .icon{color:var(--ink-3)}
.card-actions{grid-row:1;grid-column:2;display:flex;gap:6px;margin:-4px -6px -4px 0}
.card-hint{grid-column:1/-1;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
.card-body{display:grid;gap:12px;padding:14px 16px 16px;min-width:0}
.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.card-grid-1{grid-template-columns:minmax(0,1fr)}
.card-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start}
.card-column{display:flex;flex-direction:column;gap:14px;min-width:0}
.stack{display:grid;gap:10px;min-width:0}

/* Disclosure */
.disclosure{min-width:0;border-top:1px solid var(--line)}
.disclosure>summary{display:flex;align-items:center;gap:8px;padding:10px 0;list-style:none;cursor:pointer;color:var(--ink-2);font-size:var(--fs-sm);font-weight:500;user-select:none}
.disclosure>summary::-webkit-details-marker{display:none}
.disclosure>summary:hover{color:var(--ink)}
.disclosure-chevron{width:14px;height:14px;color:var(--ink-4);transition:transform var(--t-med) var(--ease)}
details[open]>summary .disclosure-chevron{transform:rotate(90deg)}
.disclosure-meta{margin-left:auto;color:var(--ink-4);font-size:var(--fs-xs);font-weight:400}
.disclosure-body{display:grid;gap:10px;padding:0 0 12px 22px;min-width:0}
.card-disclosure{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-1)}
.card-disclosure>summary{padding:14px 16px;color:var(--ink);font-weight:600;font-size:var(--fs-md)}
.card-disclosure>.disclosure-body{padding:0 16px 16px}

/* Key/value */
.kv{display:grid;grid-template-columns:minmax(96px,max-content) minmax(0,1fr);gap:7px 16px;margin:0;font-size:var(--fs-sm)}
.kv dt{color:var(--ink-3)}
.kv dd{margin:0;min-width:0;color:var(--ink);overflow-wrap:anywhere}
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
