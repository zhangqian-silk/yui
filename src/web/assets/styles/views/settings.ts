import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * SETTINGS VIEW — the content of the /settings sections (preferences, Skills,
 * Agents & server). The rail, reading column and section headings come from
 * views/manage. Settings panels share the card surface of the model pages:
 * the same border, radius, padding and title scale; nested panels (a Skill in
 * the catalog) sit one surface step lower instead of nesting full cards.
 */
export const SETTINGS_STYLES = `
/* Agent access: a dense index leading to one focused inspector. */
.agent-access{--agent-index-w:clamp(250px,25vw,310px);gap:12px}
.agent-index-toggle{display:none}
.agent-access-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;min-width:0}
.agent-access-search{flex:1 1 320px;max-width:560px;padding:0}
.agent-access-toolbar #agent-management-actions{flex:0 1 auto;justify-content:flex-end;margin:0}
.agent-access-toolbar #agent-management-actions .settings-actions{margin:0}
.agent-access-toolbar #agent-management-actions>p{max-width:56ch;margin:5px 0 0;text-align:right}
.agent-supported{max-width:64ch;color:var(--ink-3);font-size:var(--fs-2xs)}
.agent-supported>summary{cursor:pointer;text-align:right}
.agent-supported>p{margin:4px 0 0;line-height:1.45}
.agent-access-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 16px;min-width:0;margin-top:-4px}
.agent-access-meta .settings-section-status{flex:1 1 360px;min-height:0;margin:0}
.agent-access-help{min-width:0;color:var(--ink-3);font-size:var(--fs-xs)}
.agent-access-help>summary{cursor:pointer;padding:3px 0;color:var(--ink-3);font-weight:500}
.agent-access-help[open]>summary{color:var(--ink-2)}
.agent-access-help-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:8px;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2)}
.agent-access-help-grid span{display:grid;gap:2px;min-width:0}
.agent-access-help-grid strong{color:var(--ink-2);font-size:var(--fs-xs);font-weight:600;overflow-wrap:anywhere}
.agent-access-help-grid small{color:var(--ink-3);font-size:var(--fs-2xs);line-height:1.45;overflow-wrap:anywhere}
.agent-access-host{min-width:0}
.agent-access-layout{display:grid;grid-template-columns:var(--agent-index-w) minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.agent-index{display:grid;gap:10px;min-width:0;padding:12px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface-2);position:sticky;top:12px;max-height:calc(100vh - var(--header-h) - 36px);overflow:auto;overscroll-behavior:contain}
.agent-index-head{display:grid;gap:8px}
.agent-index-head h2{font-size:var(--fs-md);font-weight:600;color:var(--ink)}
.agent-index-head p{margin-top:2px;color:var(--ink-3);font-size:var(--fs-2xs);line-height:1.45}
.agent-area-filters{display:flex;flex-wrap:wrap;gap:4px}
.chip-tab{display:inline-flex;align-items:center;gap:5px;min-height:28px;padding:0 9px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--surface);color:var(--ink-2);font-size:var(--fs-2xs);cursor:pointer}
.chip-tab[aria-pressed=true]{border-color:var(--accent-line);background:var(--accent-soft);color:var(--ink);font-weight:600}
.chip-tab .count{color:var(--ink-3);font-variant-numeric:tabular-nums}
.agent-index-group{display:grid;gap:4px;min-width:0;padding-top:4px;border-top:1px solid var(--line)}
.agent-index-group:first-of-type{border-top:0;padding-top:0}
.agent-index-group>h3{display:flex;justify-content:space-between;gap:8px;padding:3px 4px;margin:0;color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.04em}
.agent-index-list{display:grid;gap:2px}
.agent-index-row{display:grid;grid-template-columns:26px minmax(0,1fr) auto auto;gap:8px;align-items:center;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:var(--r-md);background:transparent;color:var(--ink-2);text-align:left;cursor:pointer;min-width:0}
.agent-index-row:hover{background:var(--surface);border-color:var(--line)}
.agent-index-row[aria-current=true]{background:var(--surface);border-color:var(--accent-line);box-shadow:inset 3px 0 0 var(--accent)}
.agent-index-row:focus-visible,.chip-tab:focus-visible,.agent-inspector-head .icon-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.agent-index-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:var(--surface-3);color:var(--ink-2);font:600 var(--fs-2xs)/1 var(--font-mono);flex:none}
.agent-index-icon.tone-info{background:var(--info-soft);color:var(--info)}
.agent-index-icon.tone-accent{background:var(--accent-soft);color:var(--accent)}
.agent-index-icon.tone-idle{background:var(--surface-3);color:var(--ink-3)}
.agent-index-copy{display:grid;gap:1px;min-width:0}
.agent-index-copy strong{font-size:var(--fs-sm);font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.agent-index-copy small{color:var(--ink-3);font-size:var(--fs-2xs);overflow-wrap:anywhere}
.agent-index-facts{color:var(--ink-2);font-size:var(--fs-2xs);line-height:1.35;overflow-wrap:anywhere}
.agent-index-caret{color:var(--ink-4);font-size:var(--fs-md)}
.agent-index-row .badge{font-size:var(--fs-2xs);white-space:nowrap}
.agent-more{padding:0;margin:0}
.agent-more .btn{margin:0}
.agent-inspector{min-width:0;min-height:18rem;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);overflow:clip}
.agent-inspector-content{min-width:0}
.agent-inspector-empty{display:grid;place-items:center;align-content:center;gap:10px;min-height:18rem;padding:24px;text-align:center;background:linear-gradient(135deg,var(--surface-2),var(--surface))}
.agent-inspector-empty-mark{display:grid;place-items:center;width:42px;height:42px;border:1px solid var(--accent-line);border-radius:50%;background:var(--accent-soft);color:var(--accent);font:600 var(--fs-md)/1 var(--font-mono)}
.agent-inspector-empty h2{color:var(--ink);font-size:var(--fs-md);font-weight:600}
.agent-inspector-empty p{max-width:38ch;margin-top:3px;color:var(--ink-3);font-size:var(--fs-sm);line-height:1.5}
.agent-inspector-form{display:grid;gap:0;padding:0;min-width:0}
.agent-inspector-head{display:flex;justify-content:space-between;gap:12px;align-items:start;padding:16px 18px 14px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,var(--surface-2),var(--surface));min-width:0}
.agent-inspector-identity{display:flex;gap:11px;align-items:flex-start;min-width:0}
.agent-inspector-identity>div{display:grid;gap:2px;min-width:0}
.agent-inspector-identity h2{font-size:var(--fs-lg);font-weight:650;color:var(--ink);overflow-wrap:anywhere}
.agent-inspector-identity .kicker{color:var(--accent);font-size:var(--fs-2xs);font-weight:700;letter-spacing:.06em}
.agent-inspector-identity .id{color:var(--ink-3);font-size:var(--fs-2xs);overflow-wrap:anywhere}
.agent-inspector-relation{margin:2px 0 0;color:var(--ink-3);font-size:var(--fs-xs);line-height:1.4}
.agent-inspector-head .icon-btn{flex:none}
.agent-inspector-canvas{display:grid;gap:12px;padding:14px 18px 22px;min-width:0}
.agent-notice{color:var(--ink-3)!important;font-size:var(--fs-xs)!important;line-height:1.5!important;margin:0 0 2px}
.agent-readonly-note{padding:9px 11px;border:1px solid var(--warn-soft);border-radius:var(--r-md);background:var(--warn-soft);color:var(--ink-2);font-size:var(--fs-xs)}
.agent-config-section{display:grid;gap:10px;min-width:0;padding:14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2)}
.agent-config-primary{background:var(--surface)}
.agent-config-section>h3,.agent-section-heading h3{font-size:var(--fs-sm);font-weight:650;color:var(--ink);margin:0}
.agent-section-heading{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;min-width:0}
.agent-section-heading p{margin:2px 0 0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45}
.agent-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 18px;min-width:0}
.agent-field-grid-primary{grid-template-columns:repeat(2,minmax(0,1fr))}
.settings-field{padding:0 0 12px;border-bottom:1px solid var(--line);display:grid;gap:6px;min-width:0}
.agent-field-grid .settings-field:last-child,.agent-field-grid .settings-field:nth-last-child(-n+2){border-bottom:0;padding-bottom:0}
.settings-field>.field{gap:5px;min-width:0}
.settings-field label.field>span{color:var(--ink-2);font-size:var(--fs-xs);font-weight:550}
.agent-field-help{margin:0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45!important}
.settings-field>small{color:var(--ink-4);font-size:var(--fs-2xs);line-height:1.4}
.agent-native-card{display:grid;gap:11px;padding:14px;border:1px solid var(--info-soft);border-radius:var(--r-md);background:linear-gradient(135deg,var(--info-soft),var(--surface) 70%)}
.agent-native-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
.agent-native-head h3{font-size:var(--fs-sm);font-weight:650;color:var(--ink)}
.agent-native-head p{max-width:72ch;margin:2px 0 0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45}
.agent-fact-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.agent-fact-grid>div{display:grid;gap:3px;min-width:0;padding-right:10px;border-right:1px solid var(--line)}
.agent-fact-grid>div:last-child{border-right:0}
.agent-fact-grid dt{color:var(--ink-3);font-size:var(--fs-2xs)}
.agent-fact-grid dd{margin:0;color:var(--ink);font-family:var(--font-mono);font-size:var(--fs-xs);overflow-wrap:anywhere}
.agent-native-note{margin:0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45}
.agent-cached-models>summary{cursor:pointer;color:var(--ink-2);font-size:var(--fs-xs);font-weight:550}
.agent-cached-models ul{columns:2;column-gap:20px;margin:8px 0 0;padding-left:16px;font-size:var(--fs-xs)}
.agent-cached-models li{margin:3px 0;overflow-wrap:anywhere;break-inside:avoid}
.agent-cached-models small{color:var(--ink-3)}
.agent-status-pill{display:inline-flex;align-items:center;padding:2px 7px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--surface);color:var(--ink-3);font-size:var(--fs-2xs);white-space:nowrap}
.agent-status-pill.tone-info{border-color:var(--info-soft);color:var(--info)}
.agent-capability-section{gap:9px}
.agent-capability-section .settings-actions{margin:0;flex-wrap:nowrap}
.agent-capability-info{margin:0!important;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important}
.agent-capability-output{display:grid;gap:6px;min-width:0}
.agent-capability-output p{margin:0;color:var(--ink-2);font-size:var(--fs-xs);line-height:1.45}
.agent-technical>summary,.agent-source>summary{cursor:pointer;color:var(--ink-3);font-size:var(--fs-xs)}
.settings-observation{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fs-2xs);padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--code-bg,var(--surface-2))}
.agent-source{border-top:1px solid var(--line);padding-top:10px}
.agent-source-body{display:grid;gap:7px;margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface-2);font-size:var(--fs-xs)}
.agent-source-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;align-items:baseline;min-width:0}
.agent-source-row>span:first-child{color:var(--ink-3);font-size:var(--fs-2xs)}
.agent-source-row strong,.agent-source-row code,.agent-source-row time{min-width:0;color:var(--ink-2);font-size:var(--fs-xs);overflow-wrap:anywhere}
.agent-profile-section{display:grid;gap:10px;padding:14px;margin:0;border:1px solid var(--accent-line);border-radius:var(--r-md);background:var(--accent-soft)}
.agent-profile-section h3{font-size:var(--fs-sm);font-weight:650;color:var(--ink)}
.agent-profile-section>p{margin:0;color:var(--ink-2)!important;font-size:var(--fs-xs)!important;line-height:1.5}
.settings-profile-picker{align-items:end;flex-wrap:nowrap}
.settings-profile-preview{display:grid;gap:8px}
.settings-profile-preview h4{font-size:var(--fs-xs);font-weight:600;color:var(--ink)}
.settings-profile-preview>p{margin:0;font-size:var(--fs-xs)}
.settings-profile-diff-scroll{max-height:280px}
.agent-live-ack{padding:9px 11px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2)}
.agent-action-bar{position:sticky;bottom:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:11px 18px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(8px)}
.agent-foot-status{display:grid;gap:2px;min-width:0;flex:1 1 260px}
.agent-dirty-indicator{color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.agent-dirty-indicator[data-dirty=true]{color:var(--warn);font-weight:600}
.agent-receipt{margin:0;color:var(--ink-3);font-size:var(--fs-2xs);line-height:1.45;max-height:5.6em;overflow:auto}
.agent-receipt:empty{display:none}
.agent-action-buttons{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto}
.agent-action-buttons .btn{min-height:32px}
@supports not (background:color-mix(in srgb,var(--surface) 92%,transparent)){
  .agent-action-bar{background:var(--surface)}
}

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
  .agent-access{--agent-index-w:235px}
  .agent-access-layout{grid-template-columns:var(--agent-index-w) minmax(0,1fr)}
  .agent-field-grid-primary,.agent-field-grid{grid-template-columns:minmax(0,1fr)}
  .agent-field-grid .settings-field:nth-last-child(-n+2){border-bottom:1px solid var(--line);padding-bottom:12px}
  .agent-field-grid .settings-field:last-child{border-bottom:0;padding-bottom:0}
}
@media(max-width:${BREAKPOINTS.small}px){
  .agent-access{gap:10px}
  .agent-access-toolbar{align-items:stretch}
  .agent-access-toolbar #agent-management-actions{justify-content:flex-start}
  .agent-access-toolbar #agent-management-actions>p{text-align:left}
  .agent-supported>summary{text-align:left}
  .agent-access-meta{display:grid}
  .agent-access-help-grid{grid-template-columns:minmax(0,1fr)}
  .agent-access-layout{grid-template-columns:minmax(0,1fr);gap:10px}
  .agent-index-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:38px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface-2);color:var(--ink-2);font-size:var(--fs-xs);font-weight:600;cursor:pointer}
  .agent-index-toggle[aria-expanded=true] .agent-index-toggle-mark{transform:rotate(180deg)}
  .agent-index-toggle-mark{color:var(--ink-4);font-size:var(--fs-sm);transition:transform .15s ease}
  .agent-index{position:static;max-height:none;padding:10px}
  .agent-index.is-collapsed{display:none}
  .agent-index-head p{display:none}
  .agent-index-row{grid-template-columns:26px minmax(0,1fr) auto;padding:8px}
  .agent-index-caret{display:none}
  .agent-index-row .badge{grid-column:2/-1;justify-self:start}
  .agent-inspector{min-height:0;border-radius:var(--r-md)}
  .agent-inspector-empty{min-height:12rem;padding:24px}
  .agent-inspector-head{padding:14px}
  .agent-inspector-canvas{padding:12px 12px 18px;gap:10px}
  .agent-config-section{padding:12px}
  .agent-fact-grid{grid-template-columns:minmax(0,1fr)}
  .agent-fact-grid>div{border-right:0;padding-right:0;padding-bottom:6px;border-bottom:1px solid var(--line)}
  .agent-fact-grid>div:last-child{border-bottom:0}
  .agent-cached-models ul{columns:1}
  .agent-action-bar{padding:10px 12px;position:sticky;background:var(--surface)}
  .agent-action-buttons{width:100%;margin-left:0}
  .agent-action-buttons .btn{flex:1 1 auto}
  .agent-source-row{grid-template-columns:minmax(0,1fr)}
  .agent-source-row>span:first-child{font-size:var(--fs-2xs)}
  .settings-profile-picker{flex-wrap:wrap}
  .settings-grid,.settings-group-list-agents{grid-template-columns:minmax(0,1fr)}
  .settings-card{padding:14px}
  .settings-group-area{padding:14px}
  .settings-profile-library{padding:10px 14px}
  .settings-group>summary{grid-template-columns:minmax(0,1fr) auto}
  .settings-group .settings-summary-facts{grid-column:1/-1;grid-row:2;gap:8px}
  .settings-group .settings-summary-context{grid-column:1/-1;grid-row:3}
  .settings-group .settings-group-affordance{grid-column:2;grid-row:1}
}
`;
