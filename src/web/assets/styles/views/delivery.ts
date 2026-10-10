/*
 * DELIVERY VIEW — the Delivery tab's results: delivery projects and their
 * check lists, plus evidence files and the artifact viewer.
 */
export const DELIVERY_STYLES = `
/* Delivery results */
.delivery-stack>.sub-head:not(:first-child){margin-top:10px}
.delivery-project .record-head strong{overflow-wrap:anywhere}
.check-list{list-style:none;margin:0;padding:0;display:grid;gap:4px;font-size:var(--fs-xs)}
.check-list li{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:2px 8px;min-width:0}
.check-details{grid-column:2/-1;white-space:pre-wrap;overflow-wrap:anywhere}

/* Evidence files */
.file-list{display:grid;grid-template-columns:minmax(0,1fr);gap:2px}
.file-list:empty{display:none}
.file-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 8px;border:0;border-radius:var(--r-sm);background:transparent;text-align:left;font-size:var(--fs-sm);color:var(--ink-2)}
.file-row:hover{background:var(--surface-3);color:var(--ink)}
.file-row[aria-current="true"]{background:var(--accent-soft);color:var(--ink)}
.file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:var(--fs-xs)}
.file-viewer{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;gap:8px}
.file-viewer:empty{display:none}
.viewer-head{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm)}
.viewer-ref code{white-space:normal;overflow-wrap:anywhere}
.artifact-text{max-height:480px;color:var(--ink)}
.record-actions{flex-wrap:wrap}
.record-actions input{min-width:0;max-width:100%;flex:1 1 180px}
.composer-wrap .row-stack{overflow-wrap:anywhere;max-height:180px;overflow:auto}
.composer-wrap input[type=file]{max-width:100%}
`;
