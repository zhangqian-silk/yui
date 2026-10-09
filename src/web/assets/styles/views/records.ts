/*
 * RECORDS VIEW — rows rendered inside list cards across the task tabs: work
 * items, records, runs, reviews, role cards and the history timeline.
 */
export const RECORD_STYLES = `
/* Work items (rows of the Work list card) */
.work-card{min-width:0}
.work-head{display:flex;align-items:center;gap:10px;padding:13px 16px;list-style:none}
summary.work-head{cursor:pointer}
summary.work-head::-webkit-details-marker{display:none}
summary.work-head:hover .work-title{color:var(--ink)}
summary.work-head:focus-visible{box-shadow:inset 0 0 0 2px var(--accent-line)}
.work-title{flex:1;min-width:0;font-weight:600;font-size:var(--fs-md);overflow-wrap:anywhere}
.work-body{display:grid;gap:12px;padding:0 16px 16px 34px}
.work-card.is-settled .work-title{color:var(--ink-2);font-weight:500}
.meta-line{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;color:var(--ink-3);font-size:var(--fs-xs)}
.meta-strong{display:inline-flex;align-items:center;gap:4px;color:var(--ink-2);font-weight:500}
.meta-label{color:var(--ink-4)}
.candidates{margin:0;padding:0;list-style:none;display:grid;gap:4px;font-size:var(--fs-xs)}
.candidates li{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}
.candidate-seq{font-family:var(--font-mono);color:var(--accent)}

/* Records, runs, reviews */
.record,.run-card,.review-card{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;min-width:0;overflow-wrap:anywhere;padding:12px 14px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}
.record.is-compact{padding:9px 12px;background:var(--surface-2)}
.record-head,.run-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0;font-size:var(--fs-sm)}
.record-store{color:var(--ink-3);font-size:var(--fs-2xs);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.record-actions{display:flex;gap:8px}
.record-lead{font-weight:500;overflow-wrap:anywhere}
.run-role{font-weight:600}

/* Role cards: avatar head and actions on one line, details indented below */
.role-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;align-content:start;min-width:0;padding:14px 16px}
.role-card>*{grid-column:1/-1;min-width:0}
.role-card>.role-head{grid-column:1;grid-row:1}
.role-card>.role-actions{grid-column:2;grid-row:1;align-self:center}
.role-card>:not(.role-head):not(.role-actions){margin-left:42px}
.role-head{display:flex;align-items:center;gap:10px}
.role-title{display:grid;flex:1;min-width:0;line-height:1.3}
.role-title .faint{font-size:var(--fs-xs)}
.avatar{width:32px;height:32px;border-radius:9px;background:var(--surface-3);color:var(--ink-2);font-weight:650;font-size:var(--fs-sm)}
.role-card .kv{font-size:var(--fs-xs)}
.role-actions{display:flex;justify-content:flex-end;margin-right:-8px}
.role-session{display:grid;gap:3px;min-width:0;font-size:var(--fs-sm)}
.role-session-head{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px}
.role-session>p{color:var(--ink-2)}
.card-actions>[data-slot="session-counts"]:empty{display:none}

/* History timeline */
.timeline{list-style:none;margin:0;padding:0;position:relative;display:grid;gap:0}
.timeline::before{content:"";position:absolute;left:13px;top:6px;bottom:6px;width:1px;background:var(--line-2)}
.timeline-item{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;padding:0 0 18px}
.timeline-mark{position:relative;z-index:1;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--surface-2);border:1px solid var(--line-2);color:var(--ink-3)}
.kind-decision .timeline-mark{color:var(--ok);border-color:var(--ok-soft);background:var(--ok-soft)}
.kind-milestone .timeline-mark{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
.kind-run .timeline-mark{color:var(--info);border-color:var(--info-soft);background:var(--info-soft)}
.kind-question .timeline-mark{color:var(--warn);border-color:var(--warn-soft);background:var(--warn-soft)}
.timeline-body{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;min-width:0;padding-top:3px;overflow-wrap:anywhere}
.timeline-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:var(--fs-sm)}
.timeline-item>.record{align-self:start;padding:4px 0 0;border:0;background:transparent}
.timeline .lazy-head{align-items:flex-start;padding:2px 0 0;gap:8px}
.timeline .lazy-head .disclosure-chevron{order:2;margin-top:4px}
.timeline .lazy-body{padding:10px 0 2px}
.timeline-summary{flex:1;display:grid;gap:4px;min-width:0}
.timeline-title,.timeline-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
.timeline-preview{margin:0}
.lazy-row[open] .timeline-preview{display:none}
.timeline-empty{list-style:none}
.timeline .show-more{margin-left:40px}
`;
