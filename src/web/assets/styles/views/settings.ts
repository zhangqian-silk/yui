import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * SETTINGS VIEW — the content of the /settings sections (preferences, Skills,
 * Agents & server). The rail, reading column and section headings come from
 * views/manage. Settings panels share the card surface of the model pages:
 * the same border, radius, padding and title scale; nested panels (a Skill in
 * the catalog) sit one surface step lower instead of nesting full cards.
 */
export const SETTINGS_STYLES = `
.settings-card{display:block;padding:16px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);min-width:0}
.settings-card .settings-card{padding:14px;background:var(--surface-2)}
.settings-card>summary{display:flex;align-items:center;gap:8px;min-height:24px;font-size:var(--fs-md);font-weight:600;color:var(--ink);cursor:pointer;overflow-wrap:anywhere}
.settings-card h2{font-size:var(--fs-md);font-weight:600;color:var(--ink);margin-bottom:14px}
.settings-card h3{font-size:var(--fs-sm);font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.settings-card[open]>summary{margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid var(--line)}
.manage-section[data-section] .settings-card p,.settings-stack>p{color:var(--ink-2);font-size:var(--fs-sm);line-height:1.6;overflow-wrap:anywhere}
.settings-stack{display:grid;gap:16px;min-width:0}
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 24px;min-width:0}
.settings-field{padding:14px 0;border-bottom:1px solid var(--line);display:grid;gap:8px;min-width:0}
.settings-field small{color:var(--ink-3);overflow-wrap:anywhere}
.settings-field small:empty,.settings-field .settings-actions:empty{display:none}
.settings-field textarea{width:100%;min-height:88px;resize:vertical}
.settings-field input,.settings-field select{width:100%;min-width:0}
.settings-field .settings-reset{display:flex;gap:8px;align-items:center;font-size:var(--fs-xs)}
.settings-reset{display:flex;gap:8px;align-items:center;font-size:var(--fs-sm);color:var(--ink-2)}
.settings-reset input{width:auto;flex:none}
.settings-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center;min-width:0}
.settings-actions code{overflow-wrap:anywhere;min-width:0}
.settings-receipt{white-space:pre-wrap;overflow-wrap:anywhere}
.settings-error{color:var(--bad)!important}
.settings-observation{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fs-xs)}
.settings-search{position:sticky;top:0;z-index:1;padding:10px 0;background:var(--canvas)}
.settings-search input{width:100%;max-width:520px}
#settings-status:empty,#browser-receipt:empty{display:none}
.mono-line{overflow-wrap:anywhere}
@media(max-width:${BREAKPOINTS.small}px){
  .settings-grid{grid-template-columns:minmax(0,1fr)}
  .settings-card{padding:14px}
}
`;
