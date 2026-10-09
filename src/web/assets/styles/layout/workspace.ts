/*
 * WORKSPACE — the three-region application frame.
 *   sidebar | center (task details) | divider | dock (session)
 * body.dock-open shows the dock; body.dock-center swaps the dock into the
 * middle so the order becomes sidebar | dock | divider | center. The sidebar's
 * own divider overlays its right edge, so it adds no grid column; --sidebar-w
 * is the default width and a stored preference overrides it inline. Region
 * contents are styled by the view stylesheets.
 */
export const WORKSPACE_STYLES = `
.app{display:grid;height:100vh;height:100dvh;grid-template-rows:minmax(0,1fr);
  grid-template-areas:"sidebar center divider dock";
  grid-template-columns:var(--sidebar-w) minmax(0,1fr) 0 0}
body.dock-open .app{grid-template-columns:var(--sidebar-w) minmax(0,1fr) var(--divider-w) var(--dock-w)}
body.dock-open.dock-center .app{grid-template-areas:"sidebar dock divider center";grid-template-columns:var(--sidebar-w) var(--dock-w) var(--divider-w) minmax(0,1fr)}

/* Resize dividers: a wide invisible hit area around a 1px rule that lights up
   on hover, focus and while dragging. */
.sidebar-divider,.dock-divider{position:relative;cursor:col-resize;touch-action:none}
.sidebar-divider span,.dock-divider span{position:absolute;top:0;bottom:0;width:1px;transition:background var(--t-fast),box-shadow var(--t-fast)}
.sidebar-divider:hover span,.sidebar-divider:focus-visible span,body.sidebar-resizing .sidebar-divider span,
.dock-divider:hover span,.dock-divider:focus-visible span,body.dock-resizing .dock-divider span{background:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.sidebar-divider:focus-visible,.dock-divider:focus-visible{box-shadow:none}
body.sidebar-resizing,body.dock-resizing{cursor:col-resize;user-select:none}

/* Sidebar */
.sidebar{grid-area:sidebar;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface);border-right:1px solid var(--line);container:sidebar/inline-size}
.sidebar-divider{grid-area:sidebar;justify-self:end;z-index:20;width:var(--divider-w);margin-right:-5px}
.sidebar-divider span{left:3px;background:transparent}
.side-head{flex:none;display:flex;align-items:center;gap:10px;height:var(--header-h);padding:0 12px 0 16px;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;flex:1;min-width:0}
.attention-bar{flex:none;margin:10px 12px 0}
.status-tabs{flex:none;margin:10px 0 0;padding:0 12px}
.task-list{flex:1;min-height:0;overflow-y:auto;padding:4px 8px 12px;scrollbar-gutter:stable}
.pager{flex:none;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--line)}
.pager .pager-clear{grid-column:1/-1}
.side-foot{flex:none;display:flex;align-items:center;gap:4px;padding:10px;border-top:1px solid var(--line)}

/* Center */
.center{grid-area:center;min-width:0;min-height:0;overflow-y:auto;scrollbar-gutter:stable;background:var(--canvas)}
.center:focus-visible{box-shadow:none}
.detail{min-height:100%}

/* Dock */
.dock-divider{grid-area:divider;background:var(--canvas);z-index:5}
.dock-divider span{left:4px;background:var(--line-2)}
.dock{grid-area:dock;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface)}
body.dock-open:not(.dock-center) .dock{border-left:0}
.dock-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;height:var(--header-h);padding:0 10px 0 12px;border-bottom:1px solid var(--line)}
.dock-actions{display:flex;gap:2px}
.dock-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.dock-discussion{position:relative}
`;
