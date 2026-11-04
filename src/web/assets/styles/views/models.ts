import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * MODELS VIEW — the content of the /models sections. The rail, reading column
 * and section headings come from views/manage; cards, badges, chips,
 * segmented controls and fields from the shared ui stylesheets. These rules
 * add the provider table, the catalog list and the quota meters. On phones
 * the provider table becomes stacked rows.
 */
export const MODELS_STYLES = `
/* Model services: one panel per connection dimension, then optional
   components. Tables collapse into labelled stacks when a panel is narrow. */
.services-dims{display:grid;gap:14px;min-width:0}
.services-dim,.services-components,.services-observed{container:services/inline-size;display:grid;gap:10px;min-width:0;padding:16px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.services-dim-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 14px;min-width:0}
.services-dim-head>div{display:grid;gap:2px;min-width:0;flex:1 1 300px}
.services-dim-head h2,.services-observed>h2{color:var(--ink);font-size:var(--fs-md);font-weight:650}
.models-section .services-dim-head p,.models-section .services-observed>p{color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45;max-width:72ch}
.services-sub{display:flex;align-items:center;gap:8px;margin:4px 0 0;color:var(--ink-3);font-size:var(--fs-2xs);font-weight:650;letter-spacing:.04em}
.services-routes{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.services-route{display:grid;grid-template-columns:minmax(70px,auto) auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2);min-width:0}
.services-route-agent code{color:var(--ink);font-size:var(--fs-xs);font-weight:600}
.services-route-arrow{color:var(--ink-4)}
.services-route-target{display:grid;gap:1px;min-width:0}
.services-route-target strong{color:var(--ink);font-size:var(--fs-sm);font-weight:600;overflow-wrap:anywhere}
.services-route-target small{color:var(--ink-3);font-size:var(--fs-2xs);line-height:1.4;overflow-wrap:anywhere}
.services-route-target strong.services-native-unknown{color:var(--warn)}
p.services-native-unknown{margin:0 0 6px;padding:8px 12px;border-left:2px solid var(--warn);border-radius:0 var(--r-sm) var(--r-sm) 0;background:var(--warn-soft);color:var(--ink-2);font-size:var(--fs-xs);line-height:1.5;overflow-wrap:anywhere}
.services-table{display:grid;min-width:0;border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;font-size:var(--fs-xs)}
.services-row{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr);gap:10px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line);min-width:0}
.services-row:last-child{border-bottom:0}
.services-row>span{min-width:0;color:var(--ink-2);overflow-wrap:anywhere}
.services-row code{color:var(--ink);font-size:var(--fs-xs)}
.services-row .mono-line{font-family:var(--font-mono);font-size:var(--fs-2xs);color:var(--ink-2)}
.services-row-head{padding-top:6px;padding-bottom:6px;background:var(--surface-2);color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600}
.services-row-head>span{color:var(--ink-3)}
.services-table[data-services-table^=component] .services-row{grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr) minmax(0,1.6fr) minmax(0,1.2fr)}
.services-table[data-services-table^=component] .services-row>span:nth-child(5){grid-column:1/-1}
.services-table[data-services-table^=component] .services-row-head>span:nth-child(5){display:none}
.services-row .models-disclosure>summary{font-size:var(--fs-2xs);color:var(--ink-3)}
.services-key{display:grid;gap:2px;min-width:0}
.services-key small{color:var(--ink-4);font-size:10px}
.services-provider-name,.services-provider-state{display:grid;gap:2px;min-width:0}
.services-provider-name small,.services-provider-state small{color:var(--ink-3);font-size:var(--fs-2xs)}
.services-provider-state .badge{justify-self:start}
.services-component-list{display:grid;gap:12px}
.services-component{display:grid;gap:10px;min-width:0;padding:14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2)}
.services-component-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px 12px}
.services-component-head>div:first-child{display:grid;gap:2px;flex:1 1 260px;min-width:0}
.services-component-head h3{display:flex;align-items:baseline;gap:8px;color:var(--ink);font-size:var(--fs-sm);font-weight:650}
.services-component-head h3 .id{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:400}
.models-section .services-component-head p{color:var(--ink-3);font-size:var(--fs-xs)}
.services-component-tags{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.services-none{display:grid;gap:8px}
.services-none .settings-actions{margin:0}
.models-section .services-none>p{color:var(--ink-3);font-size:var(--fs-sm)}
.services-observed .models-disclosure{border-top:1px solid var(--line);padding-top:10px}
.models-section .services-footnote{color:var(--ink-4);font-size:var(--fs-2xs)}
.models-empty{padding:10px 12px;border:1px dashed var(--line-2);border-radius:var(--r-md);font-size:var(--fs-xs)}
@container services (max-width:640px){
  .services-dim,.services-components{padding:12px}
  .services-route{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px}
  .services-route-arrow{display:none}
  .services-route-target{grid-column:1/-1;grid-row:2}
  .services-row,.services-table[data-services-table^=component] .services-row{grid-template-columns:minmax(0,1fr);gap:3px}
  .services-row-head{display:none}
  .services-row>span[data-label]:not([data-label=""])::before{content:attr(data-label);display:block;color:var(--ink-4);font-size:10px;font-weight:600}
  .services-row>span:first-child::before{display:none!important}
}

/* Operator guide: free intent, contextual preview, copy. */
.guide-dialog{width:min(660px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:0;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-2)}
.guide-dialog::backdrop{background:rgba(0,0,0,.45)}
.guide-dialog[open]{display:flex;flex-direction:column;gap:8px;padding:18px 20px;overflow:auto}
.guide-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.guide-head h2{color:var(--ink);font-size:var(--fs-lg);font-weight:650}
.guide-head p{margin-top:3px;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.5}
.guide-close{font-size:18px}
.guide-label{margin-top:6px;color:var(--ink-2);font-size:var(--fs-xs);font-weight:600}
.guide-intent{min-height:78px;font-size:var(--fs-sm)}
.guide-preview-head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 10px;margin-top:6px;color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600}
.guide-preview-head small{color:var(--ink-4);font-weight:400}
.guide-preview{flex:0 1 auto;min-height:6rem;max-height:34vh;margin:0;padding:10px 12px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-md);background:var(--sunken);color:var(--ink-2);font:var(--fs-2xs)/1.6 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere}
.guide-preview:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.guide-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}
.guide-actions .spacer{flex:1 1 0}
.guide-result{flex:1 1 220px;margin:0;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
.guide-result:empty{display:none}
.guide-result[data-state=bad]{color:var(--bad)}
.guide-result[data-state=ok]{color:var(--ok)}
@media(max-width:620px){
  .guide-dialog[open]{padding:14px}
  .guide-actions .btn{flex:1 1 auto}
  .guide-preview{max-height:28vh}
}

.models-operator-prompt{width:100%;box-sizing:border-box;resize:vertical;min-height:10rem;line-height:1.7}
.models-operator .card-body{display:grid;gap:12px}
.models-advanced{margin-top:16px}
.models-advanced>summary{cursor:pointer;padding:12px 0}
/* Heading first, as on every management page: the page scope and the shared
   connection status sit under the current section's heading. The wrappers
   flatten into one column so only order changes, never the DOM. */
.models-body .manage-main{display:flex;flex-direction:column;gap:14px}
.models-body .models-root,.models-body .models-section:not([hidden]){display:contents}
.models-body .manage-main>*,.models-root>*,.models-section>*{width:100%;max-width:1120px;margin-left:auto;margin-right:auto}
.models-section>.manage-head{order:-1}
.models-section[data-section=quota]>.manage-head{order:0}
.models-body .manage-scope{margin-bottom:0}
.models-root .seg-btn[aria-pressed="true"]{background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-1),0 0 0 1px var(--line-2)}
.models-root{display:grid;gap:16px;min-width:0}
.models-section p:not(.kicker){color:var(--ink-2);font-size:var(--fs-sm);line-height:1.55;overflow-wrap:anywhere}
.models-section .manage-heading p:not(.kicker){color:var(--ink-3)}
.models-card{overflow:hidden}
.models-card>.card-body{gap:12px}
.models-disclosure{min-width:0;padding:14px 16px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}
.models-disclosure>summary{cursor:pointer;font-size:var(--fs-sm);font-weight:600;overflow-wrap:anywhere}
.models-disclosure[open]>summary{margin-bottom:12px}
.models-disclosure .models-disclosure{margin-top:12px;background:var(--surface-2)}
.models-record-facts{display:grid;gap:8px;margin:10px 0;min-width:0;font-size:var(--fs-sm)}
.models-record-facts>div{display:grid;grid-template-columns:minmax(80px,auto) minmax(0,1fr);gap:12px}
.models-record-facts dt{color:var(--ink-3);font-size:var(--fs-xs)}
.models-record-facts dd{margin:0;overflow-wrap:anywhere}
.models-configured-models{padding-left:18px;max-height:18rem;overflow:auto;font-size:var(--fs-sm)}
.models-configured-models li{overflow-wrap:anywhere;margin:5px 0}
.models-component-connection{padding-top:12px;border-top:1px solid var(--line)}
.models-disclosure .models-section:not([hidden]){display:grid;gap:12px;margin-top:12px}
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
.models-catalog-results>.models-count{padding:0 0 8px}
.models-catalog-results>.models-empty{padding:0}

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
.models-provider-form input:not([type=checkbox]),.models-provider-form select,.models-connection-form input,.models-connection-form select{width:100%;min-width:0}
.models-provider-form .settings-actions{margin-top:4px}

/* Connection settings */
.models-connection-form{display:grid;gap:16px;min-width:0}
.models-connection-form{grid-template-columns:repeat(2,minmax(0,1fr))}
.models-connection-form[data-resource-kind=binding]{grid-template-columns:1fr}
.models-access-summary{grid-column:1/-1;padding:12px;border:1px solid var(--accent-line);border-radius:var(--r-md);background:var(--accent-soft)}
.models-subhead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}
.models-connection-form>.settings-actions,.models-connection-form>.receipt,.models-connection-form>.models-receipt,.models-connection-form>.models-receipt-group{grid-column:1/-1;margin-top:0}
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

@media(max-width:${BREAKPOINTS.narrow}px){
}
@media(max-width:${BREAKPOINTS.small}px){
  .models-inspector{grid-template-columns:minmax(0,1fr)}
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
 .models-maintenance{margin-block:var(--space-3,12px);min-width:0}
 .models-maintenance textarea,.models-card textarea{width:100%;max-width:100%;box-sizing:border-box;font-family:var(--font-mono,monospace)}
 .models-operation-result{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto;max-width:100%}
@media(pointer:coarse){
  .models-disclosure>summary,.models-advanced>summary{min-height:40px;display:flex;align-items:center}
}
`;
