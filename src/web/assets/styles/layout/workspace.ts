import { RAIL_WIDTH } from "../../shared/geometry.js";

/*
 * WORKSPACE — the application frame.
 *   rail | sidebar | center (task details) | divider | dock (session)
 * The rail is the global Workbench / Models / Settings navigation, shared with
 * the management pages. body.dock-open shows the dock; body.dock-center swaps
 * the dock into the middle so the order becomes rail | sidebar | dock |
 * divider | center. body.sidebar-collapsed folds the task list away (the page
 * header then offers .side-expand to bring it back). The sidebar's own
 * divider overlays its right edge, so it adds no grid column; --sidebar-w is
 * the default width and a stored preference overrides it inline. Region
 * contents are styled by the view stylesheets.
 */
export const WORKSPACE_STYLES = `
:root{--rail-w:${RAIL_WIDTH}px}
.app{display:grid;height:100vh;height:100dvh;grid-template-rows:minmax(0,1fr);
  grid-template-areas:"rail sidebar center divider dock";
  grid-template-columns:var(--rail-w) var(--sidebar-w) minmax(0,1fr) 0 0}
body.dock-open .app{grid-template-columns:var(--rail-w) var(--sidebar-w) minmax(0,1fr) var(--divider-w) var(--dock-w)}
body.dock-open.dock-center .app{grid-template-areas:"rail sidebar dock divider center";grid-template-columns:var(--rail-w) var(--sidebar-w) var(--dock-w) var(--divider-w) minmax(0,1fr)}
body.sidebar-collapsed{--sidebar-w:0px}
body.sidebar-collapsed:not(.sidebar-drawer) .sidebar,body.sidebar-collapsed .sidebar-divider{display:none}

/* Global rail: brand, then the three areas as icon-over-label tiles. */
.app-rail{grid-area:rail;display:flex;flex-direction:column;align-items:center;gap:6px;min-height:0;padding:10px 0 12px;background:var(--surface);border-right:1px solid var(--line);overflow-y:auto}
.rail-brand{display:grid;place-items:center;width:40px;height:40px;margin-bottom:6px;border-radius:var(--r-md);text-decoration:none}
.rail-brand .brand-mark{display:grid;place-items:center}
.rail-brand:hover .brand-mark{box-shadow:0 0 0 3px var(--accent-soft)}
.rail-items{display:flex;flex-direction:column;align-items:center;gap:4px}
.rail-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:48px;min-height:50px;padding:6px 2px;border-radius:var(--r-md);color:var(--ink-3);font-size:10.5px;font-weight:550;line-height:1.15;text-align:center;text-decoration:none;transition:background var(--t-fast),color var(--t-fast),transform var(--t-fast) var(--ease)}
.rail-item .icon{width:18px;height:18px;flex:none}
.rail-item span{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rail-item:hover{background:var(--surface-3);color:var(--ink)}
.rail-item[aria-current="page"]{background:var(--accent-soft);color:var(--accent)}

/* Task-list switch in the page header: only while the list is out of view. */
.icon-btn.side-expand{display:none}
.side-expand .i-menu{display:none}
.side-expand>span{display:contents}
body.sidebar-collapsed .side-expand{display:inline-grid}
.side-title{flex:1;min-width:0;font-size:var(--fs-md);font-weight:650;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidebar-scrim[hidden]{display:none}

/* Top bar: the first row of the center column on every page. Its height and
   rule line up with the task-list head and the dock head, so the frame reads
   as one header row: list switch, location, then the page's actions. */
.top-bar{position:sticky;top:0;z-index:var(--z-sticky);display:flex;align-items:center;gap:6px;height:var(--header-h);padding:0 16px 0 12px;border-bottom:1px solid var(--line);background:var(--canvas)}
.top-title{min-width:0;overflow:hidden;color:var(--ink);font-size:var(--fs-md);font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.crumbs{display:flex;align-items:center;gap:4px;min-width:0;font-size:var(--fs-sm);white-space:nowrap}
.crumb,.crumb-sep{flex:none}
.crumb{padding:3px 6px;border:0;border-radius:var(--r-xs);background:transparent;color:var(--ink-3);font-size:var(--fs-sm)}
button.crumb:hover{color:var(--ink);background:var(--surface-3)}
.crumb-sep{color:var(--ink-4)}
.crumb-current{min-width:0;overflow:hidden;padding:3px 6px;color:var(--ink);font-weight:600;text-overflow:ellipsis}
code.crumb-current{font-weight:500;font-size:var(--fs-xs);color:var(--ink-2)}

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
.sidebar-divider{grid-area:sidebar;justify-self:end;z-index:var(--z-header);width:var(--divider-w);margin-right:-5px}
.sidebar-divider span{left:3px;background:transparent}
.side-head{flex:none;display:flex;align-items:center;gap:10px;height:var(--header-h);padding:0 12px 0 16px;border-bottom:1px solid var(--line)}
.status-tabs{flex:none;margin:4px 0 0;padding:0 12px}
.task-list{flex:1;min-height:0;overflow-y:auto;padding:4px 8px 12px;scrollbar-gutter:stable}
.pager{flex:none;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:6px;padding:8px 12px;border-top:1px solid var(--line)}
.pager .pager-clear{grid-column:1/-1}

/* Center */
.center{grid-area:center;min-width:0;min-height:0;overflow-y:auto;scrollbar-gutter:stable;background:var(--canvas)}
.center:focus-visible{box-shadow:none}
.detail{min-height:100%}

/* Dock */
.dock-divider{grid-area:divider;background:var(--canvas);z-index:var(--z-raised)}
.dock-divider span{left:4px;background:var(--line-2)}
.dock{grid-area:dock;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface)}
body.dock-open:not(.dock-center) .dock{border-left:0}
.dock-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;height:var(--header-h);padding:0 10px 0 12px;border-bottom:1px solid var(--line)}
.dock-actions{display:flex;gap:2px}
.dock-pane{flex:1;min-height:0;display:flex;flex-direction:column}
.dock-discussion{position:relative}
`;
