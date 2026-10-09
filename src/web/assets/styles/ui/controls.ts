/*
 * UI CONTROLS — interactive primitives shared by every view: tones, buttons,
 * segmented controls, badges, dots, chips, chip tabs and the scrollable tab
 * strips. Colour comes only from tokens.
 */
export const CONTROL_STYLES = `
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

/* Badges, dots, chips and inline text utilities */
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

/* Scrollable tab strips: task tabs (.tabs) and the sidebar status filters
   (.tabs-row, which fades whichever edge still has more to scroll). The
   selected tab draws an accent underline; each view sets its insets. */
.tabs,.tabs-row{display:flex;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar,.tabs-row::-webkit-scrollbar{display:none}
.tabs-row{position:relative;gap:2px;padding-bottom:2px;border-bottom:1px solid var(--line)}
.tabs-row[data-fade="end"]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
.tabs-row[data-fade="start"]{-webkit-mask-image:linear-gradient(90deg,transparent,#000 28px);mask-image:linear-gradient(90deg,transparent,#000 28px)}
.tabs-row[data-fade="both"]{-webkit-mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent);mask-image:linear-gradient(90deg,transparent,#000 28px,#000 calc(100% - 28px),transparent)}
.status-tab[aria-pressed="true"]::after,.tab[aria-selected="true"]::after{content:"";position:absolute;height:2px;border-radius:2px;background:var(--accent)}
`;
