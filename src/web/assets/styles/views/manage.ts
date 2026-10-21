import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * MANAGE VIEW — what the management pages (/models and /settings) add to the
 * workbench frame (layout/workspace): the section list in the sidebar slot,
 * the language control in the top bar, and one reading column whose sections
 * share a heading (title, explanation). The rail, the collapsible list, the
 * top bar and the narrow-screen drawer are the workbench's own. Page sheets
 * add only their own content.
 */
export const MANAGE_STYLES = `
.manage-app[hidden],#models-root[hidden],#settings-root[hidden]{display:none}
.manage-body{--sidebar-w:240px}
body.manage-body.sidebar-collapsed{--sidebar-w:0px}

/* Section list: only the current area's sections (the rail switches areas). */
.manage-nav{flex:1;min-height:0;overflow-y:auto;padding:10px 8px 20px}
.manage-area:not([data-active="true"]){display:none}
.manage-sections{display:grid;gap:2px;min-width:0}
.manage-link{position:relative;display:flex;align-items:center;gap:8px;min-width:0;height:34px;padding:0 10px;border-radius:var(--r-md);color:var(--ink-3);font-size:var(--fs-sm);font-weight:500;text-decoration:none;white-space:nowrap;transition:background var(--t-fast),color var(--t-fast)}
.manage-link span{overflow:hidden;text-overflow:ellipsis}
.manage-link:hover{background:var(--surface-3);color:var(--ink)}
.manage-link[aria-current="page"]{background:var(--surface-3);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-2)}
.manage-link[aria-current="page"]::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.manage-dirty{display:none;width:7px;height:7px;margin-left:auto;flex:none;border-radius:50%;background:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
.manage-link[data-dirty="true"] .manage-dirty{display:inline-block}
@media(pointer:coarse){.manage-link{height:42px}}

/* Language control at the end of the top bar */
.top-locale{flex:none;min-width:0}
.top-locale select{height:30px;width:auto;max-width:124px;padding:0 26px 0 9px;line-height:28px;font-size:var(--fs-xs)}

/* Reading column and the shared section heading */
.manage-main{min-width:0;padding:28px var(--gutter) 72px}
.manage-main>*{max-width:1120px;margin-left:auto;margin-right:auto}
.manage-scope{margin-bottom:14px;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.5;overflow-wrap:anywhere}
.manage-section{display:grid;gap:14px;min-width:0}
.manage-section[hidden]{display:none}
.manage-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 20px;min-width:0}
.manage-heading{display:grid;gap:4px;flex:1 1 320px;min-width:0}
.manage-heading .kicker{margin:0}
.manage-heading h1{font-size:var(--fs-2xl);font-weight:650;letter-spacing:-.02em;line-height:1.2;overflow-wrap:anywhere}
.manage-heading p:not(.kicker){color:var(--ink-3);font-size:var(--fs-sm);line-height:1.55;overflow-wrap:anywhere}
.manage-body input[type=checkbox]{width:16px;height:16px;padding:0;accent-color:var(--accent)}

@media(max-width:${BREAKPOINTS.narrow}px){
  .manage-main{padding:20px 14px 56px}
  .manage-body .top-locale{display:none}
  /* The top bar already names the section; the page keeps only its explanation. */
  .manage-heading h1{display:none}
}
@media(max-width:${BREAKPOINTS.small}px){
  .manage-heading h1{font-size:var(--fs-xl)}
}
`;
