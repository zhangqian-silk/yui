// The /models page builds on the settings page frame (settings-page,
// settings-card, settings-stack); these rules add its lists and fact rows.
export const MODELS_STYLES = `
.models-locale{margin-left:auto;width:auto}
.models-facts{display:flex;flex-wrap:wrap;gap:8px;align-items:center;min-width:0}
.models-facts small{overflow-wrap:anywhere}
.models-list{list-style:none;margin:0;padding:0;display:grid;gap:10px;min-width:0}
.models-provider,.models-quota-item{display:grid;gap:8px;padding:14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2);min-width:0}
.models-provider .settings-actions{margin-top:4px}
.models-provider-head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;min-width:0}
.models-provider-head code{overflow-wrap:anywhere}
.models-provider-form{padding:16px;border:1px solid var(--line-2);border-radius:var(--r-md)}
.models-provider-form h3{font-size:var(--fs-sm)}
.models-provider-form .settings-grid{align-items:start}
.models-quota-controls{align-items:end}
.models-catalog{max-height:420px;overflow:auto;gap:4px}
.models-catalog-item{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:4px 2px;border-bottom:1px solid var(--line);min-width:0}
.models-catalog-item code{overflow-wrap:anywhere}
.models-windows{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.models-windows li{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:var(--fs-sm);color:var(--ink-2)}
.models-receipt{white-space:pre-wrap;overflow-wrap:anywhere}
.models-receipt-group .settings-actions{margin-top:8px}
.models-page input[type=checkbox]{width:16px;height:16px;padding:0;accent-color:var(--accent)}
@media(max-width:640px){.models-catalog-item{flex-wrap:wrap}}
`;
