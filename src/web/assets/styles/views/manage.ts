import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * MANAGE VIEW — the frame shared by the management pages (/models and
 * /settings): a rail in the dashboard sidebar's language (brand, the fixed
 * Workbench / Models / Settings navigation with every section listed under
 * its area, the language control) beside one reading column whose sections
 * share a heading (area kicker, title, explanation). Page sheets add only
 * their own content. Below the narrow breakpoint the rail becomes a top bar:
 * brand and language, the three main destinations, then the current area's
 * sections, wrapping so every entry stays visible.
 */
export const MANAGE_STYLES = `
.manage-body{display:block;height:auto;min-height:100vh;min-height:100dvh;overflow:auto}
.manage-app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh;min-height:100dvh}

/* Rail */
.manage-rail{position:sticky;top:0;display:flex;flex-direction:column;height:100vh;height:100dvh;min-width:0;overflow-y:auto;background:var(--surface);border-right:1px solid var(--line)}
.manage-rail-head{flex:none;display:flex;align-items:center;gap:10px;height:var(--header-h);padding:0 12px 0 16px;border-bottom:1px solid var(--line)}
.manage-rail-head .brand{flex:1;color:var(--ink);text-decoration:none}
.manage-locale{flex:none;min-width:0}
.manage-locale select{height:30px;width:auto;max-width:124px;padding:0 26px 0 9px;line-height:28px;font-size:var(--fs-xs)}
.manage-nav{display:flex;flex-direction:column;gap:6px;padding:12px 8px 20px;min-width:0}
.manage-area{display:grid;gap:2px;min-width:0}
.manage-primary,.manage-link{position:relative;display:flex;align-items:center;min-width:0;border-radius:var(--r-md);text-decoration:none;white-space:nowrap;transition:background var(--t-fast),color var(--t-fast)}
.manage-primary span,.manage-link span{overflow:hidden;text-overflow:ellipsis}
.manage-primary{gap:9px;height:34px;padding:0 10px;color:var(--ink-2);font-size:var(--fs-md);font-weight:550}
.manage-primary .icon{width:16px;height:16px;flex:none;color:var(--ink-4)}
.manage-primary:hover,.manage-link:hover{background:var(--surface-3);color:var(--ink)}
.manage-primary[aria-current]{color:var(--ink)}
.manage-primary[aria-current] .icon{color:var(--accent)}
.manage-sections{display:grid;gap:1px;margin:0 0 4px 18px;padding-left:8px;border-left:1px solid var(--line);min-width:0}
.manage-link{gap:8px;height:30px;padding:0 10px;color:var(--ink-3);font-size:var(--fs-sm);font-weight:500}
.manage-link[aria-current="page"]{background:var(--surface-3);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-2)}
.manage-link[aria-current="page"]::before{content:"";position:absolute;left:-9px;top:6px;bottom:6px;width:2px;border-radius:2px;background:var(--accent)}
.manage-dirty{display:none;width:7px;height:7px;margin-left:auto;flex:none;border-radius:50%;background:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
.manage-link[data-dirty="true"] .manage-dirty{display:inline-block}

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
  .manage-app{grid-template-columns:minmax(0,1fr)}
  .manage-rail{position:static;height:auto;overflow:visible;border-right:0;border-bottom:1px solid var(--line)}
  .manage-rail-head{height:52px}
  .manage-nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;padding:8px 10px}
  .manage-area{display:contents}
  .manage-primary{justify-content:center;gap:7px;height:36px;padding:0 6px;font-size:var(--fs-sm);background:var(--surface-2);box-shadow:inset 0 0 0 1px var(--line)}
  .manage-primary[aria-current]{background:var(--surface-3);box-shadow:inset 0 0 0 1px var(--line-2),inset 0 -2px 0 var(--accent)}
  /* Only the current area's sections, as a wrapping strip under the tabs. */
  .manage-sections{display:none;grid-column:1/-1;grid-row:2;margin:4px 0 0;padding:0;border:0}
  .manage-area[data-active="true"] .manage-sections{display:flex;flex-wrap:wrap;gap:4px}
  .manage-link{flex:0 1 auto;max-width:100%;height:32px;padding:0 10px;border:1px solid var(--line)}
  .manage-link[aria-current="page"]{border-color:var(--line-2)}
  .manage-link[aria-current="page"]::before{left:10px;right:10px;top:auto;bottom:2px;width:auto;height:2px}
  .manage-main{padding:18px 14px 56px}
}
@media(max-width:${BREAKPOINTS.small}px){
  .manage-heading h1{font-size:var(--fs-xl)}
}
`;
