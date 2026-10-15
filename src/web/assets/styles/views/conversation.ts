/*
 * CONVERSATION VIEW — the right-dock Conversation pane: a slim header, a
 * borderless feed (bubble for the user, plain prose for the assistant, one-line
 * activity rows) and a rounded composer with popovers. Colours come from
 * theme tokens only; the Discussion pane keeps its own sheet (views/dock).
 */
export const CONVERSATION_STYLES = `
#dock-conversation{min-width:0}
.cv-head{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px 4px 8px}
.cv-picker{flex:1;min-width:0;display:flex;align-items:center;gap:6px}
/* background-color only: the shorthand would drop the global select arrow */
.cv-session{flex:1;min-width:0;max-width:100%;height:30px;padding:0 28px 0 8px;border:0;background-color:transparent;color:var(--ink);font-weight:600;font-size:var(--fs-md);text-overflow:ellipsis;cursor:pointer;border-radius:var(--r-sm)}
.cv-session:hover,.cv-session:focus{background-color:var(--surface-3);border:0;box-shadow:none}
/* The global select:focus rule resets the whole background, so the arrow is restated for every state */
.cv-session,.cv-session:hover,.cv-session:focus{background-image:linear-gradient(45deg,transparent 50%,var(--ink-3) 50%),linear-gradient(135deg,var(--ink-3) 50%,transparent 50%);background-position:calc(100% - 15px) 50%,calc(100% - 11px) 50%;background-size:4px 4px;background-repeat:no-repeat}
.cv-status{flex:none;display:flex;align-items:center;gap:6px;margin:0;padding:0 16px 6px;color:var(--ink-3);font-size:var(--fs-xs)}
.cv-status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--idle);flex:none}
.cv-status.is-active::before{background:var(--ok)}
.cv-status.is-waiting::before{background:var(--warn)}
.cv-status.is-failed::before,.cv-status.is-unknown::before{background:var(--bad)}
.cv-status:empty{display:none}
.cv-older{flex:none;display:flex;justify-content:center}
.cv-older:empty{display:none}
.cv-stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.cv-stage .feed{gap:18px;padding:12px 16px 20px}
.cv-jump{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);width:32px;height:32px;display:grid;place-items:center;padding:0;border:1px solid var(--line-2);border-radius:50%;background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-1);cursor:pointer}
.cv-jump:hover{background:var(--surface-3)}
.cv-jump[hidden]{display:none}
.cv-note{margin:0;color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.cv-link{padding:2px 4px;border:0;background:none;color:var(--ink-3);font-size:var(--fs-xs);cursor:pointer;border-radius:var(--r-xs)}
.cv-link:hover{color:var(--ink);background:var(--surface-3)}
.cv-link[hidden],.cv-stop[hidden],.cv-chip[hidden]{display:none}
.cv-code{margin:6px 0 0;padding:8px 10px;max-height:200px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:var(--r-sm);background:var(--sunken);font:var(--fs-xs)/1.5 var(--font-mono)}
.cv-identity{margin:0;color:var(--ink-4);font-size:var(--fs-2xs);overflow-wrap:anywhere}
/* Messages */
.cv-msg{min-width:0;overflow-wrap:anywhere}
.cv-user{align-self:flex-end;max-width:88%;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
.cv-bubble{padding:9px 14px;border-radius:18px;background:var(--info-soft);color:var(--ink);font-size:var(--fs-md);line-height:1.5}
.cv-tag{color:var(--ink-4);font-size:var(--fs-2xs)}
.cv-assistant{position:relative;font-size:var(--fs-md);line-height:1.6}
/* Copy: always visible under the newest message, a hover badge on older ones */
.cv-actions{display:flex;gap:2px;position:absolute;top:-6px;right:0;opacity:0;transition:opacity var(--t-fast)}
.cv-assistant:hover .cv-actions,.cv-assistant:focus-within .cv-actions{opacity:1}
.cv-assistant:last-child .cv-actions{position:static;margin-top:4px;opacity:1}
.cv-actions .cv-iconbtn{background:var(--surface-2)}
.cv-assistant:last-child .cv-actions .cv-iconbtn{background:transparent}
/* Activity: a single muted line that expands to its detail */
.cv-activity{color:var(--ink-3);font-size:var(--fs-sm);min-width:0}
.cv-activity>summary{display:flex;align-items:center;gap:8px;min-width:0;padding:2px 0;list-style:none;cursor:pointer;border-radius:var(--r-xs)}
.cv-activity>summary::-webkit-details-marker{display:none}
.cv-activity>summary:hover{color:var(--ink)}
.cv-activity .icon{width:15px;height:15px;flex:none}
.cv-act-label{flex:none}
.cv-act-detail{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-4)}
.cv-activity[open]>summary .cv-act-detail{white-space:normal}
.cv-group>summary .cv-act-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-chevron{width:13px;height:13px;flex:none;transition:transform var(--t-fast)}
.cv-group[open]>summary .cv-chevron{transform:rotate(180deg)}
.cv-group-body{display:grid;gap:4px;padding:6px 0 2px 23px}
.cv-step{color:var(--ink-2);font-size:var(--fs-sm);line-height:1.55;min-width:0;overflow-wrap:anywhere}
/* Composer */
.cv-composer{flex:none;display:grid;gap:6px;padding:8px 12px 12px;min-width:0}
.cv-box{display:grid;gap:4px;padding:10px 10px 8px 14px;border:1px solid var(--line-2);border-radius:20px;background:var(--surface-2);box-shadow:var(--shadow-1);transition:border-color var(--t-fast),box-shadow var(--t-fast);min-width:0}
.cv-box:focus-within{border-color:var(--line-3)}
.cv-input{display:block;width:100%;box-sizing:border-box;min-height:44px;max-height:240px;padding:0;border:0;background:transparent;box-shadow:none;resize:none;color:var(--ink);font-size:var(--fs-md);line-height:1.5}
.cv-input:hover,.cv-input:focus{border:0;box-shadow:none;background:transparent;outline:none}
.cv-tools{display:flex;align-items:center;gap:6px;min-width:0}
.cv-iconbtn{width:30px;height:30px;display:inline-grid;place-items:center;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ink-2);cursor:pointer;list-style:none;flex:none}
.cv-iconbtn::-webkit-details-marker{display:none}
.cv-iconbtn:hover{background:var(--surface-3);color:var(--ink)}
.cv-iconbtn .icon{width:17px;height:17px}
.cv-send,.cv-stop{width:32px;height:32px;display:inline-grid;place-items:center;padding:0;border:0;border-radius:50%;background:var(--ink);color:var(--canvas);cursor:pointer;flex:none}
.cv-send .icon,.cv-stop .icon{width:16px;height:16px}
.cv-send:hover,.cv-stop:hover{opacity:.85}
/* An empty draft reads as inactive, like the reference composers */
.cv-box:has(.cv-input:placeholder-shown) .cv-send{background:var(--surface-3);color:var(--ink-4)}
.cv-send:disabled{background:var(--surface-3);color:var(--ink-4);cursor:default;opacity:1}
.cv-chip{display:inline-flex;align-items:center;gap:5px;min-width:0;padding:3px 8px;border-radius:var(--r-pill);background:var(--tone-soft,var(--warn-soft));color:var(--tone,var(--warn));font-size:var(--fs-xs)}
.cv-chip .icon{width:13px;height:13px;flex:none}
.cv-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-pill{display:inline-flex;align-items:center;gap:4px;max-width:180px;height:28px;padding:0 8px;border-radius:var(--r-pill);color:var(--ink-3);font-size:var(--fs-sm);list-style:none;cursor:pointer}
.cv-pill::-webkit-details-marker{display:none}
.cv-pill:hover,.cv-pop[open]>.cv-pill{background:var(--surface-3);color:var(--ink)}
.cv-pill .icon{width:13px;height:13px;flex:none}
.cv-model-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-hint{display:flex;flex-wrap:wrap;align-items:center;gap:2px 8px;padding:0 6px;min-width:0}
.cv-hint:empty{display:none}
.cv-hint .cv-note:empty{display:none}
.conversation-slash{padding:0 2px}
.cv-cmd{padding:3px 10px;border:1px solid var(--line-2);border-radius:var(--r-pill);background:var(--surface-2);color:var(--ink-2);font-size:var(--fs-xs);cursor:pointer}
.cv-cmd:hover{background:var(--surface-3);color:var(--ink)}
.cv-file{display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:var(--r-sm);background:var(--surface-3);font-size:var(--fs-xs);min-width:0}
.cv-file .small{flex:1;min-width:0;overflow-wrap:anywhere}
.cv-x{width:22px;height:22px;display:grid;place-items:center;padding:0;border:0;border-radius:50%;background:transparent;color:var(--ink-3);cursor:pointer}
.cv-x:hover{background:var(--line-2);color:var(--ink)}
.cv-x .icon{width:13px;height:13px}
/* Popovers: attach and model open upward, the header menu opens downward */
.cv-pop{position:relative;flex:none}
.cv-pop>summary{list-style:none}
.cv-pop>summary::-webkit-details-marker{display:none}
.cv-popbody{position:absolute;z-index:20;display:grid;gap:8px;width:min(300px,calc(100vw - 32px));max-height:min(420px,60vh);overflow:auto;padding:10px;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface-2);box-shadow:var(--shadow-2);box-sizing:border-box}
.cv-attach>.cv-popbody{left:0;bottom:calc(100% + 8px)}
.cv-model>.cv-popbody{right:0;bottom:calc(100% + 8px)}
.cv-menu>.cv-popbody{right:0;top:calc(100% + 6px)}
.cv-pop-title{margin:0;padding:0 4px;color:var(--ink-3);font-size:var(--fs-xs)}
.cv-pop-actions{display:flex;align-items:center;justify-content:space-between;gap:8px}
.cv-options{display:grid;gap:1px}
.cv-option{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:0;border-radius:var(--r-sm);background:transparent;color:var(--ink);text-align:left;font-size:var(--fs-md);cursor:pointer}
.cv-option:hover{background:var(--surface-3)}
.cv-option-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cv-option-id{display:none}
.cv-option .icon{width:15px;height:15px;flex:none;visibility:hidden}
.cv-option.is-selected .icon{visibility:visible}
.cv-field{display:grid;gap:4px;font-size:var(--fs-xs);color:var(--ink-3)}
.cv-field select{min-width:0;max-width:100%}
.cv-sub>summary{cursor:pointer;color:var(--ink-3);font-size:var(--fs-xs)}
/* Native requests and leader questions */
.cv-requests{flex:0 1 auto;max-height:35%;overflow-y:auto;overflow-wrap:anywhere;padding:0 12px}
.cv-requests:empty{display:none}
.cv-card{display:grid;gap:8px;margin:6px 0;padding:12px;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface-2)}
.cv-card-title{margin:0;font-size:var(--fs-sm);font-weight:600}
.cv-requests>.cv-card-title{margin:8px 4px 0}
.cv-card label{display:grid;gap:4px}
.cv-card input,.cv-card select,.cv-card textarea{min-width:0;max-width:100%;box-sizing:border-box}
/* Keyboard focus */
.cv-iconbtn:focus-visible,.cv-send:focus-visible,.cv-stop:focus-visible,.cv-jump:focus-visible,.cv-pill:focus-visible,.cv-option:focus-visible,.cv-link:focus-visible,.cv-cmd:focus-visible,.cv-x:focus-visible,.cv-activity>summary:focus-visible,.cv-sub>summary:focus-visible{outline:none;box-shadow:var(--focus)}
.cv-session:focus-visible{box-shadow:var(--focus)}
.cv-input:focus-visible{outline:none;box-shadow:none}
@media(max-width:760px){
  .cv-user{max-width:94%}
  .cv-composer{padding-bottom:max(12px,env(safe-area-inset-bottom,0px))}
}
`;
