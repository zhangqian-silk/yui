import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * MODELS VIEW — the content of the /models sections. The rail, reading column
 * and section headings come from views/manage; cards, badges, chips,
 * segmented controls and fields from the shared ui stylesheets. These rules
 * add the provider table, the catalog list and the quota meters. On phones
 * the provider table becomes stacked rows.
 */
export const MODELS_STYLES = `
/* Heading first, as on every management page: the page scope and the shared
   connection status sit under the current section's heading. The wrappers
   flatten into one column so only order changes, never the DOM. */
.models-body .manage-main{display:flex;flex-direction:column;gap:14px}
.models-body .models-root,.models-body .models-section:not([hidden]){display:contents}
.models-body .manage-main>*,.models-root>*,.models-section>*{width:100%;max-width:1120px;margin-left:auto;margin-right:auto}
.models-section>.manage-head{order:-1}
.models-body .manage-scope{margin-bottom:0}
.models-root .seg-btn[aria-pressed="true"]{background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-1),0 0 0 1px var(--line-2)}
.models-root{display:grid;gap:16px;min-width:0}
.models-section p:not(.kicker){color:var(--ink-2);font-size:var(--fs-sm);line-height:1.55;overflow-wrap:anywhere}
.models-section .manage-heading p:not(.kicker){color:var(--ink-3)}
.models-card{overflow:hidden}
.models-card>.card-body{gap:12px}
.models-status{display:grid;gap:8px;min-width:0}
.models-status:empty{display:none}
.models-facts{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;min-width:0}
.models-facts small{overflow-wrap:anywhere}
.models-facts .badge[hidden]{display:none}
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
.models-accounts{list-style:none;margin:0 auto;padding:0;display:grid;gap:14px;min-width:0}
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

@media(max-width:${BREAKPOINTS.small}px){
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
