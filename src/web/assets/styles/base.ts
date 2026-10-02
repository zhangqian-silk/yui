/*
 * BASE — element defaults, form controls, focus, scrollbars and utilities.
 */
export const BASE_STYLES = `
*,*::before,*::after{box-sizing:border-box}
html{background:var(--canvas);color:var(--ink);font-family:var(--font-sans);font-size:var(--fs-md);line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
body{margin:0;min-width:320px;height:100vh;height:100dvh;overflow:hidden;background:var(--canvas);color:var(--ink);font-feature-settings:"cv11","ss01"}
h1,h2,h3,h4,h5,h6,p{margin:0}
h1,h2,h3,h4{font-weight:600;letter-spacing:-.011em;line-height:1.3}
a{color:var(--accent)}
code,kbd,pre,.mono{font-family:var(--font-mono);font-size:.92em}
kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border:1px solid var(--line-2);border-bottom-width:2px;border-radius:var(--r-xs);background:var(--surface-2);color:var(--ink-3);font-family:var(--font-sans);font-size:10px;font-weight:600;line-height:1}
button{font:inherit;color:inherit;cursor:pointer}
button:disabled{cursor:not-allowed}
input,select,textarea{font:inherit;color:var(--ink)}
input,select,textarea{width:100%;min-width:0;padding:8px 10px;background:var(--sunken);border:1px solid var(--line-2);border-radius:var(--r-sm);transition:border-color var(--t-fast),box-shadow var(--t-fast),background var(--t-fast)}
textarea{resize:vertical;line-height:1.5}
select{appearance:none;padding-right:30px;background-image:linear-gradient(45deg,transparent 50%,var(--ink-3) 50%),linear-gradient(135deg,var(--ink-3) 50%,transparent 50%);background-position:calc(100% - 15px) 50%,calc(100% - 11px) 50%;background-size:4px 4px;background-repeat:no-repeat}
input::placeholder,textarea::placeholder{color:var(--ink-4)}
input:hover,select:hover,textarea:hover{border-color:var(--line-3)}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent-line);box-shadow:0 0 0 3px var(--accent-soft);background:var(--surface-2)}
input:disabled,select:disabled,textarea:disabled{opacity:.55}
:focus-visible{outline:none;box-shadow:var(--focus)}
::selection{background:var(--accent-soft);color:var(--ink)}
*{scrollbar-width:thin;scrollbar-color:var(--line-3) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line-3);border-radius:var(--r-pill);border:3px solid transparent;background-clip:content-box}
::-webkit-scrollbar-track{background:transparent}
[hidden]{display:none!important}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip-link{position:fixed;left:12px;top:-60px;z-index:100;padding:9px 14px;border-radius:var(--r-sm);background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;transition:top var(--t-fast)}
.skip-link:focus{top:12px}
.icon{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.icon-sm{width:14px;height:14px}
.icon-xl{width:30px;height:30px;stroke-width:1.4}
.muted{color:var(--ink-3)}
.faint{color:var(--ink-4)}
.nowrap{white-space:nowrap}
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`;
