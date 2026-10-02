/*
 * LAYOUT — the three-region workspace.
 *   sidebar | center (task details) | divider | dock (session)
 * body.dock-open shows the dock; body.dock-center swaps the dock into the
 * middle so the order becomes sidebar | dock | divider | center.
 */
export const LAYOUT_STYLES = `
.app{display:grid;height:100vh;height:100dvh;grid-template-rows:minmax(0,1fr);
  grid-template-areas:"sidebar center divider dock";
  grid-template-columns:var(--sidebar-w) minmax(0,1fr) 0 0}
body.dock-open .app{grid-template-columns:var(--sidebar-w) minmax(0,1fr) var(--divider-w) var(--dock-w)}
body.dock-open.dock-center .app{grid-template-areas:"sidebar dock divider center";grid-template-columns:var(--sidebar-w) var(--dock-w) var(--divider-w) minmax(0,1fr)}

/* Sidebar */
.sidebar{grid-area:sidebar;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface);border-right:1px solid var(--line)}
.side-head{flex:none;display:flex;align-items:center;gap:10px;height:var(--header-h);padding:0 12px 0 16px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.search-field{flex:none;margin:12px 12px 0}
.attention-bar{flex:none;margin:10px 12px 0}
.status-tabs{flex:none;margin:10px 0 0;padding:0 12px}
.task-list{flex:1;min-height:0;overflow-y:auto;padding:6px 8px 12px;scrollbar-gutter:stable}
.pager{flex:none;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--line)}
.pager .pager-clear{grid-column:1/-1}
.side-foot{flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px;border-top:1px solid var(--line)}

/* Center */
.center{grid-area:center;min-width:0;min-height:0;overflow-y:auto;scrollbar-gutter:stable;background:var(--canvas)}
.center:focus-visible{box-shadow:none}
.detail{min-height:100%}
.page{max-width:var(--center-max);margin:0 auto;padding:0 clamp(16px,3vw,40px) 64px}

/* Dock divider */
.dock-divider{grid-area:divider;position:relative;cursor:col-resize;touch-action:none;background:var(--canvas);z-index:5}
.dock-divider span{position:absolute;top:0;bottom:0;left:4px;width:1px;background:var(--line-2);transition:background var(--t-fast),box-shadow var(--t-fast)}
.dock-divider:hover span,.dock-divider:focus-visible span,body.dock-resizing .dock-divider span{background:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.dock-divider:focus-visible{box-shadow:none}
body.dock-resizing{cursor:col-resize;user-select:none}

/* Dock */
.dock{grid-area:dock;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface)}
body.dock-open:not(.dock-center) .dock{border-left:0}
.dock-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;height:var(--header-h);padding:0 10px 0 12px;border-bottom:1px solid var(--line)}
.dock-actions{display:flex;gap:2px}
.dock-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.dock-discussion{position:relative}
.dock-session{background:var(--term-bg)}
.session-bar{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.07)}
.session-targets{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.terminal-host{flex:1;min-height:0;padding:10px 4px 6px 12px;overflow:hidden}
.terminal-host:empty{display:none}
.terminal-empty{flex:1;display:grid;place-content:center;justify-items:center;gap:8px;padding:24px;text-align:center}
.session-foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid rgba(255,255,255,.07)}
`;
