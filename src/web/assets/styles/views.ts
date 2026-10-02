/*
 * VIEWS — styling for the concrete surfaces: sidebar index, overview, task
 * page (header, tabs, sections, records) and the session dock.
 */
export const VIEW_STYLES = `
/* ---------- Sidebar ---------- */
.brand-mark{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-size:15px;font-weight:700;line-height:1}
.brand-name{font-size:var(--fs-lg);font-weight:650;letter-spacing:-.02em}
.sync{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:var(--r-pill);background:var(--surface-3);color:var(--ink-3);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.sync i{width:6px;height:6px;border-radius:50%;background:var(--ink-4)}
.sync[data-state="ok"] i{background:var(--ok);box-shadow:0 0 0 3px var(--ok-soft)}
.sync[data-state="syncing"] i{background:var(--info);animation:blink 1s ease-in-out infinite}
.sync[data-state="error"] i{background:var(--bad);box-shadow:0 0 0 3px var(--bad-soft)}
.sync[data-state="error"]{color:var(--bad)}
@keyframes blink{50%{opacity:.35}}
.search-field{position:relative;display:flex;align-items:center}
.search-field>.icon{position:absolute;left:10px;color:var(--ink-4);pointer-events:none}
.search-field input{height:34px;padding:0 34px 0 32px;border-radius:var(--r-md);background:var(--surface-2)}
.search-field input::-webkit-search-cancel-button{display:none}
.search-field kbd{position:absolute;right:8px}
.attention-list{display:flex;flex-wrap:wrap;gap:6px}
.attention-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border:1px solid transparent;border-radius:var(--r-pill);background:var(--tone-soft);color:var(--tone);font-size:var(--fs-xs);font-weight:500}
.attention-pill b{font-weight:700;font-variant-numeric:tabular-nums}
.attention-pill:hover{border-color:var(--tone)}
.attention-pill[aria-pressed="true"]{background:var(--tone);color:var(--canvas)}
.attention-clear{display:flex;align-items:center;gap:6px;color:var(--ink-4);font-size:var(--fs-xs)}
.attention-clear .icon{color:var(--ok)}
.tabs-row{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;padding-bottom:2px;border-bottom:1px solid var(--line)}
.tabs-row::-webkit-scrollbar{display:none}
.status-tab{position:relative;display:inline-flex;align-items:center;gap:5px;flex:none;height:32px;padding:0 8px;border:0;background:transparent;color:var(--ink-3);font-size:var(--fs-xs);font-weight:500;white-space:nowrap}
.status-tab:hover{color:var(--ink)}
.status-tab[aria-pressed="true"]{color:var(--ink)}
.status-tab[aria-pressed="true"]::after{content:"";position:absolute;left:6px;right:6px;bottom:-3px;height:2px;border-radius:2px;background:var(--accent)}
.status-tab-count{color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.task-group{margin-top:10px}
.task-group-head{display:flex;align-items:center;gap:6px;padding:4px 8px 6px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.07em}
.task-group-head .count{background:transparent;padding:0;min-width:0}
.task-row{position:relative;display:flex;align-items:flex-start;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:var(--r-md);background:transparent;text-align:left;transition:background var(--t-fast)}
.task-row>.dot{margin-top:6px}
.task-row:hover{background:var(--surface-3)}
.task-row[aria-current="true"]{background:var(--surface-3);box-shadow:inset 0 0 0 1px var(--line-2)}
.task-row[aria-current="true"]::before{content:"";position:absolute;left:-8px;top:10px;bottom:10px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.task-body{display:grid;gap:3px;flex:1;min-width:0}
.task-line{display:flex;align-items:center;gap:8px;min-width:0}
.task-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:var(--fs-md);font-weight:500}
.task-time{flex:none;color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.task-sub{gap:8px;height:18px;color:var(--ink-4);font-size:var(--fs-2xs)}
.task-id{font-size:var(--fs-2xs);line-height:1;color:var(--ink-3)}
.task-meta{display:inline-flex;align-items:center;gap:3px;line-height:1;white-space:nowrap}
.task-meta .icon{width:11px;height:11px}
.task-signals{display:inline-flex;gap:4px;margin-left:auto}
.signal{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;border-radius:var(--r-pill);background:var(--tone-soft);color:var(--tone);font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
.signal .icon{width:11px;height:11px;stroke-width:2}
.list-empty{display:grid;justify-items:center;gap:8px;padding:36px 16px;color:var(--ink-4);font-size:var(--fs-sm);text-align:center}
.list-empty.is-error{color:var(--bad)}
.pager-btn{height:28px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:transparent;color:var(--ink-2);font-size:var(--fs-xs)}
.pager-btn:hover:not(:disabled){border-color:var(--line-3);color:var(--ink)}
.pager-btn:disabled{opacity:.4}
.pager-count{grid-column:2;text-align:center;color:var(--ink-4);font-size:var(--fs-2xs);font-variant-numeric:tabular-nums}
.pager-clear{height:28px;border:1px dashed var(--line-3);border-radius:var(--r-sm);background:transparent;color:var(--ink-3);font-size:var(--fs-xs)}
.pager-clear:hover{color:var(--accent);border-color:var(--accent-line)}
.foot-btn{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 10px;border:1px solid var(--line-2);border-radius:var(--r-sm);background:transparent;color:var(--ink-2);font-size:var(--fs-xs);font-weight:500;min-width:0}
.foot-btn span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot-btn:hover{color:var(--ink);border-color:var(--line-3);background:var(--surface-3)}
.foot-btn[aria-pressed="true"]{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.foot-btn kbd{margin-left:2px}
.side-foot .foot-btn:first-child{flex:1}
.side-foot .icon-btn{margin-left:auto}

/* ---------- Page scaffolding ---------- */
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;padding:36px 0 24px}
.kicker{color:var(--accent);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.1em}
.page-title{margin-top:6px;font-size:var(--fs-2xl);font-weight:650;letter-spacing:-.025em}
.page-sub{margin-top:4px;color:var(--ink-3)}
.page-foot{margin-top:20px;color:var(--ink-4);font-size:var(--fs-xs);text-align:center}
.section{margin-top:28px;min-width:0}
.section-title{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.section-title h2{display:flex;align-items:center;gap:8px;font-size:var(--fs-lg);font-weight:600}
.section-actions{margin-left:auto}
.sub-head{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:var(--fs-sm);font-weight:600}

/* ---------- Overview ---------- */
.metric-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-bottom:14px}
.metric-strip .metric{padding:14px 16px;border-radius:var(--r-lg)}
.metric-strip .metric-value{font-size:var(--fs-2xl)}
.overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:14px;align-items:start}
.overview>.card{margin-bottom:14px}
.row-list{display:grid;gap:2px;margin:-4px -8px}
.list-row{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:7px 8px;border:0;border-radius:var(--r-sm);background:transparent;color:var(--ink);text-align:left;font-size:var(--fs-sm)}
.list-row:hover:not(:disabled){background:var(--surface-3)}
.list-row:disabled{opacity:.45;cursor:default}
.list-row[aria-pressed="true"]{background:var(--accent-soft)}
.list-row-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.list-row-count{font-weight:600;font-variant-numeric:tabular-nums}
.list-row-go{display:inline-flex;align-items:center;gap:2px;color:var(--accent);font-size:var(--fs-xs);font-weight:500}
.list-row-wrap{flex-wrap:wrap}
.list-row-wrap .chip-row{flex-basis:100%}

/* ---------- Task page ---------- */
.task-header{position:sticky;top:0;z-index:10;margin:0 calc(-1 * clamp(16px,3vw,40px));padding:0 clamp(16px,3vw,40px);background:color-mix(in srgb,var(--canvas) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px)}
.task-bar{display:flex;align-items:center;gap:6px;height:var(--header-h)}
.back-btn{display:none}
.crumbs{display:flex;align-items:center;gap:6px;min-width:0;font-size:var(--fs-sm)}
.crumb{padding:3px 6px;border:0;border-radius:var(--r-xs);background:transparent;color:var(--ink-3)}
.crumb:hover{color:var(--ink);background:var(--surface-3)}
.crumb-sep{color:var(--ink-4)}
.crumb-current{color:var(--ink-2);font-size:var(--fs-xs)}
.dock-toggle{height:30px}
.task-hero{padding:14px 0 18px}
.task-title{font-size:var(--fs-2xl);font-weight:650;letter-spacing:-.025em;line-height:1.25;overflow-wrap:anywhere}
.task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;color:var(--ink-3);font-size:var(--fs-xs)}
.task-meta:empty{display:none}
.meta-item{display:inline-flex;align-items:center;gap:5px}
.meta-item .when{font-size:inherit}
.tabs-wrap{position:sticky;top:var(--header-h);z-index:9;margin:0 calc(-1 * clamp(16px,3vw,40px));padding:0 clamp(16px,3vw,40px);background:color-mix(in srgb,var(--canvas) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);-webkit-backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.tabs{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{position:relative;display:inline-flex;align-items:center;gap:7px;flex:none;height:42px;padding:0 10px;border:0;background:transparent;color:var(--ink-3);font-size:var(--fs-sm);font-weight:500}
.tab:hover{color:var(--ink)}
.tab[aria-selected="true"]{color:var(--ink)}
.tab[aria-selected="true"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--accent)}
.tab .icon{color:var(--ink-4)}
.tab[aria-selected="true"] .icon{color:var(--accent)}
.tab:focus-visible{box-shadow:inset var(--focus)}
.tab-panel{padding-top:20px;min-width:0}
.tab-panel>.card{margin-bottom:14px}
.tab-panel>.section:first-child{margin-top:4px}

/* Now card */
.now-card{border-color:var(--line-2);background:linear-gradient(180deg,var(--surface-2),var(--surface))}
.now-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.now-owner{color:var(--ink-2);font-size:var(--fs-sm);font-weight:500}
.now-summary{margin-top:10px;font-size:var(--fs-lg);line-height:1.45;color:var(--ink)}
.now-reason{margin-top:4px;color:var(--ink-3);font-size:var(--fs-sm)}
.now-note{margin-top:8px;color:var(--ink-3);font-size:var(--fs-sm)}
.signal-list{list-style:none;display:grid;gap:6px;margin:12px 0 0;padding:0}
.signal-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;padding:8px 10px;border-radius:var(--r-sm);background:var(--tone-soft);font-size:var(--fs-sm)}
.signal-row>.icon{align-self:center;color:var(--tone)}
.signal-kind{color:var(--tone);font-weight:600}
.next-line{display:flex;flex-wrap:wrap;align-items:center;gap:4px;color:var(--ink-3);font-size:var(--fs-xs)}
.next-line:empty{display:none}
.next-line .icon{color:var(--accent)}
.next-line strong{color:var(--ink)}

/* Needs you / input requests */
.needs-card{border-color:var(--warn);box-shadow:0 0 0 3px var(--warn-soft)}
.needs-card .card-title .icon{color:var(--warn)}
.input-card{display:grid;gap:10px;padding:14px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2)}
.input-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;color:var(--ink-3);font-size:var(--fs-xs)}
.input-kicker{display:inline-flex;align-items:center;gap:5px;color:var(--warn);font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:var(--fs-2xs)}
.input-timeout{display:inline-flex;align-items:center;gap:4px}
.input-head .when{margin-left:auto}
.input-question{font-size:var(--fs-lg);font-weight:500;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.input-facts{color:var(--ink-3);font-size:var(--fs-xs);overflow-wrap:anywhere}
.input-choices{display:flex;flex-wrap:wrap;gap:8px}
.choice{display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:6px 14px;border:1px solid var(--line-3);border-radius:var(--r-md);background:var(--surface);color:var(--ink);font-weight:500;text-align:left}
.choice:hover:not(:disabled){border-color:var(--accent);background:var(--accent-soft)}
.choice.is-recommended{border-color:var(--accent-line)}
.choice:disabled{opacity:.5}
.input-form{display:flex;gap:8px}
.input-form input{flex:1}

/* Decisions, sessions, planning */
.decision{display:grid;gap:4px;padding-top:10px;border-top:1px solid var(--line)}
.decision:first-child{padding-top:0;border-top:0}
.decision-head{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm)}
.decision-head strong{flex:1;min-width:0;font-weight:600}
.session-list{list-style:none;display:grid;gap:8px;margin:0;padding:0}
.session-row{display:grid;gap:3px;padding:9px 11px;border-radius:var(--r-sm);background:var(--surface-2);border:1px solid var(--line)}
.session-row-head{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm)}
.session-row p{color:var(--ink-2)}
.planning-card .kv{font-size:var(--fs-xs)}

/* Work items */
.work-card{border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-1);min-width:0}
.work-head{display:flex;align-items:center;gap:10px;padding:13px 16px;list-style:none}
summary.work-head{cursor:pointer}
summary.work-head::-webkit-details-marker{display:none}
.work-title{flex:1;min-width:0;font-weight:600;font-size:var(--fs-md);overflow-wrap:anywhere}
.work-body{display:grid;gap:12px;padding:0 16px 16px 34px}
.work-card.is-settled .work-title{color:var(--ink-2);font-weight:500}
.meta-line{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;color:var(--ink-3);font-size:var(--fs-xs)}
.meta-strong{display:inline-flex;align-items:center;gap:4px;color:var(--ink-2);font-weight:500}
.meta-label{color:var(--ink-4)}
.candidates{margin:0;padding:0;list-style:none;display:grid;gap:4px;font-size:var(--fs-xs)}
.candidates li{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.candidate-seq{font-family:var(--font-mono);color:var(--accent)}

/* Records, runs, roles */
.record,.run-card,.review-card{display:grid;gap:8px;min-width:0;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}
.record.is-compact{padding:9px 12px;background:var(--surface-2)}
.record-head,.run-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-size:var(--fs-sm)}
.record-store{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.record-actions{display:flex;gap:8px}
.run-card[data-status="failed"]{border-color:color-mix(in srgb,var(--bad) 35%,var(--line))}
.run-role{font-weight:600}
.role-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.role-card{display:grid;gap:10px;align-content:start;min-width:0;padding:14px;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-1)}
.role-head{display:flex;align-items:center;gap:10px}
.role-title{display:grid;flex:1;min-width:0;line-height:1.3}
.role-title .faint{font-size:var(--fs-xs)}
.avatar{display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:9px;background:var(--surface-3);color:var(--ink-2);font-weight:650;font-size:var(--fs-sm)}
.role-card .kv{font-size:var(--fs-xs)}
.role-actions{display:flex;justify-content:flex-end;margin:-4px -6px -6px}

/* History timeline */
.timeline{list-style:none;margin:0;padding:0;position:relative;display:grid;gap:0}
.timeline::before{content:"";position:absolute;left:13px;top:6px;bottom:6px;width:1px;background:var(--line-2)}
.timeline-item{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;padding:0 0 18px}
.timeline-mark{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line-2);color:var(--ink-3)}
.kind-decision .timeline-mark{color:var(--ok);border-color:var(--ok-soft);background:var(--ok-soft)}
.kind-milestone .timeline-mark{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
.timeline-body{display:grid;gap:6px;min-width:0;padding-top:3px}
.timeline-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:var(--fs-sm)}
.timeline-empty{list-style:none}
.timeline .show-more{margin-left:40px}

/* Evidence */
.file-list{display:grid;gap:2px}
.file-list:empty{display:none}
.file-row{display:flex;align-items:center;gap:8px;min-height:32px;padding:5px 8px;border:0;border-radius:var(--r-sm);background:transparent;text-align:left;font-size:var(--fs-sm);color:var(--ink-2)}
.file-row:hover{background:var(--surface-3);color:var(--ink)}
.file-row[aria-current="true"]{background:var(--accent-soft);color:var(--ink)}
.file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:var(--fs-xs)}
.file-viewer{display:grid;gap:8px}
.file-viewer:empty{display:none}
.viewer-head{display:flex;align-items:center;gap:8px;font-size:var(--fs-sm)}
.viewer-ref code{white-space:normal;overflow-wrap:anywhere}
.artifact-text{max-height:480px;color:var(--ink)}

/* ---------- Dock ---------- */
.dock-sub{flex:none;display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;padding:12px 16px 10px;border-bottom:1px solid var(--line)}
.dock-sub-title{font-weight:600;font-size:var(--fs-sm)}
.dock-sub-note{color:var(--ink-4);font-size:var(--fs-2xs)}
.feed{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:14px;padding:16px;scrollbar-gutter:stable}
.feed:focus-visible{box-shadow:inset var(--focus)}
.feed>.empty{margin:auto 0}
.feed-note{color:var(--ink-4);font-size:var(--fs-2xs);text-align:center}
.feed-day{display:flex;align-items:center;gap:10px;color:var(--ink-4);font-size:var(--fs-2xs);font-weight:500}
.feed-day::before,.feed-day::after{content:"";flex:1;height:1px;background:var(--line)}
.msg{display:flex;gap:10px;max-width:100%;min-width:0}
.msg-avatar{display:grid;place-items:center;width:28px;height:28px;flex:none;border-radius:8px;background:var(--surface-3);color:var(--ink-2);font-size:var(--fs-xs);font-weight:650}
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

/* Live session (always dark: it renders a native terminal) */
.dock-session{color:#e6e6e8}
.target-chip{display:inline-flex;align-items:center;gap:6px;flex:none;height:26px;padding:0 10px;border:1px solid rgba(255,255,255,.12);border-radius:var(--r-pill);background:transparent;color:rgba(255,255,255,.72);font-size:var(--fs-xs);font-weight:500}
.target-chip:hover{color:#fff;border-color:rgba(255,255,255,.3)}
.target-chip[aria-pressed="true"]{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.3);color:#fff}
.target-chip .dot{width:7px;height:7px;box-shadow:none}
.dock-session .faint{color:rgba(255,255,255,.4)}
.conn{display:inline-flex;align-items:center;gap:6px;flex:none;color:rgba(255,255,255,.6);font-size:var(--fs-xs);font-weight:500}
.conn i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.3)}
.conn[data-state="connecting"] i{background:var(--warn);animation:blink 1s infinite}
.conn[data-state="writable"] i{background:#4fd18b;box-shadow:0 0 0 3px rgba(79,209,139,.2)}
.conn[data-state="readonly"] i{background:#6cb6ff}
.conn[data-state="error"] i{background:#ff6b7a}
.conn[data-state="error"]{color:#ff9aa5}
.terminal-empty{color:rgba(255,255,255,.55)}
.terminal-empty .icon{color:rgba(255,255,255,.35)}
.terminal-empty-title{color:#fff;font-weight:600}
.terminal-empty-text{max-width:300px;font-size:var(--fs-xs);line-height:1.5}
.session-foot{color:rgba(255,255,255,.45);font-size:var(--fs-2xs)}
.session-foot code{color:rgba(255,255,255,.8);user-select:all}
.terminal-host .xterm{height:100%}
.terminal-host .xterm-viewport{background:transparent!important}
`;
