/*
 * UI FORMS — form fields and rows, modal dialogs (settings with its theme
 * swatches and shortcut list, global input) and the transient toast.
 */
export const FORM_STYLES = `
/* Forms */
.field{display:grid;gap:6px;min-width:0;margin:0;padding:0;border:0;font-size:var(--fs-sm)}
.field>span,.field>legend{color:var(--ink-2);font-size:var(--fs-xs);font-weight:500;padding:0}
.field-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.form-actions{display:flex;gap:8px;justify-content:flex-end}
.inline-form{display:grid;gap:8px}
.inline-row{display:flex;gap:8px}
.inline-row input{flex:1}

/* Dialogs */
.dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);padding:0;overflow:auto;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface);color:var(--ink);box-shadow:var(--shadow-2)}
.dialog::backdrop{background:rgba(0,0,0,.45);backdrop-filter:blur(2px)}
.dialog-body{display:grid;gap:16px;padding:20px}
.dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.dialog-head h2{font-size:var(--fs-lg)}
.dialog-sub{margin-top:4px;color:var(--ink-3);font-size:var(--fs-xs)}
.dialog-actions{display:flex;gap:8px;justify-content:flex-end}
.settings-dialog{width:min(460px,calc(100vw - 32px))}
.theme-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.theme-option{display:grid;gap:8px;padding:8px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2);text-align:left;font-size:var(--fs-sm);font-weight:500}
.theme-option:hover{border-color:var(--line-3)}
.theme-option[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.theme-swatch{display:flex;height:34px;overflow:hidden;border-radius:var(--r-sm);border:1px solid var(--line)}
.theme-swatch i{flex:2}
.theme-swatch i[data-part="2"]{flex:1}
.shortcut-list{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0;font-size:var(--fs-sm);color:var(--ink-2)}
.shortcut-list dt{display:flex;gap:3px;align-items:center}
.shortcut-list dd{margin:0}

/* Toast */
.toast{position:fixed;left:50%;bottom:24px;z-index:90;max-width:min(520px,calc(100vw - 32px));padding:10px 16px;border:1px solid var(--line-2);border-radius:var(--r-md);background:var(--surface-2);color:var(--ink);box-shadow:var(--shadow-2);font-size:var(--fs-sm);opacity:0;transform:translate(-50%,8px);pointer-events:none;transition:opacity var(--t-med),transform var(--t-med) var(--ease)}
.toast.show{opacity:1;transform:translate(-50%,0)}
`;
