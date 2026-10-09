// Every asset the dashboard serves, keyed by URL path. Stylesheets come from
// the ordered styles registry, client modules from the client registry, and
// fonts and xterm from their packages; the shell links them in this order.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { APP_SCRIPT, CLIENT_MODULES } from "./client/index.js";
import { FONT_WOFF2_BASE64 } from "./fontData.js";
import { DASHBOARD_HTML } from "./shell/index.js";
import { STYLESHEETS } from "./styles/index.js";

export type WebAsset = Readonly<{
  contentType: string;
  body: string;
  encoding?: "utf-8" | "base64";
}>;

const require = createRequire(import.meta.url);
const CSS = "text/css; charset=utf-8";
const JS = "text/javascript; charset=utf-8";

export const WEB_ASSETS: Readonly<Record<string, WebAsset>> = Object.freeze({
  ...Object.fromEntries(STYLESHEETS.map(({ name, body }) => [`/assets/css/${name}.css`, { contentType: CSS, body }])),
  ...Object.fromEntries(Object.entries(CLIENT_MODULES).map(([path, body]) => [`/assets/js/${path}.js`, { contentType: JS, body }])),
  "/assets/app.js": { contentType: JS, body: APP_SCRIPT },
  ...fontAssets(),
  "/assets/vendor/xterm.mjs": vendorAsset("@xterm/xterm/lib/xterm.mjs", JS),
  "/assets/vendor/addon-fit.mjs": vendorAsset("@xterm/addon-fit/lib/addon-fit.mjs", JS),
  "/assets/vendor/xterm.css": vendorAsset("@xterm/xterm/css/xterm.css", CSS)
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
