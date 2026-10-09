export const SETTINGS_STYLES = `
.settings-body{display:block;overflow:auto;height:auto;min-height:100dvh}
.settings-page{max-width:1040px;margin:auto;padding:32px 24px 80px;display:grid;gap:22px}
.settings-page p{color:var(--ink-2);font-size:var(--fs-sm);line-height:1.6;overflow-wrap:anywhere}
.settings-header{display:flex;gap:20px;align-items:center}
.settings-card{padding:22px;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface);min-width:0}
.settings-card>summary{font-size:var(--fs-md);font-weight:600;cursor:pointer}
.settings-card h2{font-size:var(--fs-md);margin-bottom:16px}
.settings-card[open]>summary{margin-bottom:16px}
.settings-stack{display:grid;gap:16px;min-width:0}
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
.settings-field{padding:14px 0;border-bottom:1px solid var(--line);display:grid;gap:8px;min-width:0}
.settings-field small{color:var(--ink-3);overflow-wrap:anywhere}
.settings-field textarea{width:100%;min-height:88px;resize:vertical}
.settings-field input,.settings-field select{width:100%;min-width:0}
.settings-field .settings-reset{display:flex;gap:8px;align-items:center;font-size:var(--fs-xs)}
.settings-reset input{width:auto}
.settings-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
.settings-receipt{white-space:pre-wrap;overflow-wrap:anywhere}
.settings-error{color:var(--bad)!important}
.settings-observation{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--fs-xs)}
.settings-search{position:sticky;top:0;background:var(--canvas);padding:12px 0;z-index:1}
.settings-page input[type=checkbox]{width:16px;height:16px;padding:0;accent-color:var(--accent)}
@media(max-width:640px){.settings-page{padding:18px 12px 48px}.settings-grid{grid-template-columns:1fr}.settings-card{padding:16px}}
`;
