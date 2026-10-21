import { manageDocument } from "./manage.js";
import { SETTINGS_MAIN } from "./settingsContent.js";

// One document for /jobs, /models/* and /settings/*. The controllers stay
// mounted across history navigation, preserving drafts, observations and locale.
export const MODELS_HTML = manageDocument({ page: "models", title: "Models", main: `
      <div id="settings-root" hidden>${SETTINGS_MAIN}</div>
      <div id="models-root" class="models-root" hidden></div>
      <div id="jobs-root" class="jobs-root" hidden></div>` });
