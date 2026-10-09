import { DIVIDER_WIDTH, DOCK } from "../shared/geometry.js";
import { themeTokenStyles } from "../shared/themes.js";

/*
 * DESIGN TOKENS
 * -------------
 * Geometry, type, radii, motion and the focus ring are theme-independent and
 * live once on :root. Colour and effect tokens come from the theme registry
 * (shared/themes.ts), one block per theme, so switching a theme can never move
 * or resize anything. Layout widths come from shared/geometry.ts, the same
 * source the client layout controller clamps against.
 */
export const TOKEN_STYLES = `
:root{
  --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  --fs-2xs:10.5px;--fs-xs:11.5px;--fs-sm:12.5px;--fs-md:13.5px;--fs-lg:15px;--fs-xl:19px;--fs-2xl:24px;
  --r-xs:5px;--r-sm:7px;--r-md:10px;--r-lg:14px;--r-pill:999px;
  --sidebar-w:clamp(260px,21vw,312px);--dock-w:${DOCK.initial}px;--divider-w:${DIVIDER_WIDTH}px;
  --center-max:880px;--header-h:56px;--gutter:clamp(16px,3vw,40px);
  --t-fast:120ms;--t-med:220ms;--ease:cubic-bezier(.2,.8,.2,1);
  --focus:0 0 0 2px var(--canvas),0 0 0 4px var(--accent-line);
}
${themeTokenStyles()}
`;
