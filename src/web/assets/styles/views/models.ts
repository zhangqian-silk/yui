import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * MODELS VIEW — the /models page: a rail in the dashboard sidebar's language
 * (brand, back link, section links, footer) beside a reading column of routed
 * sections. Cards, badges, chips, segmented controls and fields come from the
 * shared ui stylesheets; these rules add the rail, the provider table, the
 * catalog list and the quota meters. Below the narrow breakpoint the rail
 * becomes a top bar and the provider table becomes stacked rows.
 */
export const MODELS_STYLES = `
.models-main .seg-btn[aria-pressed="true"]{background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-1),0 0 0 1px var(--line-2)}
.models-body{height:auto;min-height:100vh;min-height:100dvh;overflow:auto}
.models-app{display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh;min-height:100dvh}

/* Rail */
.models-rail{position:sticky;top:0;display:flex;flex-direction:column;gap:2px;height:100vh;height:100dvh;min-width:0;background:var(--surface);border-right:1px solid var(--line)}
.models-rail-head{gap:8px}
.models-rail-head .brand{color:var(--ink);text-decoration:none;flex:none}
.models-rail-tag{margin-left:auto}
.models-nav{display:flex;flex-direction:column;gap:2px;padding:0 8px;min-width:0}
.models-nav-group{margin:14px 10px 4px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.07em;text-transform:uppercase}
.models-nav-link{position:relative;display:flex;align-items:center;gap:9px;min-width:0;height:34px;padding:0 10px;border-radius:var(--r-md);color:var(--ink-2);font-size:var(--fs-md);font-weight:500;text-decoration:none;white-space:nowrap;transition:background var(--t-fast),color var(--t-fast)}
.models-nav-link span{overflow:hidden;text-overflow:ellipsis}
.models-nav-link .icon{width:16px;height:16px;flex:none;color:var(--ink-4)}
.models-nav-link:hover{background:var(--surface-3);color:var(--ink)}
.models-nav-link[aria-current="page"]{background:var(--surface-3);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-2)}
.models-nav-link[aria-current="page"]::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.models-nav-link[aria-current="page"] .icon{color:var(--accent)}
.models-nav-dirty{display:none;width:7px;height:7px;margin-left:auto;flex:none;border-radius:50%;background:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
.models-nav-link[data-dirty="true"] .models-nav-dirty{display:inline-block}
.models-home{margin:10px 8px 0;color:var(--ink-3);font-size:var(--fs-sm)}
.models-rail-foot{margin-top:auto;gap:8px}
.models-rail-foot .foot-btn{text-decoration:none}
.models-locale{margin-left:auto;min-width:0}
.models-locale select{height:32px;width:auto;max-width:120px}

/* Reading column */
.models-main{min-width:0;padding:28px var(--gutter) 72px}
.models-main>*{max-width:1120px;margin-left:auto;margin-right:auto}
.models-scope{margin-bottom:14px;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.5}
.models-root{display:grid;gap:16px;min-width:0}
.models-section{display:grid;gap:14px;min-width:0}
.models-section[hidden]{display:none}
.models-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 20px;min-width:0}
.models-heading{display:grid;gap:4px;flex:1 1 320px;min-width:0}
.models-heading h1{font-size:var(--fs-2xl);font-weight:650;letter-spacing:-.02em;line-height:1.2}
.models-heading p,.models-section p{color:var(--ink-2);font-size:var(--fs-sm);line-height:1.55;overflow-wrap:anywhere}
.models-heading p{color:var(--ink-3)}
.models-card{overflow:hidden}
.models-card>.card-body{gap:12px}
.models-status{display:grid;gap:8px;min-width:0}
.models-status:empty{display:none}
.models-facts{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;min-width:0}
.models-facts small{overflow-wrap:anywhere}
.models-notice{flex:1 1 280px;min-width:0}
.models-alert{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;border:1px solid var(--bad-soft);border-radius:var(--r-md);background:var(--bad-soft)}
.models-alert>.icon{width:16px;height:16px;color:var(--bad);flex:none}
.models-alert p{flex:1 1 240px;min-width:0}
.models-note{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2)}
.models-note>.icon{width:15px;height:15px;color:var(--info);flex:none}
.models-empty{color:var(--ink-3)!important;font-size:var(--fs-sm)}
.models-count{color:var(--ink-4);font-size:var(--fs-xs)!important;font-variant-numeric:tabular-nums}
.models-receipt{white-space:pre-wrap;overflow-wrap:anywhere}
.models-receipt-group .settings-actions{margin-top:8px}
.models-page input[type=checkbox],.models-body input[type=checkbox]{width:16px;height:16px;padding:0;accent-color:var(--accent)}

/* Toolbars: search plus segmented filters */
.models-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:12px 16px;border-bottom:1px solid var(--line);min-width:0}
.models-toolbar-flat{padding:0;border:0}
.models-toolbar .seg{flex-wrap:wrap}
.models-search{position:relative;display:flex;align-items:center;flex:1 1 240px;min-width:0;max-width:420px}
.models-search>.icon{position:absolute;left:10px;width:15px;height:15px;color:var(--ink-4);pointer-events:none}
.models-search input{width:100%;height:32px;padding:0 10px 0 32px;border-radius:var(--r-md);background:var(--surface-2)}
.models-results{display:grid;gap:0;min-width:0}
.models-results>.models-count{padding:8px 16px 0}
.models-results>.models-empty{padding:12px 16px 16px}

/* Provider table */
.models-table-wrap{min-width:0;overflow-x:auto}
.models-table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.models-table th{padding:10px 12px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.04em;text-align:left;text-transform:uppercase;border-bottom:1px solid var(--line);white-space:nowrap}
.models-table td{padding:11px 12px;border-bottom:1px solid var(--line);vertical-align:top;min-width:0}
.models-table tr:last-child td{border-bottom:0}
.models-table th:first-child,.models-table td:first-child{padding-left:16px}
.models-table th:last-child,.models-table td:last-child{padding-right:16px}
.models-table tbody tr:hover{background:var(--surface-2)}
.models-table tbody tr[aria-current="true"]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.models-cell-main{display:grid;gap:3px;justify-items:start;min-width:0}
.models-cell-main strong{font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.models-cell-main code{white-space:normal;overflow-wrap:anywhere}
.models-url{display:block;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-2)}
.models-row-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
.models-row-actions .btn{height:28px;padding:0 10px;font-size:var(--fs-xs)}
.models-reason{flex-basis:100%;max-width:260px;text-align:right;line-height:1.4;overflow-wrap:anywhere}
.models-danger{color:var(--bad)}
.models-danger:hover:not(:disabled){color:var(--bad);background:var(--bad-soft)}

/* Provider editor */
.models-editor{border-color:var(--accent-line)}
.models-form-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;min-width:0}
.models-form-head h2{font-size:var(--fs-md);font-weight:600;overflow-wrap:anywhere;min-width:0}
.models-provider-form .settings-grid{gap:14px 20px;align-items:start}
.models-provider-form input:not([type=checkbox]),.models-provider-form select,.models-connection-form input{width:100%;min-width:0}
.models-provider-form .settings-actions{margin-top:4px}

/* Connection settings */
.models-connection-form{display:grid;gap:16px;min-width:0}
.models-connection-form{grid-template-columns:repeat(2,minmax(0,1fr))}
.models-connection-form>.settings-actions,.models-connection-form>.receipt,.models-connection-form>.models-receipt-group{grid-column:1/-1;margin-top:0}
.models-fieldset{display:grid;align-content:start;gap:14px;min-width:0;margin:0;padding:0;border:0}
.models-fieldset legend{margin-bottom:12px;padding:0;color:var(--ink);font-size:var(--fs-sm);font-weight:600}
.models-explain h2{font-size:var(--fs-sm);font-weight:600}

/* Catalog */
.models-catalog{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0 20px;min-width:0}
.models-catalog-item{display:flex;align-items:center;justify-content:space-between;gap:10px;min-width:0;padding:7px 2px;border-bottom:1px solid var(--line)}
.models-catalog-item code{font-family:var(--font-mono);font-size:var(--fs-xs);color:var(--ink);overflow-wrap:anywhere;min-width:0}

/* Quota accounts, groups and meters */
.models-accounts{list-style:none;margin:0;padding:0;display:grid;gap:14px;min-width:0}
.models-account .card-title>span:first-child{font-family:var(--font-mono);font-size:var(--fs-sm)}
.models-groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px 28px;min-width:0}
.models-group{display:grid;align-content:start;gap:10px;min-width:0}
.models-group h3{font-size:var(--fs-sm);font-weight:600;color:var(--ink)}
.models-windows{list-style:none;margin:0;padding:0;display:grid;gap:12px;min-width:0}
.models-window{display:grid;gap:5px;min-width:0}
.models-window-line{display:flex;justify-content:space-between;gap:12px;font-size:var(--fs-sm);min-width:0}
.models-window-name{color:var(--ink-2);overflow-wrap:anywhere;min-width:0}
.models-window-value{color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.models-meter{position:relative;height:6px;border-radius:var(--r-pill);background:var(--surface-3);overflow:hidden}
.models-meter>span{position:absolute;inset:0 auto 0 0;border-radius:inherit;background:var(--tone)}
.models-meter.is-unknown{background:repeating-linear-gradient(90deg,var(--surface-3) 0 6px,transparent 6px 10px)}
.models-window small{font-size:var(--fs-xs);overflow-wrap:anywhere}
.models-balances{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0;padding-top:12px;border-top:1px solid var(--line);font-size:var(--fs-sm)}
.models-balances div{display:grid;gap:2px;min-width:0}
.models-balances dt{color:var(--ink-3);font-size:var(--fs-xs)}
.models-balances dd{margin:0;color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums}

@media(max-width:${BREAKPOINTS.narrow}px){
  .models-app{grid-template-columns:minmax(0,1fr)}
  .models-rail{position:sticky;top:0;z-index:10;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:0;border-right:0;border-bottom:1px solid var(--line)}
  .models-rail-head{order:1;flex:1 1 auto;height:48px;border-bottom:0}
  .models-home{order:2;margin:0 4px 0 0;padding:0 8px;height:32px}
  .models-home span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .models-rail-foot{order:3;margin:0;padding:0 10px 0 0;border-top:0}
  .models-rail-foot .foot-btn span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
  .models-nav{order:4;flex:1 0 100%;flex-direction:row;gap:2px;padding:0 10px 6px;overflow-x:auto;scrollbar-width:none;border-top:1px solid var(--line)}
  .models-nav::-webkit-scrollbar{display:none}
  .models-nav-group{display:none}
  .models-nav-link{flex:none;height:34px;margin-top:6px}
  .models-nav-link[aria-current="page"]::before{left:10px;right:10px;top:auto;bottom:-3px;width:auto;height:2px;border-radius:2px}
  .models-rail-tag{display:none}
  .models-main{padding:18px 14px 56px}
}
@media(max-width:${BREAKPOINTS.small}px){
  .models-heading h1{font-size:var(--fs-xl)}
  .models-connection-form{grid-template-columns:minmax(0,1fr)}
  .models-provider-form .settings-grid{grid-template-columns:minmax(0,1fr)}
  .models-search{max-width:none;flex-basis:100%}
  .models-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
  .models-table,.models-table tbody,.models-table tr,.models-table td{display:block;width:100%}
  .models-table tr{padding:10px 14px;border-bottom:1px solid var(--line)}
  .models-table tr:last-child{border-bottom:0}
  .models-table td{display:grid;grid-template-columns:84px minmax(0,1fr);gap:8px;align-items:start;padding:4px 0!important;border:0}
  .models-table td::before{content:attr(data-label);color:var(--ink-4);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding-top:3px}
  .models-url{max-width:none;white-space:normal;overflow-wrap:anywhere}
  .models-row-actions{justify-content:flex-start}
  .models-reason{text-align:left;max-width:none}
  .models-catalog{grid-template-columns:minmax(0,1fr)}
}
`;
