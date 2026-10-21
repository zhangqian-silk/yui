import { DIVIDER_WIDTH, DOCK } from "../shared/geometry.js";
import { motionTokenStyles } from "../shared/motion.js";
import { themeTokenStyles } from "../shared/themes.js";

/*
 * DESIGN TOKENS
 * -------------
 * Geometry, type, radii, motion and the focus ring are theme-independent and
 * live once on :root. Colour and effect tokens come from the theme registry
 * (shared/themes.ts), one block per theme, so switching a theme can never move
 * or resize anything. Layout widths come from shared/geometry.ts and motion
 * (durations, easings, stacking layers) from shared/motion.ts, the same
 * sources the client scripts read.
 */
export const TOKEN_STYLES = `
:root{
  --font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --font-mono:"JetBrains Mono",ui-monospace,"SFMono-Regular",Menlo,Consolas,monospace;
  --fs-2xs:10.5px;--fs-xs:11.5px;--fs-sm:12.5px;--fs-md:13.5px;--fs-lg:15px;--fs-xl:19px;--fs-2xl:24px;
  --r-xs:5px;--r-sm:7px;--r-md:10px;--r-lg:14px;--r-pill:999px;
  --sidebar-w:clamp(260px,21vw,312px);--dock-w:${DOCK.initial}px;--divider-w:${DIVIDER_WIDTH}px;
  --center-max:880px;--header-h:56px;--gutter:clamp(16px,3vw,40px);
  ${motionTokenStyles()}
  --focus:0 0 0 2px var(--canvas),0 0 0 4px var(--accent-line);
}
${themeTokenStyles()}
`;
