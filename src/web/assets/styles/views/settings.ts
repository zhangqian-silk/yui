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
.settings-search{padding:10px 0}
.settings-search input{width:100%;max-width:520px}
.settings-group-area{display:grid;gap:16px;min-width:0;padding:20px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface-2)}
.settings-group-area>header{display:grid;gap:6px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.settings-area-roles{border-top:3px solid var(--accent)}
.settings-area-agents .settings-group{background:var(--surface)}
.settings-group-area>header h2,.settings-area-title{font-size:var(--fs-md);font-weight:600;color:var(--ink)}
.settings-area-roles>header h2{font-size:var(--fs-lg)}
.settings-group-area>header p,.settings-area-help{font-size:var(--fs-sm);color:var(--ink-2);line-height:1.5}
.settings-area-count{display:inline-block;margin-left:8px;font-size:var(--fs-xs);font-weight:400;color:var(--ink-3)}
.settings-group-list{display:grid;gap:10px;min-width:0}
.settings-group-list-agents{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
.settings-group-list-agents>.settings-group[open]{grid-column:1/-1}
.settings-group>summary{display:grid;grid-template-columns:minmax(100px,.8fr) minmax(0,2fr) auto;gap:10px 16px;align-items:center;list-style:none}
.settings-group>summary::-webkit-details-marker{display:none}
.settings-group-name,.settings-summary-fact{display:grid;gap:4px;min-width:0}
.settings-group-name small,.settings-summary-fact small,.settings-summary-context{font-size:var(--fs-xs);font-weight:400;color:var(--ink-3)}
.settings-summary-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;min-width:0;font-size:var(--fs-sm);font-weight:400}
.settings-summary-fact>span{overflow-wrap:anywhere}
.settings-summary-context{grid-column:2}
.settings-group-affordance{grid-column:3;grid-row:1/3;color:var(--accent);font-size:var(--fs-xs);font-weight:400;white-space:nowrap}
.settings-group-affordance::after{content:" +";display:inline-block;margin-left:4px}
.settings-group[open]>summary .settings-group-affordance::after{content:" −"}
.settings-group-agents>summary{grid-template-columns:minmax(0,1fr) auto}
.settings-group-agents .settings-summary-facts{grid-column:1/-1;grid-row:2;padding:12px 0 4px;border-top:1px solid var(--line)}
.settings-group-agents .settings-summary-context{grid-column:1;grid-row:3}
.settings-group-agents .settings-group-affordance{grid-column:2;grid-row:1}
.settings-group-roles,.settings-group-profiles{padding:12px 16px;border-radius:var(--r-md)}
.settings-profile-library{border:1px solid var(--line);border-radius:var(--r-lg);padding:12px 20px;min-width:0;background:var(--surface)}
.settings-profile-library>summary{cursor:pointer;padding:8px 0;overflow-wrap:anywhere}
.settings-profile-library>summary .settings-area-help{display:block;margin-top:5px}
.settings-profile-library[open]>.settings-group-list{margin-top:12px}
.settings-group>summary:focus-visible,.settings-profile-library>summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px;border-radius:var(--r-sm)}
.settings-profile-apply{display:grid;gap:10px;padding:16px;margin-bottom:20px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2)}
.settings-profile-picker{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.settings-profile-picker>.field{flex:1;min-width:180px}
.settings-profile-picker select{width:100%}
.settings-profile-preview:empty{display:none}
.settings-profile-preview{display:grid;gap:8px}
.settings-profile-diff-scroll{overflow:auto;max-height:360px;border:1px solid var(--line);border-radius:var(--r-sm)}
.settings-profile-diff{border-collapse:collapse;width:100%;font-size:var(--fs-xs)}
.settings-profile-diff th,.settings-profile-diff td{padding:10px;vertical-align:top;text-align:left;border-bottom:1px solid var(--line)}
.settings-profile-diff thead th{background:var(--surface);font-weight:600}
.settings-profile-diff td{min-width:150px;max-width:400px}
.settings-profile-diff pre{white-space:pre-wrap;overflow-wrap:anywhere}
#settings-status:empty,#browser-receipt:empty{display:none}
.mono-line{overflow-wrap:anywhere}
.permissions-results{display:grid;gap:12px;min-width:0}
.permissions-scroll{overflow:auto;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
.permissions-table{border-collapse:collapse;width:100%;font-size:var(--fs-xs)}
.permissions-table caption{text-align:left;padding:14px;color:var(--ink-2)}
.permissions-table th,.permissions-table td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid var(--line)}
.permissions-table thead th{background:var(--surface-2);min-width:100px;font-weight:600}
.permissions-table th[scope=row]{min-width:240px;max-width:360px;font-weight:400}
.permissions-table small{display:block;color:var(--ink-3);margin-top:6px;overflow-wrap:anywhere}
.permissions-command{font-family:var(--font-mono);color:var(--accent);background:none;border:0;padding:4px 0;cursor:pointer;text-align:left;overflow-wrap:anywhere}
.permissions-command:hover{text-decoration:underline}
.permissions-table pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fs-xs);max-width:700px}
.permissions-visible{color:var(--ink);white-space:nowrap}
.permissions-hidden{color:var(--ink-3);white-space:nowrap}
@media(max-width:${BREAKPOINTS.small}px){
  .settings-grid{grid-template-columns:minmax(0,1fr)}
  .settings-card{padding:14px}
  .settings-group-area{padding:14px}
  .settings-profile-library{padding:10px 14px}
  .settings-group-list-agents{grid-template-columns:minmax(0,1fr)}
  .settings-group>summary{grid-template-columns:minmax(0,1fr) auto}
  .settings-group .settings-summary-facts{grid-column:1/-1;grid-row:2;gap:8px}
  .settings-group .settings-summary-context{grid-column:1/-1;grid-row:3}
  .settings-group .settings-group-affordance{grid-column:2;grid-row:1}
}
`;
