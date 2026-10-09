import { BREAKPOINTS, SIDEBAR } from "../../shared/geometry.js";

/*
 * RESPONSIVE — breakpoints only, from shared/geometry.ts.
 *   ≤ wide    compact sidebar default and a three-column metric strip
 *   ≤ narrow  master–detail: task list OR task page; the dock becomes a
 *             full-screen sheet over the task page
 *   ≤ small   phone layout for page content
 * Sidebar container queries adapt its footer to the width the user chose.
 */
export const RESPONSIVE_STYLES = `
@container sidebar (max-width:299px){
  .foot-btn kbd{display:none}
}
@container sidebar (max-width:259px){
  .foot-btn{gap:0;padding:0 9px}
  .foot-btn span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
}
@media(max-width:${BREAKPOINTS.wide}px){
  :root{--sidebar-w:${SIDEBAR.compact}px}
  .metric-strip{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media(max-width:${BREAKPOINTS.narrow}px){
  .app,body.dock-open .app,body.dock-open.dock-center .app{grid-template-areas:"main";grid-template-columns:minmax(0,1fr)}
  .sidebar{grid-area:main;border-right:0}
  .center{grid-area:main;display:none}
  body.task-open .sidebar{display:none}
  body.task-open .center{display:block}
  .back-btn{display:inline-grid}
  .crumbs .crumb,.crumbs .crumb-sep{display:none}
  .dock-divider,.sidebar-divider{display:none}
  .dock{position:fixed;inset:0;z-index:60;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
  #dock-swap{display:none}
  .dock-toggle span{display:none}
  .dock-toggle{width:32px;padding:0}
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
  .foot-btn kbd{display:none}
  .lazy-meta{display:none}
  .lazy-body{padding-left:16px}
}
`;
