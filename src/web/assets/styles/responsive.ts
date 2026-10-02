/*
 * RESPONSIVE — breakpoints only.
 *   ≤1200px  narrower sidebar and dock defaults
 *   ≤900px   master–detail: task list OR task page; the dock becomes a
 *            full-screen sheet over the task page
 */
export const RESPONSIVE_STYLES = `
@media(max-width:1200px){
  :root{--sidebar-w:264px}
  .card-grid{grid-template-columns:minmax(0,1fr)}
  .metric-strip{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media(max-width:1040px){
  body.dock-open .overview-grid{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:900px){
  .app,body.dock-open .app,body.dock-open.dock-center .app{grid-template-areas:"main";grid-template-columns:minmax(0,1fr)}
  .sidebar{grid-area:main;border-right:0}
  .center{grid-area:main;display:none}
  body.task-open .sidebar{display:none}
  body.task-open .center{display:block}
  .back-btn{display:inline-grid}
  .crumbs .crumb,.crumbs .crumb-sep{display:none}
  .dock-divider{display:none}
  .dock{position:fixed;inset:0;z-index:60;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
  #dock-swap{display:none}
  .overview-grid{grid-template-columns:minmax(0,1fr)}
  .dock-toggle span{display:none}
  .dock-toggle{width:32px;padding:0}
}
@media(max-width:620px){
  .metric-strip{grid-template-columns:repeat(2,minmax(0,1fr))}
  .page-head{padding-top:24px;flex-wrap:wrap}
  .task-title{font-size:var(--fs-xl)}
  .tab:not([aria-selected="true"]) span:not(.count){display:none}
  .tab{padding:0 12px}
  .field-row{grid-template-columns:minmax(0,1fr)}
  .work-body{padding-left:16px}
  .kv{grid-template-columns:minmax(0,1fr)}
  .kv dt{margin-top:4px}
  .foot-btn kbd{display:none}
}
`;
