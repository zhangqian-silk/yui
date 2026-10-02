import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { API_SCRIPT } from "./client/api.js";
import { APP_SCRIPT } from "./client/app.js";
import { COMPONENTS_SCRIPT } from "./client/components.js";
import { DETAIL_SCRIPT } from "./client/detail.js";
import { DOCK_SCRIPT } from "./client/dock.js";
import { DOM_SCRIPT } from "./client/dom.js";
import { EVIDENCE_SCRIPT } from "./client/evidence.js";
import { FORMAT_SCRIPT } from "./client/format.js";
import { FORMS_SCRIPT } from "./client/forms.js";
import { I18N_SCRIPT } from "./client/i18n.js";
import { MARKDOWN_SCRIPT } from "./client/markdown.js";
import { OVERVIEW_SCRIPT } from "./client/overview.js";
import { RECORDS_SCRIPT } from "./client/records.js";
import { SECTIONS_SCRIPT } from "./client/sections.js";
import { SIDEBAR_SCRIPT } from "./client/sidebar.js";
import { THEME_SCRIPT } from "./client/theme.js";
import { DASHBOARD_HTML } from "./shell.js";
import { FONT_FACE_STYLES } from "./fonts.js";
import { FONT_WOFF2_BASE64 } from "./fontData.js";
import { BASE_STYLES } from "./styles/base.js";
import { COMPONENT_STYLES } from "./styles/components.js";
import { LAYOUT_STYLES } from "./styles/layout.js";
import { MARKDOWN_STYLES } from "./styles/markdown.js";
import { RESPONSIVE_STYLES } from "./styles/responsive.js";
import { TOKEN_STYLES } from "./styles/tokens.js";
import { VIEW_STYLES } from "./styles/views.js";

export type WebAsset = Readonly<{
  contentType: string;
  body: string;
  encoding?: "utf-8" | "base64";
}>;

const require = createRequire(import.meta.url);
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

export const WEB_ASSETS: Readonly<Record<string, WebAsset>> = Object.freeze({
  "/assets/css/fonts.css": { contentType: CSS, body: FONT_FACE_STYLES },
  "/assets/css/tokens.css": { contentType: CSS, body: TOKEN_STYLES },
  "/assets/css/base.css": { contentType: CSS, body: BASE_STYLES },
  "/assets/css/layout.css": { contentType: CSS, body: LAYOUT_STYLES },
  "/assets/css/components.css": { contentType: CSS, body: COMPONENT_STYLES },
  "/assets/css/views.css": { contentType: CSS, body: VIEW_STYLES },
  "/assets/css/markdown.css": { contentType: CSS, body: MARKDOWN_STYLES },
  "/assets/css/responsive.css": { contentType: CSS, body: RESPONSIVE_STYLES },
  "/assets/js/dom.js": { contentType: JS, body: DOM_SCRIPT },
  "/assets/js/format.js": { contentType: JS, body: FORMAT_SCRIPT },
  "/assets/js/i18n.js": { contentType: JS, body: I18N_SCRIPT },
  "/assets/js/markdown.js": { contentType: JS, body: MARKDOWN_SCRIPT },
  "/assets/js/theme.js": { contentType: JS, body: THEME_SCRIPT },
  "/assets/js/api.js": { contentType: JS, body: API_SCRIPT },
  "/assets/js/components.js": { contentType: JS, body: COMPONENTS_SCRIPT },
  "/assets/js/records.js": { contentType: JS, body: RECORDS_SCRIPT },
  "/assets/js/forms.js": { contentType: JS, body: FORMS_SCRIPT },
  "/assets/js/evidence.js": { contentType: JS, body: EVIDENCE_SCRIPT },
  "/assets/js/sidebar.js": { contentType: JS, body: SIDEBAR_SCRIPT },
  "/assets/js/overview.js": { contentType: JS, body: OVERVIEW_SCRIPT },
  "/assets/js/sections.js": { contentType: JS, body: SECTIONS_SCRIPT },
  "/assets/js/detail.js": { contentType: JS, body: DETAIL_SCRIPT },
  "/assets/js/dock.js": { contentType: JS, body: DOCK_SCRIPT },
  "/assets/app.js": { contentType: JS, body: APP_SCRIPT },
  ...fontAssets(),
  "/assets/vendor/xterm.mjs": vendorAsset(
    "@xterm/xterm/lib/xterm.mjs",
    "text/javascript; charset=utf-8"
  ),
  "/assets/vendor/addon-fit.mjs": vendorAsset(
    "@xterm/addon-fit/lib/addon-fit.mjs",
    "text/javascript; charset=utf-8"
  ),
  "/assets/vendor/xterm.css": vendorAsset(
    "@xterm/xterm/css/xterm.css",
    "text/css; charset=utf-8"
  )
});

export { DASHBOARD_HTML };

export function findWebAsset(pathname: string): WebAsset | null {
  return WEB_ASSETS[pathname] ?? null;
}

function vendorAsset(specifier: string, contentType: string): WebAsset {
  return {
    contentType,
    body: readFileSync(require.resolve(specifier), "utf8")
  };
}

function fontAssets(): Record<string, WebAsset> {
  const entries: Record<string, WebAsset> = {};
  for (const [key, base64] of Object.entries(FONT_WOFF2_BASE64)) {
    entries[`/assets/fonts/${key}.woff2`] = {
      contentType: "font/woff2",
      encoding: "base64",
      body: base64
    };
  }
  return entries;
}
