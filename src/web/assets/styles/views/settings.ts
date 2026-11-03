import { BREAKPOINTS } from "../../shared/geometry.js";

/*
 * SETTINGS VIEW — the content of the /settings sections (preferences, Skills,
 * Agents & server). The rail, reading column and section headings come from
 * views/manage. Settings panels share the card surface of the model pages:
 * the same border, radius, padding and title scale; nested panels (a Skill in
 * the catalog) sit one surface step lower instead of nesting full cards.
 */
export const SETTINGS_STYLES = `
/* Execution configs and Agents: full-width tables; a selected row opens its
   detail beside the list when there is room, otherwise in place of it. */
.access-page{gap:12px}
.access-head{align-items:center}
.access-head .manage-heading{flex:1 1 420px}
.access-head-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.access-head-actions .btn{min-height:34px}
.btn-sm{height:28px;padding:0 10px;font-size:var(--fs-xs)}
.access-host{min-width:0}
.access-frame{container:access/inline-size;display:grid;gap:10px;min-width:0}
.access-toolbar{display:flex;align-items:center;gap:12px;min-width:0}
.access-search{flex:0 1 340px;min-width:0}
.access-search input{height:32px}
.access-status{margin:0;color:var(--ink-3);font-size:var(--fs-2xs)}
.access-status:empty{display:none}
.access-more:has(.btn[hidden]){display:none}
.access-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.access-list{container:accesslist/inline-size;display:grid;gap:18px;min-width:0}
.access-detail{display:none;min-width:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);overflow:clip}
.access-layout[data-detail=open] .access-detail{display:block}
.access-block{display:grid;gap:8px;min-width:0}
.access-block-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;min-width:0}
.access-block-head h2{display:flex;align-items:center;gap:8px;color:var(--ink);font-size:var(--fs-md);font-weight:650}
.access-block-head p{color:var(--ink-3);font-size:var(--fs-xs);line-height:1.45}
/* Every row is its own grid, so all tracks must be content-independent or the
   columns drift between rows (e.g. a row carrying a status badge). */
.access-table{--cols:minmax(130px,1.1fr) minmax(130px,1fr) minmax(190px,1.6fr) 136px;min-width:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);overflow:hidden}
.access-table[data-columns=agents]{--cols:minmax(96px,.8fr) minmax(130px,1fr) minmax(150px,1.2fr) minmax(130px,1.1fr) minmax(90px,.9fr) 96px}
.access-row-head,.access-row{display:grid;grid-template-columns:var(--cols);gap:12px;align-items:center;padding:0 14px}
.access-row-head{min-height:32px;border-bottom:1px solid var(--line);background:var(--surface-2);color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;letter-spacing:.02em}
.access-row{width:100%;min-height:54px;padding-top:9px;padding-bottom:9px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;color:var(--ink-2);font:inherit;text-align:left;cursor:pointer;transition:background var(--t-fast)}
.access-row:last-child{border-bottom:0}
.access-row:hover{background:var(--surface-2)}
.access-row[aria-current=true]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.access-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.access-cell{display:grid;gap:2px;min-width:0;font-size:var(--fs-xs)}
.access-cell strong{color:var(--ink);font-size:var(--fs-sm);font-weight:600;overflow-wrap:anywhere}
.access-cell small{color:var(--ink-3);font-size:var(--fs-2xs);line-height:1.35;overflow-wrap:anywhere}
.access-cell-name small{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.access-cell-kind{display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px}
.access-model,.access-route,.access-agent{color:var(--ink);font-family:var(--font-mono);font-size:var(--fs-xs);overflow-wrap:anywhere}
.access-agent{display:inline-flex;flex-wrap:wrap;align-items:center;gap:6px}
.access-effort{color:var(--ink-3)}
.access-source.source-route{color:var(--info)}
.access-source.source-native{color:var(--ink-4)}
.access-muted{color:var(--ink-4)}
.access-warn{color:var(--warn)!important}
.access-cell-status{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.access-cell-status .badge{font-size:var(--fs-2xs);white-space:nowrap}
.access-chip{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:var(--r-pill);background:var(--surface-3);color:var(--ink-2);font:600 10px/1 var(--font-sans);white-space:nowrap}
.access-chip.adapter-codex{background:var(--info-soft);color:var(--info)}
.access-chip.adapter-claude{background:var(--accent-soft);color:var(--accent)}
.access-empty{padding:12px 14px;border:1px dashed var(--line-2);border-radius:var(--r-lg);color:var(--ink-3);font-size:var(--fs-sm)}
.access-footnote{color:var(--ink-3);font-size:var(--fs-xs)}
/* Compact rows: a narrow list (a phone, or beside an open detail). */
@container accesslist (max-width:640px){
  .access-row-head{display:none}
  .access-row{grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;min-height:0;padding:10px 12px}
  .access-cell-name{grid-column:1;grid-row:1}
  .access-cell-status{grid-column:2;grid-row:1;align-self:start}
  .access-cell:not(.access-cell-name):not(.access-cell-status){grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px}
  .access-cell-users{color:var(--ink-3)}
  .access-cell-users:empty{display:none}
}
/* The six-column Agent table needs more room before it can stay a table. */
@container accesslist (min-width:640.02px) and (max-width:800px){
  .access-table[data-columns=agents] .access-row-head{display:none}
  .access-table[data-columns=agents] .access-row{grid-template-columns:minmax(0,1fr) auto;gap:3px 10px;min-height:0;padding:10px 12px}
  .access-table[data-columns=agents] .access-cell-name{grid-column:1;grid-row:1}
  .access-table[data-columns=agents] .access-cell-status{grid-column:2;grid-row:1;align-self:start}
  .access-table[data-columns=agents] .access-cell:not(.access-cell-name):not(.access-cell-status){grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px}
}
@container access (min-width:900px){
  .access-layout[data-detail=open]{grid-template-columns:minmax(280px,.8fr) minmax(0,1.2fr)}
  .access-layout[data-detail=open] .access-detail{position:sticky;top:12px;max-height:calc(100dvh - var(--header-h) - 26px);overflow:auto;overscroll-behavior:contain}
  .access-layout[data-detail=open] .access-cell-users,.access-layout[data-detail=open] .access-cell-kind small{display:none}
  .access-back-label{display:none}
  .access-layout .access-detail-head{grid-template-columns:minmax(0,1fr) auto auto;grid-template-areas:"title guide close";align-items:start}
  .access-layout .access-detail-head>.access-back{width:32px;padding:0;margin-right:-8px}
}
@container access (max-width:899.98px){
  .access-layout[data-detail=open] .access-list{display:none}
  .access-close-mark{display:none}
}
/* Detail: one frame, flat inside. Header = name + launch facts on one line. */
.access-detail-head{display:grid;grid-template-columns:auto minmax(0,1fr) auto;grid-template-areas:"close . guide" "title title title";align-items:center;gap:8px 10px;padding:14px 18px 12px;border-bottom:1px solid var(--line);min-width:0}
.access-detail-head>.access-back{grid-area:close;justify-self:start}
.access-detail-head>.access-detail-guide{grid-area:guide}
.access-detail-title{grid-area:title;display:grid;gap:4px;min-width:0}
.access-back{height:30px;padding:0 8px;color:var(--ink-2);font-size:var(--fs-xs)}
.access-close-mark{font-size:18px;line-height:1}
.access-detail-head h2{color:var(--ink);font-size:var(--fs-lg);font-weight:650;line-height:1.25;overflow-wrap:anywhere}
.access-detail-guide{color:var(--ink-2)}
.access-detail-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 18px}
.access-detail-facts:empty{display:none}
.access-fact{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px;min-width:0}
.access-fact>span{color:var(--ink-3);font-size:var(--fs-2xs)}
.access-fact>strong{color:var(--ink);font-family:var(--font-mono);font-size:var(--fs-xs);font-weight:550;overflow-wrap:anywhere}
.access-fact>small{color:var(--ink-3);font-size:var(--fs-2xs)}
.access-fact.tone-warn>strong{color:var(--warn)}
.access-derived{display:grid;gap:10px;min-width:0}
.access-derived:empty{display:none}
.access-derived>.access-warn{margin:0;padding:8px 12px;border-left:2px solid var(--warn);border-radius:0 var(--r-sm) var(--r-sm) 0;background:var(--warn-soft);color:var(--ink-2);font-size:var(--fs-xs);line-height:1.5}
.access-derived-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:4px 12px;min-width:0}
.access-derived-row>span{padding-top:2px;color:var(--ink-3);font-size:var(--fs-2xs)}
.access-derived-row>div{display:grid;gap:4px;min-width:0}
.access-derived-row>.access-chips{display:flex;flex-wrap:wrap;gap:6px}
.access-derived p{margin:0;color:var(--ink-2);font-size:var(--fs-xs);line-height:1.5;overflow-wrap:anywhere}
.access-link{justify-self:start;color:var(--accent);font-size:var(--fs-xs)}
.access-chips{display:flex;flex-wrap:wrap;gap:6px}
.access-chip-link{height:26px;padding:0 10px;border:1px solid var(--line-2);background:var(--surface);font:500 var(--fs-xs)/1 var(--font-mono);cursor:pointer}
.access-chip-link:hover{border-color:var(--accent-line);color:var(--ink)}
/* Field groups are separated by a hairline, never boxed. */
.agent-config-section.agent-config-more{padding:0;gap:0}
.agent-config-more>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:44px;padding:0;cursor:pointer;list-style:none}
.agent-config-more>summary::-webkit-details-marker{display:none}
.agent-config-more>summary::after{content:"";flex:none;width:7px;height:7px;margin-left:auto;border-right:1.5px solid var(--ink-3);border-bottom:1.5px solid var(--ink-3);transform:rotate(45deg) translateY(-2px);transition:transform var(--t-fast)}
.agent-config-more[open]>summary::after{transform:rotate(225deg) translateY(-1px)}
.agent-config-more>summary h3{margin:0}
.agent-config-more>summary:hover h3{color:var(--ink)}
.agent-config-more>summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:var(--r-sm)}
.agent-config-count{color:var(--warn);font-size:var(--fs-2xs);font-weight:600}
.agent-config-section.agent-config-more[open]{padding-bottom:16px}
.agent-config-more[open]>.agent-field-grid{margin-top:2px}
.agent-profile-more .agent-profile-section{border:0;background:transparent;padding:0}
@container access (max-width:520px){
  .access-derived-row{grid-template-columns:minmax(0,1fr)}
  .access-detail-head{padding:10px 14px 12px}
  .agent-inspector-canvas{padding:4px 14px 16px}
  .agent-config-more>summary{flex-wrap:wrap;row-gap:2px;padding:9px 0}
  .agent-config-more>summary .agent-config-hint{order:3;flex:1 1 100%;white-space:normal}
}

.agent-inspector{min-width:0;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);overflow:clip}
/* Opening a detail on a narrow screen scrolls it below the sticky top bar. */
.agent-inspector,.access-detail{scroll-margin-top:calc(var(--header-h) + 12px)}
.agent-inspector-content{min-width:0}
.agent-inspector-form{display:grid;gap:0;padding:0;min-width:0}
.agent-inspector-canvas{display:grid;gap:0;padding:6px 18px 18px;min-width:0}
.agent-inspector-canvas>.access-derived:not(:empty){margin:10px 0 4px}
.agent-notice{color:var(--ink-3)!important;font-size:var(--fs-xs)!important;line-height:1.5!important;margin:0 0 2px}
.agent-config-section{display:grid;gap:12px;min-width:0;padding:16px 0;border-top:1px solid var(--line)}
.agent-inspector-canvas>.agent-config-section:first-child,.agent-inspector-canvas>.access-derived:empty+.agent-config-section{border-top:0}
.agent-config-section>h3,.agent-section-heading h3,.agent-config-more>summary h3{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:650;letter-spacing:.04em;margin:0}
.agent-section-heading{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:8px 10px;min-width:0}
.agent-section-heading>div:first-child{flex:1 1 240px;min-width:0}
.agent-section-heading p{margin:2px 0 0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45}
.agent-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px;min-width:0}
.agent-field-grid-primary{grid-template-columns:repeat(2,minmax(0,1fr))}
.settings-field{padding:0 0 12px;border-bottom:1px solid var(--line);display:grid;gap:6px;min-width:0}
.agent-field-grid .settings-field:last-child,.agent-field-grid .settings-field:nth-last-child(-n+2){border-bottom:0;padding-bottom:0}
/* In the detail, a field is label, control, one muted help line, then saved
   value and reset on a single row. */
/* Label row: name · saved value · reset, then the control. Help is the
   control's description: shown while the field is being edited, otherwise
   available on hover (title) and to assistive tech (aria-describedby). */
.agent-field-grid>.settings-field{display:flex;flex-wrap:wrap;align-items:baseline;align-content:flex-start;gap:6px 10px;padding:0;border:0}
.agent-field-grid>.settings-field>*{min-width:0}
.agent-field-grid>.settings-field>label.field{display:contents}
.agent-field-grid>.settings-field>label.field>span{order:0;flex:0 1 auto;overflow-wrap:anywhere}
.agent-field-grid>.settings-field>small{order:4;flex:1 1 100%}
.agent-field-grid>.settings-field>small.settings-field-meta{order:1;flex:1 1 0;color:var(--ink-4);font-size:var(--fs-2xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-field-grid>.settings-field>.settings-reset{order:2;flex:0 0 auto;margin:0 0 0 auto;color:var(--ink-3);font-size:var(--fs-2xs)}
.agent-field-grid>.settings-field>label.field>:is(input,select,textarea),.agent-field-grid>.settings-field>label.field>.settings-custom,.agent-field-grid>.settings-field>:not(label):not(small):not(.settings-reset):not(.agent-field-help){order:3;flex:1 1 100%}
.agent-field-grid>.settings-field>small:empty,.agent-field-grid>.settings-field>.settings-actions:empty{display:none}
.agent-field-grid>.settings-field>.agent-field-help{order:4;flex:1 1 100%;display:none}
.agent-field-grid>.settings-field:focus-within>.agent-field-help{display:block}
.agent-section-heading p,.agent-native-head p,.agent-native-note{display:none}
/* Core block: short choices are one line each (label · control · reset), two
   per row when the detail is wide enough. Help and the saved-value note stay
   available on focus / hover instead of taking lines. */
.agent-config-core{gap:10px;padding-top:14px}
.agent-field-grid.agent-field-grid-compact{grid-template-columns:repeat(auto-fill,minmax(min(100%,250px),1fr));gap:8px 22px}
.agent-field-grid-compact>.settings-field{display:grid;grid-template-columns:64px minmax(0,1fr);align-items:center;gap:4px 10px}
.agent-field-grid-compact>.settings-field>label.field>span{grid-column:1;color:var(--ink-3);font-size:var(--fs-xs);font-weight:500;line-height:1.3}
.agent-field-grid-compact>.settings-field>label.field>:is(input,select,textarea){grid-column:2;height:34px;min-height:34px;font-size:var(--fs-sm)}
.agent-field-grid-compact>.settings-field>small.settings-field-meta{display:none}
.agent-field-grid-compact>.settings-field>.settings-reset{grid-column:3;grid-row:1;margin:0}
.agent-field-grid-compact>.settings-field>:not(label):not(.settings-reset){grid-column:2/-1}
.agent-field-grid-compact>.settings-field>.settings-actions:not(:empty){justify-content:flex-start}
.agent-capability-inline{display:grid;gap:6px;padding:0;border:0}
.agent-capability-line{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px}
.agent-capability-line>.agent-capability-info{flex:1 1 220px;margin:0}
.agent-capability-line .settings-actions{margin:0;gap:6px}
.agent-capability-line .btn{height:30px;font-size:var(--fs-xs)}
.agent-config-hint{flex:1 1 auto;min-width:0;color:var(--ink-4);font-size:var(--fs-2xs);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent-config-more>summary .agent-config-count{flex:0 0 auto}
.agent-config-more>summary h3{flex:0 0 auto}
.agent-inspector-form[data-dirty=false] .agent-live-ack{display:none}
.settings-field>.field{gap:5px;min-width:0}
.settings-field label.field>span{color:var(--ink-2);font-size:var(--fs-xs);font-weight:550}
.agent-field-help{margin:0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45!important}
.settings-field>small{color:var(--ink-4);font-size:var(--fs-2xs);line-height:1.4}
.agent-native-card{display:grid;gap:11px;padding:16px 0}
.agent-native-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;flex-wrap:wrap}
.agent-native-head>div{min-width:0;flex:1 1 220px}
.agent-native-head .agent-status-pill{white-space:normal}
.agent-native-head h3{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:650;letter-spacing:.04em}
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
.agent-status-pill{display:inline-flex;align-items:center;padding:2px 7px;border:1px solid var(--line);border-radius:var(--r-pill);background:var(--surface);color:var(--ink-3);font-size:var(--fs-2xs);white-space:nowrap;max-width:100%;overflow-wrap:anywhere}
.agent-status-pill.tone-info{border-color:var(--info-soft);color:var(--info)}
.agent-config-section .agent-capability-section{padding:12px 0 0;border-top:0}
.agent-capability-section{gap:9px}
.agent-capability-section .settings-actions{margin:0;flex-wrap:nowrap}
.agent-capability-info{margin:0!important;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important}
.agent-capability-output{display:grid;gap:6px;min-width:0}
.agent-capability-output p{margin:0;color:var(--ink-2);font-size:var(--fs-xs);line-height:1.45}
.agent-technical>summary,.agent-source>summary{cursor:pointer;color:var(--ink-3);font-size:var(--fs-xs)}
.settings-observation{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fs-2xs);padding:10px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--code-bg,var(--surface-2))}
.agent-source{border-top:1px solid var(--line);padding-top:12px;margin-top:4px}
.agent-source-body{display:grid;gap:7px;margin-top:10px;font-size:var(--fs-xs)}
.agent-source-row{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px;align-items:baseline;min-width:0}
.agent-source-row>span:first-child{color:var(--ink-3);font-size:var(--fs-2xs)}
.agent-source-row strong,.agent-source-row code,.agent-source-row time{min-width:0;color:var(--ink-2);font-size:var(--fs-xs);overflow-wrap:anywhere}
.agent-profile-section{display:grid;gap:10px;padding:0;margin:0}
.agent-profile-section h3{font-size:var(--fs-sm);font-weight:650;color:var(--ink)}
.agent-profile-section>p{margin:0;color:var(--ink-2)!important;font-size:var(--fs-xs)!important;line-height:1.5}
.settings-profile-picker{align-items:end;flex-wrap:nowrap}
.settings-profile-preview{display:grid;gap:8px}
.settings-profile-preview h4{font-size:var(--fs-xs);font-weight:600;color:var(--ink)}
.settings-profile-preview>p{margin:0;font-size:var(--fs-xs)}
.settings-profile-diff-scroll{max-height:280px}
.agent-live-ack{padding:12px 0 4px;border-top:1px solid var(--line);color:var(--ink-2);font-size:var(--fs-xs)}
.agent-action-bar{position:sticky;bottom:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;padding:10px 18px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(8px)}
.agent-foot-status{display:grid;gap:2px;min-width:0;flex:1 1 260px}
.agent-dirty-indicator{color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.agent-dirty-indicator[data-dirty=true]{color:var(--warn);font-weight:600}
.agent-dirty-indicator[data-dirty=false]{display:none}
.agent-foot-status>.agent-notice{margin:0;color:var(--ink-3)!important;font-size:var(--fs-2xs)!important;line-height:1.45!important}
.agent-dirty-indicator[data-dirty=true]~.agent-notice{display:none}
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
.settings-profile-diff{border-collapse:collapse;width:100%;font-size:var(--fs-xs);table-layout:fixed}
.settings-profile-diff th,.settings-profile-diff td{padding:10px;vertical-align:top;text-align:left;border-bottom:1px solid var(--line)}
.settings-profile-diff thead th{background:var(--surface);font-weight:600}
.settings-profile-diff th,.settings-profile-diff td{min-width:0;max-width:none}
.settings-profile-diff th:first-child{width:28%}
.settings-profile-diff th:not(:first-child){width:36%}
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
  .agent-field-grid-primary,.agent-field-grid{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:${BREAKPOINTS.small}px){
  .agent-inspector{min-height:0;border-radius:var(--r-md)}
  .agent-inspector-canvas{padding:4px 14px 16px}
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
/* Touch: every list, detail and disclosure control in model management keeps
   a comfortable tap target; desktop density is unchanged. */
@media(pointer:coarse){
  .access-head-actions .btn,.access-detail-bar .btn,.agent-action-buttons .btn,.agent-inspector .btn{min-height:40px}
  .access-detail-bar .access-back{min-width:40px}
  .agent-inspector details>summary{min-height:40px;display:flex;align-items:center}
}
/* Opening and closing a detail on wide layouts: the list glides to its new
   column while the detail slides in from the side (client accessTransition
   adds .vt-access only while the transition runs). */
.vt-access .access-list{view-transition-name:access-list}
.vt-access .access-detail{view-transition-name:access-detail}
::view-transition-group(access-list),::view-transition-group(access-detail){animation-duration:260ms;animation-timing-function:cubic-bezier(.2,0,0,1)}
::view-transition-old(access-list),::view-transition-new(access-list){width:100%;height:100%;object-fit:none;object-position:0 0}
/* The list changes layout (table ⇄ compact rows): never show both at once. */
::view-transition-old(access-list){animation:access-fade-out 90ms cubic-bezier(.4,0,1,1) both}
::view-transition-new(access-list){animation:access-fade-in 180ms cubic-bezier(.2,0,0,1) 90ms both}
::view-transition-new(access-detail):only-child{animation:access-slide-in 260ms cubic-bezier(.2,0,0,1) both}
::view-transition-old(access-detail):only-child{animation:access-slide-out 160ms cubic-bezier(.4,0,1,1) both}
@keyframes access-fade-in{from{opacity:0}}
@keyframes access-fade-out{to{opacity:0}}
@keyframes access-slide-in{from{opacity:0;transform:translate3d(24px,0,0)}}
@keyframes access-slide-out{to{opacity:0;transform:translate3d(16px,0,0)}}
@media(prefers-reduced-motion:reduce){.vt-access .access-list,.vt-access .access-detail{view-transition-name:none}}
`;