import { DEFAULT_DARK_THEME } from "../../shared/themes.js";

const SESSION_TONES = DEFAULT_DARK_THEME.tokens;

/*
 * TERMINAL VIEW — the Live session pane. It renders a native terminal, so it
 * stays dark in every theme: its chrome uses a scoped palette (white alphas
 * and the default dark theme's status colours) instead of theme tokens.
 */
export const TERMINAL_STYLES = `
.dock-session{background:var(--term-bg);color:#e6e6e8;--chrome-line:rgba(255,255,255,.07);--chrome-ok:${SESSION_TONES.ok};--chrome-info:${SESSION_TONES.info};--chrome-bad:${SESSION_TONES.bad}}
.dock-session .faint{color:rgba(255,255,255,.4)}

/* Target bar: one chip per attachable Role, then the connection state */
.session-bar{flex:none;display:flex;align-items:center;gap:8px;min-height:44px;padding:6px 10px;border-bottom:1px solid var(--chrome-line)}
.session-targets{display:flex;gap:4px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none}
.target-chip{display:inline-flex;align-items:center;gap:6px;flex:none;height:26px;padding:0 10px;border:1px solid rgba(255,255,255,.12);border-radius:var(--r-pill);background:transparent;color:rgba(255,255,255,.72);font-size:var(--fs-xs);font-weight:500}
.target-chip:hover{color:#fff;border-color:rgba(255,255,255,.3)}
.target-chip[aria-pressed="true"]{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.3);color:#fff}
.target-chip .dot{width:7px;height:7px;box-shadow:none}
.conn{display:inline-flex;align-items:center;gap:6px;flex:none;color:rgba(255,255,255,.6);font-size:var(--fs-xs);font-weight:500}
.conn i{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.3)}
.conn[data-state="connecting"] i{background:var(--warn);animation:blink 1s infinite}
.conn[data-state="writable"] i{background:var(--chrome-ok);box-shadow:0 0 0 3px rgba(79,209,139,.2)}
.conn[data-state="readonly"] i{background:var(--chrome-info)}
.conn[data-state="error"] i{background:var(--chrome-bad)}
.conn[data-state="error"]{color:#ff9aa5}

/* Terminal host, its empty state and the CLI footer */
.terminal-host{flex:1;min-height:0;padding:10px 4px 6px 12px;overflow:hidden}
.terminal-host:empty{display:none}
.terminal-host .xterm{height:100%}
.terminal-host .xterm-viewport{background:transparent!important}
.terminal-empty{flex:1;display:grid;place-content:center;justify-items:center;gap:8px;padding:24px;text-align:center;color:rgba(255,255,255,.55)}
.terminal-empty .icon{color:rgba(255,255,255,.35)}
.terminal-empty-title{color:#fff;font-weight:600}
.terminal-empty-text{max-width:300px;font-size:var(--fs-xs);line-height:1.5}
.session-foot{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--chrome-line);color:rgba(255,255,255,.45);font-size:var(--fs-2xs)}
.session-foot code{color:rgba(255,255,255,.8);user-select:all}
`;
