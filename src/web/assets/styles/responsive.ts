/*
 * RESPONSIVE — breakpoints only.
 * Back button is hidden by default; only the narrow master-detail layout
 * reveals it while a task is open.
 */
export const RESPONSIVE_STYLES = `
.detail-back{display:none}
@media(max-width:1080px){
  .metric-value{font-size:27px}
}
@media(max-width:900px){
  /* Master-detail: sidebar list by default; selecting a task swaps to detail */
  body{overflow:auto}
  .app-shell,body.conversation-active .app-shell,body.conversation-active.pane-left .app-shell,body.terminal-active .app-shell,body.terminal-active.pane-left .app-shell{grid-template-areas:"sidebar" "main";grid-template-columns:minmax(0,1fr);grid-template-rows:auto auto;height:auto;min-height:100vh}
  .sidebar{height:auto;min-height:100vh;border-right:0;border-bottom:1px solid var(--border)}
  .task-list{overflow:visible}
  .main-col{display:none;height:auto;min-height:100vh}
  body.detail-active .sidebar{display:none}
  body.detail-active .main-col{display:flex}
  body.detail-active .detail-back{display:grid}
  .detail{overflow:visible}
  .pane-divider{display:none}
  .conversation-panel{position:fixed;inset:0;z-index:70;height:100dvh;border-left:0}
  .conversation-feed{min-height:0}
  .conversation-head-actions #conversation-swap{display:none}
  body.conversation-active .main-col{display:none}
  body.conversation-active .conversation-panel{display:flex}
  .overview-duo{grid-template-columns:1fr}
  .observability-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}
  /* Terminal panel overlays full-screen instead of occupying a grid column */
  .terminal-panel{position:fixed;inset:0;z-index:80;height:100dvh;border-left:0}
}
@media(max-width:620px){
  .command-rail{grid-template-columns:repeat(2,1fr)}
  .metric{min-height:80px;padding:13px 15px}
  .metric-value{font-size:26px}
  /* Keep the topbar on one line: clock and key hints are expendable */
  .clock{display:none}
  .topbar{flex-wrap:nowrap;gap:8px;padding:10px 14px}
  .topbar-leading{flex:1;gap:8px}
  .breadcrumb .crumb,.breadcrumb .crumb-sep{display:none}
  .topbar-actions{gap:6px}
  #conversation-toggle,#operator-terminal,#refresh{width:38px;height:38px;min-width:38px;justify-content:center;padding:0}
  #conversation-toggle{font-size:0}
  #conversation-toggle::before{content:"▤";font-size:19px}
  #operator-terminal .operator-title,#operator-terminal .operator-shortcuts,#refresh span,#refresh kbd{display:none}
  #operator-terminal::before{content:">_";font-family:var(--font-mono);font-size:15px}
  #refresh::before{content:"↻";font-size:20px}
  .detail-tabs{mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent);-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 28px),transparent)}
  .record-cols{grid-template-columns:1fr}
  .observability-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
`;
