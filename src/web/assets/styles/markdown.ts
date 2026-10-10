/*
 * MARKDOWN — rendered Agent/user prose. .md is produced by
 * client/lib/markdown.ts (escaped HTML plus a small set of our own inline and
 * block tags).
 */
export const MARKDOWN_STYLES = `
.md{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;min-width:0;font-size:var(--fs-sm);line-height:1.62;color:var(--ink);overflow-wrap:anywhere}
.md>*{min-width:0}
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
.md blockquote{margin:0;padding:4px 14px;border-left:3px solid var(--line);color:var(--ink-2);display:grid;gap:7px}
.md hr{width:100%;border:0;border-top:1px solid var(--line)}
.md-table{max-width:100%;overflow:auto}
.md table{border-collapse:collapse;width:100%;font-size:inherit}
.md th,.md td{border:1px solid var(--line);padding:6px 10px;text-align:left}
.md th{background:var(--surface-3);font-weight:600}
.md li>p{display:inline}
.md li>ul,.md li>ol{margin-top:4px}
.md input[type=checkbox]{width:14px;height:14px;padding:0;margin:0 6px 0 0;vertical-align:middle;accent-color:var(--accent)}
.artifact-markdown{padding:16px;border:1px solid var(--line);border-radius:var(--r-md);background:var(--surface)}
.md-image-slot,.image-preview{display:block;min-width:0;max-width:100%;margin:8px 0}
.image-viewport{display:block;max-width:100%;max-height:70vh;overflow:auto;border:1px solid var(--line);border-radius:var(--r-md);background:var(--sunken)}
.artifact-image{display:block;max-width:100%;height:auto;margin:auto}
.artifact-image.is-zoomed{max-width:none;margin:0}
.image-preview .record-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px}
.image-preview select{width:auto;max-width:100%}
.md-image-slot>.viewer-ref{display:block;overflow-wrap:anywhere}
`;
