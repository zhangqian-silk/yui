import { THEMES } from "./themes.js";

// The Yui mark: a capital Y with an accent dot on a tile (64×64 grid). One
// geometry source for the in-page mark and the favicon. The in-page mark is
// drawn with theme tokens via CSS (tile = ink, Y = canvas, dot = accent), so it
// follows a theme switch; the favicon cannot read page CSS, so each theme gets
// a pre-coloured copy that the theme script swaps in.
const Y_PATH = "M17 17L30 33L43 17M30 33V49";
const DOT = { cx: 49.5, cy: 46, r: 4.6 } as const;

// Inline glyph for `.brand-mark`; the tile itself is the element's background.
export function brandGlyphSvg(): string {
  return `<svg class="brand-glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">`
    + `<path d="${Y_PATH}" fill="none" stroke="currentColor" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle class="brand-dot" cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}"/></svg>`;
}

function brandIconSvg(tile: string, glyph: string, dot: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" rx="16" fill="${tile}"/>`
    + `<path d="${Y_PATH}" fill="none" stroke="${glyph}" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<circle cx="${DOT.cx}" cy="${DOT.cy}" r="${DOT.r}" fill="${dot}"/></svg>`;
}

// Favicon data URIs keyed by theme id (img-src allows data:).
export const BRAND_ICONS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(
  THEMES.map(theme => [theme.id, "data:image/svg+xml," + encodeURIComponent(
    brandIconSvg(theme.tokens.ink, theme.tokens.canvas, theme.tokens.accent))])
));
