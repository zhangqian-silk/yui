export const MODELS_SCRIPT = String.raw`
import { api } from "/assets/js/lib/api.js";
import { i18n, createManageShell, registerManagePage, navigateManage, readManageRoute } from "/assets/js/layout/manageShell.js";
import { mountModels } from "/assets/js/views/models.js";
const shell = createManageShell({ page: "models", t: i18n.t });
const initial = readManageRoute(new URL(location.href));
const page = mountModels(document.querySelector("#models-root"), {
  t: i18n.t, locale: i18n.getLocale, api, route: initial,
  navigate: next => navigateManage({ page: "models", ...next }),
  onChange: flags => shell.setDirty({ providers: !!flags.provider, connection: !!flags.connection })
});
registerManagePage("models", { show: next => page.show(next) });
window.setInterval(() => page.updateFreshness(), 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) page.updateFreshness(); });
i18n.subscribe(() => page.translate());
window.addEventListener("beforeunload", event => {
  if (!page.dirty()) return;
  event.preventDefault(); event.returnValue = "";
});
`;
