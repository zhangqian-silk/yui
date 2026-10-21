/*
 * LOGIN VIEW — the standalone sign-in document: one card centred on the
 * canvas at every size, headed by the brand and the language control, with a
 * password field (with reveal toggle), inline error/notice states and the
 * plain-HTTP reminder. Colour comes only from theme tokens; on phones the
 * card drops its frame and uses the full width.
 */
export const LOGIN_STYLES = `
.login-body{height:auto;min-height:100vh;min-height:100dvh;overflow:auto}
.login-shell{display:grid;place-items:center;min-height:100vh;min-height:100dvh;padding:max(24px,env(safe-area-inset-top,0px)) 16px max(24px,env(safe-area-inset-bottom,0px));background:radial-gradient(120% 70% at 50% -10%,var(--accent-soft),transparent 60%),var(--canvas)}
.login-top{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.login-locale{flex:none}
.login-locale select{height:30px;width:auto;max-width:132px;padding:0 26px 0 9px;line-height:28px;font-size:var(--fs-xs)}
.login-card{display:grid;gap:20px;width:min(400px,100%);margin-bottom:6vh;padding:28px;border:1px solid var(--line-2);border-radius:var(--r-lg);background:var(--surface);box-shadow:var(--shadow-2)}
.login-brand{display:flex;align-items:center;gap:10px}
.login-brand .brand-mark{display:block;width:32px;height:32px;flex:none;border-radius:8px;background:var(--ink);color:var(--canvas);overflow:hidden}
.brand-glyph{display:block;width:100%;height:100%}
.brand-dot{fill:var(--accent)}
.login-brand .brand-name{font-size:var(--fs-lg);font-weight:650;letter-spacing:-.02em}
.login-heading{display:grid;gap:6px}
.login-heading h1{font-size:var(--fs-2xl)}
.login-sub{color:var(--ink-3);font-size:var(--fs-sm);overflow-wrap:anywhere}
.login-notice{margin:0;padding:10px 12px;border:1px solid var(--line-2);border-left:3px solid var(--tone,var(--info));border-radius:var(--r-sm);background:var(--tone-soft,var(--info-soft));color:var(--ink);font-size:var(--fs-sm)}
.login-form{display:grid;gap:16px}
.login-field{display:grid;gap:6px;min-width:0}
.login-label{color:var(--ink-2);font-size:var(--fs-xs);font-weight:500}
.login-password{position:relative}
.login-password input{height:40px;padding-right:44px}
.login-password input[aria-invalid="true"]{border-color:var(--bad)}
.login-password input[aria-invalid="true"]:focus{box-shadow:0 0 0 3px var(--bad-soft)}
.login-reveal{position:absolute;top:4px;right:4px}
.login-reveal .icon-hide,.login-reveal[aria-pressed="true"] .icon-show{display:none}
.login-reveal[aria-pressed="true"] .icon-hide{display:block}
.login-error{margin:0;color:var(--bad);font-size:var(--fs-sm);overflow-wrap:anywhere}
.login-submit{width:100%;height:40px;font-size:var(--fs-md)}
.login-spinner{display:none;width:14px;height:14px;flex:none;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:m-spin .8s linear infinite}
.login-form[aria-busy="true"] .login-spinner{display:inline-block}
.login-transport{display:flex;align-items:flex-start;gap:8px;margin:0;padding-top:16px;border-top:1px solid var(--line);color:var(--ink-3);font-size:var(--fs-xs)}
.login-transport .icon{width:14px;height:14px;margin-top:2px;color:var(--warn)}
@media(max-width:480px){
  .login-shell{padding-left:0;padding-right:0;background:var(--surface)}
  .login-card{width:100%;margin-bottom:0;padding:24px 20px;border:0;border-radius:0;box-shadow:none}
  .login-heading h1{font-size:var(--fs-xl)}
}
`;
