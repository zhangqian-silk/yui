import { EN } from "../i18n/en.js";
import { ZH_CN } from "../i18n/zh-CN.js";

export const I18N_SCRIPT = String.raw`
// Translation runtime. Static shell markup opts in with data-i18n (text) and
// data-i18n-placeholder / -aria-label / -title (attributes). A missing zh-CN
// key falls back to en, then to the caller's fallback, then to the key.
import { readPreference, writePreference } from "/assets/js/lib/prefs.js";

const messages = ${JSON.stringify({ en: EN, "zh-CN": ZH_CN })};
export const SUPPORTED_LOCALES = Object.freeze(Object.keys(messages));
const TRANSLATED_ATTRIBUTES = ["placeholder", "aria-label", "title"];

function preferredLocale() {
  const saved = readPreference("yui.locale", null);
  if (SUPPORTED_LOCALES.includes(saved)) return saved;
  const languages = navigator.languages || [navigator.language];
  return languages.some(function (language) { return String(language).toLowerCase().startsWith("zh"); }) ? "zh-CN" : "en";
}

export function createI18n(select) {
  let locale = preferredLocale();
  const subscribers = new Set();
  function t(key, fallback) {
    const value = messages[locale][key] || messages.en[key];
    return value !== undefined ? value : fallback !== undefined ? fallback : key;
  }
  function apply() {
    document.documentElement.lang = locale;
    document.title = t("app.title");
    document.querySelectorAll("[data-i18n]").forEach(function (element) { element.textContent = t(element.dataset.i18n); });
    TRANSLATED_ATTRIBUTES.forEach(function (attribute) {
      document.querySelectorAll("[data-i18n-" + attribute + "]").forEach(function (element) {
        element.setAttribute(attribute, t(element.getAttribute("data-i18n-" + attribute)));
      });
    });
    if (select) select.value = locale;
  }
  function setLocale(next) {
    if (!SUPPORTED_LOCALES.includes(next) || next === locale) return;
    locale = next;
    writePreference("yui.locale", locale);
    apply();
    subscribers.forEach(function (subscriber) { subscriber(locale); });
  }
  if (select) select.addEventListener("change", function () { setLocale(select.value); });
  apply();
  return {
    t: t,
    getLocale: function () { return locale; },
    setLocale: setLocale,
    subscribe: function (subscriber) { subscribers.add(subscriber); }
  };
}
`;
