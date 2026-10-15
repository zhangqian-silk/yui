export const MODELS_SCRIPT = String.raw`
// Entry for the standalone /models page. The page body lives in
// views/models; this module only binds the shell, translation and the
// unsaved-draft guard.
import { api } from "/assets/js/lib/api.js";
import { createI18n } from "/assets/js/lib/i18n.js";
import { mountModels } from "/assets/js/views/models.js";

const i18n = createI18n(document.querySelector("#locale-select"));
const t = i18n.t;
let page = mountModels(document.querySelector("#models-root"), { t: t, locale: i18n.getLocale, api: api });
// A language switch re-reads the page unless that would drop a draft or an
// unresolved-write warning; those keep the current language until reload.
i18n.subscribe(function () {
  if (page.dirty() || page.state.unknown) return;
  page = mountModels(document.querySelector("#models-root"), { t: t, locale: i18n.getLocale, api: api });
});
window.addEventListener("beforeunload", function (event) {
  if (!page.dirty()) return;
  event.preventDefault(); event.returnValue = "";
});
`;
