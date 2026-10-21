import { BREAKPOINTS, DOCK_FOCUS_MAX, SIDEBAR } from "../../shared/geometry.js";

/*
 * RESPONSIVE — breakpoints only, from shared/geometry.ts.
 *   ≤ wide    compact sidebar default and a three-column metric strip
 *   ≤ focus   an open dock moves the task list out of the grid so the task
 *             column keeps its minimum width; it opens as a drawer instead
 *   ≤ narrow  the workspace takes the screen; the rail and the list open
 *             together as one drawer, and the dock becomes a full-screen sheet
 *   ≤ small   phone layout for page content
 *
 * Motion follows the native sheet pattern (Vaul, Radix Sheet, iOS): drawers
 * and sheets stay rendered off screen and move only by transform, so opening
 * and closing both animate on the compositor; the scrim only fades. A drag
 * (layout/sidebarNav) moves the panels directly and the release continues
 * from where the finger left them.
 */
export const RESPONSIVE_STYLES = `
@media(max-width:${BREAKPOINTS.wide}px){
  :root{--sidebar-w:${SIDEBAR.compact}px}
  .metric-strip{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media(min-width:${BREAKPOINTS.narrow + 1}px) and (max-width:${DOCK_FOCUS_MAX}px){
  body.dock-open .app{grid-template-areas:"rail center divider dock";grid-template-columns:var(--rail-w) minmax(0,1fr) var(--divider-w) var(--dock-w)}
  body.dock-open.dock-center .app{grid-template-areas:"rail dock divider center";grid-template-columns:var(--rail-w) var(--dock-w) var(--divider-w) minmax(0,1fr)}
  body.dock-open .sidebar-divider{display:none}
  body.dock-open .side-expand{display:inline-grid}
  /* The list slides out from under the rail. */
  body.dock-open .app-rail{position:relative;z-index:var(--z-rail-over)}
  body.dock-open.sidebar-collapsed .app .sidebar{display:flex}
  body.dock-open .app .sidebar{--drawer-w:min(340px,calc(100vw - var(--rail-w) - 24px));display:flex;position:fixed;top:0;bottom:0;left:var(--rail-w);z-index:var(--z-drawer);width:var(--drawer-w);border-right:1px solid var(--line-2);box-shadow:var(--shadow-2);transform:translate3d(calc(-100% - 32px),0,0);visibility:hidden;transition:transform var(--t-sheet-out) var(--ease-sheet),visibility 0s linear var(--t-sheet-out)}
}
@media(max-width:${BREAKPOINTS.narrow}px){
  :root{--drawer-w:min(320px,calc(100vw - var(--rail-w) - 48px));--drawer-off:calc(-1 * (var(--rail-w) + var(--drawer-w)) - 32px)}
  .app,body.dock-open .app,body.dock-open.dock-center .app{grid-template-areas:"main";grid-template-columns:minmax(0,1fr)}
  .center{grid-area:main}
  /* One drawer: the rail and the list, side by side, moving together. */
  .app .app-rail,.app .sidebar{display:flex;position:fixed;top:0;bottom:0;z-index:var(--z-drawer);padding-top:env(safe-area-inset-top,0px);transform:translate3d(var(--drawer-off),0,0);visibility:hidden;transition:transform var(--t-sheet-out) var(--ease-sheet),visibility 0s linear var(--t-sheet-out);touch-action:pan-y}
  body.sidebar-collapsed .app .sidebar{display:flex}
  .app .app-rail{left:0;width:var(--rail-w);padding-top:calc(10px + env(safe-area-inset-top,0px))}
  .app .sidebar{left:var(--rail-w);width:var(--drawer-w);border-right:1px solid var(--line-2);border-radius:0 var(--r-lg) var(--r-lg) 0;box-shadow:var(--shadow-2)}
  .icon-btn.side-expand{display:inline-grid}
  .side-expand .i-sidebar{display:none}
  .side-expand .i-menu{display:contents}
  /* Top bar: the current place is the title. */
  .top-bar{padding:0 12px 0 8px}
  .crumbs>span.crumb,.crumbs>span.crumb+.crumb-sep{display:none}
  .crumbs span.crumb-current{font-size:var(--fs-lg)}
  .dock-divider,.sidebar-divider{display:none}
  .dock{position:fixed;inset:0;z-index:var(--z-sheet);padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);animation:m-sheet-up var(--t-sheet) var(--ease-sheet)}
  #dock-swap{display:none}
  .dock-toggle span{display:none}
  .dock-toggle{width:32px;padding:0}
}
/* Open drawer (sidebarNav sets body.sidebar-drawer only where the list
   cannot sit inline). Opening eases in a little slower than closing. */
body.sidebar-drawer .app .sidebar,body.sidebar-drawer .app .app-rail{transform:translate3d(0,0,0);visibility:visible;transition:transform var(--t-sheet) var(--ease-sheet),visibility 0s}
body.sidebar-drawer .app .sidebar-divider{display:none}
.sidebar-scrim{position:fixed;inset:0;z-index:var(--z-scrim);background:rgb(12 10 8 / .4);opacity:0;visibility:hidden;pointer-events:none;transition:opacity var(--t-sheet-out) var(--ease-sheet),visibility 0s linear var(--t-sheet-out)}
body.sidebar-drawer .sidebar-scrim{opacity:1;visibility:visible;pointer-events:auto;transition:opacity var(--t-sheet) var(--ease-sheet),visibility 0s}
/* While a finger drags the drawer, it follows directly. */
body.drawer-dragging .app .sidebar,body.drawer-dragging .app .app-rail,body.drawer-dragging .sidebar-scrim{transition:none}
@media(prefers-reduced-motion:reduce){
  .app .sidebar,.app .app-rail,.sidebar-scrim,body.sidebar-drawer .app .sidebar,body.sidebar-drawer .app .app-rail,body.sidebar-drawer .sidebar-scrim{transition:none}
  .dock{animation:none}
}
/* Touch screens: controls reach a comfortable tap size without changing the
   desktop density. */
@media(pointer:coarse){
  .btn,.icon-btn,.dock-toggle{min-height:38px}
  .icon-btn{min-width:38px}
  .dock-toggle{min-width:38px}
  .seg-btn,.seg-sm .seg-btn{height:36px}
  .cv-pill{height:36px}
  .cv-link{min-height:32px}
  .chip-tab{height:34px}
  .btn-link{min-height:32px;padding-top:6px;padding-bottom:6px}
  .cv-activity>summary{min-height:32px}
  .cv-sub>summary{padding:8px 0}
  .task-row{min-height:48px}
}
@media(max-width:${BREAKPOINTS.small}px){
  .metric-strip{grid-template-columns:repeat(2,minmax(0,1fr))}
  .page-head{padding-top:24px;flex-wrap:wrap}
  .task-title{font-size:var(--fs-xl)}
  .tab:not([aria-selected="true"]) span:not(.count){display:none}
  .tab{padding:0 12px}
  .field-row{grid-template-columns:minmax(0,1fr)}
  .work-body{padding-left:16px}
  .card-heading:has(.card-icon) .card-hint{padding-left:0}
  .role-card>:not(.role-head):not(.role-actions){margin-left:0}
  .now-card>.card-body{padding:14px 14px 14px 17px}
  .kv{grid-template-columns:minmax(0,1fr)}
  .kv dt{margin-top:4px}
  .lazy-meta{display:none}
  .lazy-body{padding-left:16px}
}
`;
