/*
 * MARKDOWN — rendered Agent/user prose. .md is produced by client/markdown.ts
 * (escaped HTML plus a small set of our own inline and block tags).
 */
export const MARKDOWN_STYLES = `
.md{display:grid;gap:7px;min-width:0;font-size:var(--fs-sm);line-height:1.62;color:var(--ink);overflow-wrap:anywhere}
.md p{margin:0}
.md h4,.md h5,.md h6{margin:6px 0 0;font-weight:600;line-height:1.35}
.md h4{font-size:var(--fs-md)}
.md h5{font-size:var(--fs-sm)}
.md h6{font-size:var(--fs-sm);color:var(--ink-2)}
.md ul,.md ol{margin:0;padding-left:20px;display:grid;gap:3px}
.md li::marker{color:var(--ink-4)}
.md code{padding:1px 5px;border-radius:var(--r-xs);background:var(--surface-3);font-size:.88em}
.md pre{margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--sunken);overflow-x:auto}
.md pre code{padding:0;background:transparent;font-size:var(--fs-2xs);line-height:1.55}
.md a{color:var(--accent);text-decoration:underline;text-decoration-color:var(--accent-line);text-underline-offset:3px}
.md a:hover{text-decoration-color:currentColor}
.md strong{font-weight:600}
.md.muted{color:var(--ink-2)}
`;
