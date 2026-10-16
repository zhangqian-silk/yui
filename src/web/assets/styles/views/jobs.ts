export const JOBS_STYLES = `
.jobs-manager { min-width: 0; display: grid; gap: 16px; container-type: inline-size; }
.jobs-layout { display: grid; grid-template-columns: minmax(160px, 240px) minmax(0, 1fr); gap: 24px; align-items: start; }
.jobs-list, .jobs-detail, .jobs-runs { display: grid; gap: 12px; min-width: 0; }
.job-choice { display: grid; gap: 6px; text-align: left; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.job-choice[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
.job-choice:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.jobs-manager .settings-actions { flex-wrap: wrap; }
.jobs-manager .settings-observation { max-width: 100%; max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.jobs-manager .btn, .job-fact { overflow-wrap: anywhere; white-space: normal; text-align: left; }
.jobs-runs .btn { font-family: var(--font-mono); font-size: 12px; }
.jobs-manager textarea { width: 100%; font-family: var(--font-mono); }
.jobs-manager [hidden] { display: none !important; }
@media (max-width: 720px) { .jobs-layout { grid-template-columns: minmax(0, 1fr); } }
@container (max-width: 640px) {
  .jobs-layout { grid-template-columns: minmax(0, 1fr); }
  .jobs-list { grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
}
`;
