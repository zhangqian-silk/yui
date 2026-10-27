import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * SETTINGS VIEW — the content of the /settings sections (preferences, Skills,
 * Agents & server). The rail, reading column and section headings come from
 * views/manage. Settings panels share the card surface of the model pages:
 * the same border, radius, padding and title scale; nested panels (a Skill in
 * the catalog) sit one surface step lower instead of nesting full cards.
 */
export const SETTINGS_STYLES = `
.agent-access-map{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:stretch;padding:16px;border:1px solid var(--accent-line);border-radius:var(--r-lg);background:linear-gradient(135deg,var(--accent-soft),var(--surface) 75%);min-width:0}
.agent-access-step{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;align-content:start;min-width:0}
.agent-access-step>small{grid-row:1/3;display:grid;place-items:center;width:24px;height:24px;border-radius:var(--r-sm);background:var(--surface);border:1px solid var(--line);color:var(--ink-3);font:600 var(--fs-2xs)/1 var(--font-mono)}
.agent-access-step>strong{font-size:var(--fs-sm);color:var(--ink);overflow-wrap:anywhere}
.agent-access-step>span{grid-column:2;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
.agent-access-arrow{align-self:center;color:var(--ink-4)}
.agent-access-host{min-width:0}
.agent-access-layout{display:grid;grid-template-columns:minmax(250px,.72fr) minmax(0,1.6fr);gap:16px;align-items:start;min-width:0}
.settings-section-status{min-height:1.4em;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
.settings-section-status:empty{display:none}
.agent-index{display:grid;gap:12px;min-width:0;padding:14px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface-2)}
.agent-index-head{display:grid;gap:10px}
.agent-index-head h2{font-size:var(--fs-md);font-weight:600;color:var(--ink)}
.agent-index-head p{margin-top:4px;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.5}
.agent-area-filters{display:flex;flex-wrap:wrap;gap:5px}
.chip-tab{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 10px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--surface);color:var(--ink-2);font-size:var(--fs-xs);cursor:pointer}
.chip-tab[aria-pressed=true]{border-color:var(--accent-line);background:var(--accent-soft);color:var(--ink);font-weight:600}
.chip-tab .count{color:var(--ink-3);font-variant-numeric:tabular-nums}
.agent-index-group{display:grid;gap:6px;min-width:0}
.agent-index-group>h3{display:flex;justify-content:space-between;gap:8px;padding:0 4px;color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.agent-index-list{display:grid;gap:4px}
.agent-index-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto auto;gap:9px;align-items:center;width:100%;padding:9px;border:1px solid transparent;border-radius:var(--r-md);background:transparent;color:var(--ink-2);text-align:left;cursor:pointer;min-width:0}
.agent-index-row:hover{background:var(--surface);border-color:var(--line)}
.agent-index-row[aria-current=true]{background:var(--surface);border-color:var(--accent-line);box-shadow:inset 3px 0 0 var(--accent)}
.agent-index-row:focus-visible,.chip-tab:focus-visible,.agent-inspector-head .icon-btn:focus-visible,.models-supply-record summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.agent-index-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--surface-3);color:var(--ink-2);font:600 var(--fs-xs)/1 var(--font-mono);flex:none}
.agent-index-icon.tone-info{background:var(--info-soft);color:var(--info)}
.agent-index-icon.tone-accent{background:var(--accent-soft);color:var(--accent)}
.agent-index-icon.tone-idle{background:var(--surface-3);color:var(--ink-3)}
.agent-index-copy{display:grid;gap:2px;min-width:0}
.agent-index-copy strong{font-size:var(--fs-sm);font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.agent-index-copy small{color:var(--ink-3);font-size:var(--fs-2xs);overflow-wrap:anywhere}
.agent-index-facts{color:var(--ink-2);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.agent-index-caret{color:var(--ink-4);font-size:var(--fs-sm)}
.agent-inspector{min-width:0;min-height:18rem;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);overflow:hidden}
.agent-inspector-content{min-width:0}
.agent-inspector-empty{display:grid;place-items:center;align-content:center;gap:14px;min-height:18rem;padding:28px;text-align:center;background:linear-gradient(135deg,var(--surface-2),var(--surface))}
.agent-inspector-empty-mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--accent-line);border-radius:50%;background:var(--accent-soft);color:var(--accent);font:600 var(--fs-md)/1 var(--font-mono)}
.agent-inspector-empty h2{color:var(--ink);font-size:var(--fs-md);font-weight:600}
.agent-inspector-empty p{max-width:42ch;margin-top:5px;color:var(--ink-3);font-size:var(--fs-sm);line-height:1.55}
.agent-inspector-form{display:grid;gap:16px;padding:0 18px 18px;min-width:0}
.agent-inspector-head{display:flex;justify-content:space-between;gap:12px;align-items:start;padding:18px;border-bottom:1px solid var(--line);margin:0 -18px;background:var(--surface-2)}
.agent-inspector-identity{display:flex;gap:12px;align-items:flex-start;min-width:0}
.agent-inspector-identity>div{display:grid;gap:3px;min-width:0}
.agent-inspector-identity h2{font-size:var(--fs-lg);font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.agent-inspector-identity .kicker{color:var(--accent);font-size:var(--fs-2xs);font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.agent-inspector-identity .id{color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.agent-inspector-relation{margin:3px 0 0;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
.agent-inspector-head .icon-btn{flex:none}
.agent-inspector-form>.settings-receipt,.agent-inspector-form>.settings-actions:last-child{position:sticky;bottom:0;background:var(--surface)}
.agent-inspector-form>.settings-actions:last-child{padding-top:12px;border-top:1px solid var(--line);margin-top:0}
.agent-inspector-form>.settings-profile-apply{margin-bottom:0}
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
#browser-receipt:empty{display:none}
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
@media(max-width:${BREAKPOINTS.narrow}px){
  .agent-access-layout{grid-template-columns:minmax(220px,.7fr) minmax(0,1.5fr)}
}
@media(max-width:${BREAKPOINTS.small}px){
  .agent-access-map{grid-template-columns:minmax(0,1fr)}
  .agent-access-arrow{display:none}
  .agent-access-layout{grid-template-columns:minmax(0,1fr)}
  .agent-inspector{min-height:0}
  .agent-inspector-empty{min-height:12rem;padding:20px}
  .agent-index{max-height:24rem;overflow:auto}
  .agent-inspector-form{padding:0 14px 14px}
  .agent-inspector-head{margin:0 -14px;padding:14px}
  .agent-index-row{grid-template-columns:28px minmax(0,1fr) auto}
  .agent-index-caret{display:none}
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
