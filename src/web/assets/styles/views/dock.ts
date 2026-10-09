/*
 * DOCK VIEW — the Discussion pane: its sub-header, the message feed with day
 * separators and bubbles, the composer, submission facets and next steps.
 * The Live session pane is views/terminal; the dock frame is layout/workspace.
 */
export const DOCK_STYLES = `
/* Feed */
.dock-sub{flex:none;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;padding:12px 16px 10px;border-bottom:1px solid var(--line)}
.dock-sub-title{font-weight:600;font-size:var(--fs-sm)}
.dock-sub-note{color:var(--ink-4);font-size:var(--fs-2xs)}
.feed{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:16px;scrollbar-gutter:stable}
.feed:focus-visible{box-shadow:inset var(--focus)}
.feed>.empty{margin:auto 0}
.feed-note{color:var(--ink-4);font-size:var(--fs-2xs);text-align:center}
.feed-older{align-self:center}
#dock-conversation .dock-sub select{min-width:0;max-width:100%;flex:1 1 180px}
#dock-conversation .feed-note{overflow-wrap:anywhere;margin:4px 12px}
#dock-conversation .composer-bar{flex-wrap:wrap}
#dock-conversation .composer-input{width:100%;box-sizing:border-box}
#dock-conversation .feed details{min-width:0;overflow-wrap:anywhere}
.conversation-requests{flex:0 1 auto;max-height:35%;overflow-y:auto;overflow-wrap:anywhere}
.conversation-requests h3{font-size:var(--fs-sm);margin:8px 12px}
.conversation-requests label{display:grid;gap:4px;margin:8px 0}
.conversation-requests input{min-width:0;width:100%;box-sizing:border-box}
.conversation-requests .input-card{margin:8px 12px}
.feed-day{display:flex;align-items:center;gap:10px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:500}
.feed-day::before,.feed-day::after{content:"";flex:1;height:1px;background:var(--line)}

/* Messages: Agent and system on the left, the user mirrored on the right */
.msg{display:flex;gap:10px;max-width:100%;min-width:0}
.msg-avatar{width:28px;height:28px;border-radius:8px;background:var(--surface-3);color:var(--ink-2);font-size:var(--fs-xs);font-weight:650}
.msg-main{display:grid;gap:5px;min-width:0;flex:1}
.msg-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:var(--fs-xs)}
.msg-head strong{font-weight:600}
.msg-head time{margin-left:auto;color:var(--ink-4);font-size:var(--fs-2xs)}
.msg-bubble{padding:10px 12px;border-radius:4px var(--r-lg) var(--r-lg) var(--r-lg);background:var(--surface-2);border:1px solid var(--line);min-width:0;overflow-wrap:anywhere}
.msg.from-user{flex-direction:row-reverse}
.msg.from-user .msg-head{flex-direction:row-reverse}
.msg.from-user .msg-head time{margin-left:0;margin-right:auto}
.msg.from-user .msg-avatar{background:var(--accent);color:var(--accent-ink)}
.msg.from-user .msg-bubble{border-radius:var(--r-lg) 4px var(--r-lg) var(--r-lg);background:var(--accent-soft);border-color:var(--accent-line)}
.msg.from-system .msg-bubble{background:transparent;border-style:dashed}

/* Composer, submission facets and next steps */
.composer-wrap{flex:none;padding:10px 12px 12px;border-top:1px solid var(--line);background:var(--surface)}
.composer{display:grid;gap:6px}
.composer-box{border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--sunken);transition:border-color var(--t-fast),box-shadow var(--t-fast)}
.composer-box:focus-within{border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-soft)}
.composer-input{display:block;min-height:64px;max-height:240px;padding:10px 12px 4px;border:0;background:transparent;resize:none}
.composer-input:focus,.composer-input:hover{border:0;box-shadow:none;background:transparent}
.composer-bar{display:flex;align-items:center;gap:8px;padding:6px 6px 6px 8px}
.composer-send{height:30px}
.facets:empty{display:none}
.facets{display:grid;gap:6px;padding:8px 10px;border-radius:var(--r-sm);background:var(--surface-2)}
.next-step{display:flex;gap:6px;align-items:flex-start;font-size:var(--fs-xs);color:var(--ink-2)}
.next-step .icon{margin-top:2px;color:var(--accent)}
`;
