import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { WEB_ASSETS, DASHBOARD_HTML } from "../../dist/web/assets/assetManifest.js";
import { SETTINGS_HTML } from "../../dist/web/assets/shell/settings.js";
import { MODELS_HTML } from "../../dist/web/assets/shell/models.js";
import { PREFS_SCRIPT } from "../../dist/web/assets/client/lib/prefs.js";
import { THEME_SCRIPT } from "../../dist/web/assets/client/lib/theme.js";
import { BRAND_ICONS } from "../../dist/web/assets/shared/brand.js";

function fixture(html, saved, light, storageDenied = false) {
  const values = new Map(saved == null ? [] : [["yui.theme", saved]]);
  const applied = [];
  const dataset = new Proxy({ theme: html.match(/<html[^>]*data-theme="([^"]+)"/)?.[1] }, {
    set(target, key, value) { target[key] = value; if (key === "theme") applied.push(value); return true; }
  });
  const icon = { href: html.match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1],
    getAttribute() { return this.href; }, setAttribute(name, value) { this.href = value; } };
  let mediaListener;
  const media = { matches: light, addEventListener(name, listener) {
    assert.equal(name, "change"); mediaListener = listener;
  } };
  const container = {
    children: [],
    replaceChildren(...children) { this.children = children; },
    querySelectorAll() { return this.children; }
  };
  const context = vm.createContext({
    document: { documentElement: { dataset }, querySelector: selector => selector === 'link[rel="icon"]' ? icon : null },
    window: { matchMedia(query) { assert.equal(query, "(prefers-color-scheme: light)"); return media; } },
    localStorage: {
      getItem(key) { if (storageDenied) throw Error("denied"); return values.get(key) ?? null; },
      setItem(key, value) { if (storageDenied) throw Error("denied"); values.set(key, value); }
    },
    h(spec, attrs, ...children) { return { ...attrs, children, dataset: attrs?.dataset ?? {}, style: {} }; },
    markSelected(elements, attribute, selected) {
      for (const element of elements) element[attribute] = String(selected(element));
    }
  });
  return {
    context, dataset, applied, values, container, icon,
    start() {
      vm.runInContext(PREFS_SCRIPT.replace(/^export /gm, ""), context);
      vm.runInContext(THEME_SCRIPT.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
      return context.createThemeController(container, key => key);
    },
    system(nextLight) { media.matches = nextLight; mediaListener(); },
    selected() { return container.children.find(button => button["aria-pressed"] === "true")?.dataset.themeOption; }
  };
}

function initializeBeforeStyles(html, context) {
  // Only synchronous classic scripts reached before CSS/body can establish
  // the theme without waiting for the deferred application module graph.
  const boundary = html.search(/<link\b[^>]*rel="stylesheet"|<body\b/);
  const scripts = [...html.slice(0, boundary).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length, "theme initialization must run before styles and visible content");
  for (const [, attributes, inline] of scripts) {
    assert.doesNotMatch(attributes, /\b(?:async|defer)\b|\btype\s*=\s*["']module["']/);
    const path = attributes.match(/\bsrc="([^"]+)"/)?.[1];
    assert.ok(!path || WEB_ASSETS[path], `early script ${path} must be served`);
    vm.runInContext(path ? WEB_ASSETS[path].body : inline, context);
  }
}

test("every Web entry page resolves persisted/system themes before styles and keeps that theme at client startup", () => {
  const cases = [
    { saved: "washi", light: false, expected: "washi", preference: "washi" },
    { saved: "sumi", light: true, expected: "sumi", preference: "sumi" },
    { saved: "ai", light: true, expected: "ai", preference: "ai" },
    { saved: "system", light: true, expected: "washi", preference: "system" },
    { saved: "system", light: false, expected: "sumi", preference: "system" },
    { saved: null, light: true, expected: "washi", preference: "system" },
    { saved: null, light: false, expected: "sumi", preference: "system" },
    { saved: "unknown", light: true, expected: "washi", preference: "system" },
    { saved: "washi", light: false, denied: true, expected: "sumi", preference: "system" }
  ];
  for (const html of [DASHBOARD_HTML, SETTINGS_HTML, MODELS_HTML]) for (const scenario of cases) {
    const f = fixture(html, scenario.saved, scenario.light, scenario.denied);
    initializeBeforeStyles(html, f.context);
    assert.equal(f.dataset.theme, scenario.expected, "theme is correct while application modules are still unloaded");
    assert.equal(f.icon.href, BRAND_ICONS[scenario.expected], "favicon follows the resolved theme");
    const controller = f.start();
    assert.equal(controller.resolved(), scenario.expected);
    assert.equal(f.selected(), scenario.preference);
    assert.ok(f.applied.every(theme => theme === scenario.expected), "client startup must not introduce a wrong theme");
    assert.equal(f.values.get("yui.theme") ?? null, scenario.saved, "initialization does not rewrite preference");
  }
});

test("theme choices persist across navigation/reload and system changes only affect system mode", () => {
  const f = fixture(DASHBOARD_HTML, "system", true);
  initializeBeforeStyles(DASHBOARD_HTML, f.context);
  const controller = f.start();
  const notifications = [];
  controller.subscribe(theme => notifications.push(theme));
  f.system(false);
  assert.equal(f.dataset.theme, "sumi");
  f.container.children.find(button => button.dataset.themeOption === "ai").onclick();
  assert.equal(f.values.get("yui.theme"), "ai");
  assert.equal(f.selected(), "ai");
  f.system(true);
  assert.equal(f.dataset.theme, "ai");
  assert.equal(f.icon.href, BRAND_ICONS.ai);
  assert.deepEqual(notifications, ["sumi", "ai"]);
  controller.render();
  assert.equal(f.dataset.theme, "ai", "settings re-render preserves explicit choice");
  for (const html of [SETTINGS_HTML, DASHBOARD_HTML]) {
    const next = fixture(html, f.values.get("yui.theme"), true);
    initializeBeforeStyles(html, next.context);
    assert.equal(next.dataset.theme, "ai");
    assert.equal(next.start().resolved(), "ai");
  }
  controller.set("system");
  assert.equal(f.values.get("yui.theme"), "system");
  assert.equal(f.dataset.theme, "washi");
  f.system(false);
  assert.equal(f.dataset.theme, "sumi");
  controller.set("unknown");
  assert.equal(f.values.get("yui.theme"), "system");
  assert.equal(f.selected(), "system");
});
