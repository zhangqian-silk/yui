// Client module registry. Each module is an ES module served at
// /assets/js/<path>.js; the entry script is served at /assets/app.js.
// Layers import only downward:
//   lib/     browser utilities (DOM, formatting, preferences, i18n, theme, API)
//   ui/      domain-free components (primitives, containers, controls, forms)
//   domain/  Yui vocabulary and record rendering (Context reads, work, runs)
//   views/   page regions (sidebar, overview, Task page, dock, dialogs)
//   layout/  workspace columns, sizing, URL state, keyboard shortcuts
//   app/     the composition root (main) and the controllers that own view
//            state; each controller takes one explicit deps object and only
//            main wires controllers to each other
// See ../README.md for the module map.
// In-module imports are single-line `import { … } from "/assets/js/…"`.
import { API_SCRIPT } from "./lib/api.js";
import { DOM_SCRIPT } from "./lib/dom.js";
import { FORMAT_SCRIPT } from "./lib/format.js";
import { I18N_SCRIPT } from "./lib/i18n.js";
import { MARKDOWN_SCRIPT } from "./lib/markdown.js";
import { PREFS_SCRIPT } from "./lib/prefs.js";
import { THEME_SCRIPT } from "./lib/theme.js";
import { CONTAINERS_SCRIPT } from "./ui/containers.js";
import { CONTROLS_SCRIPT } from "./ui/controls.js";
import { FORMS_SCRIPT } from "./ui/forms.js";
import { METRICS_SCRIPT } from "./ui/metrics.js";
import { PRIMITIVES_SCRIPT } from "./ui/primitives.js";
import { TEXT_SCRIPT } from "./ui/text.js";
import { TOAST_SCRIPT } from "./ui/toast.js";
import { CONTEXT_SCRIPT } from "./domain/context.js";
import { RECORDS_SCRIPT } from "./domain/records.js";
import { RUNS_SCRIPT } from "./domain/runs.js";
import { TASK_FORMS_SCRIPT } from "./domain/taskForms.js";
import { VOCAB_SCRIPT } from "./domain/vocab.js";
import { WORK_SCRIPT } from "./domain/work.js";
import { DISCUSSION_SCRIPT } from "./views/dock/discussion.js";
import { CONVERSATION_SCRIPT } from "./views/dock/conversation.js";
import { TERMINAL_SCRIPT } from "./views/dock/terminal.js";
import { GLOBAL_INPUT_SCRIPT } from "./views/globalInput.js";
import { CREATE_TASK_SCRIPT } from "./views/createTask.js";
import { OVERVIEW_SCRIPT } from "./views/overview.js";
import { SIDEBAR_SCRIPT } from "./views/sidebar.js";
import { TASK_DELIVERY_SCRIPT } from "./views/task/delivery.js";
import { TASK_DELIVERY_RESULTS_SCRIPT } from "./views/task/deliveryResults.js";
import { TASK_FILES_SCRIPT } from "./views/task/files.js";
import { TASK_OBSERVATION_SCRIPT } from "./views/task/observation.js";
import { TASK_OVERVIEW_SCRIPT } from "./views/task/overview.js";
import { TASK_PAGE_SCRIPT } from "./views/task/page.js";
import { TASK_ACTIONS_SCRIPT } from "./views/task/actions.js";
import { TASK_RECORDS_SCRIPT } from "./views/task/records.js";
import { TASK_RUNTIME_SCRIPT } from "./views/task/runtime.js";
import { TASK_TIMELINE_SCRIPT } from "./views/task/timeline.js";
import { RESIZER_SCRIPT } from "./layout/resizer.js";
import { ROUTER_SCRIPT } from "./layout/router.js";
import { SHORTCUTS_SCRIPT } from "./layout/shortcuts.js";
import { SIZING_SCRIPT } from "./layout/sizing.js";
import { WORKSPACE_SCRIPT } from "./layout/workspace.js";
import { CATALOG_SCRIPT } from "./app/catalog.js";
import { SELECTION_SCRIPT } from "./app/selection.js";
import { TASK_VIEW_SCRIPT } from "./app/taskView.js";
import { SETTINGS_SCRIPT } from "./app/settings.js";

export { APP_SCRIPT } from "./app/main.js";

export const CLIENT_MODULES: Readonly<Record<string, string>> = Object.freeze({
  "lib/dom": DOM_SCRIPT,
  "lib/format": FORMAT_SCRIPT,
  "lib/prefs": PREFS_SCRIPT,
  "lib/i18n": I18N_SCRIPT,
  "lib/theme": THEME_SCRIPT,
  "lib/api": API_SCRIPT,
  "lib/markdown": MARKDOWN_SCRIPT,
  "ui/primitives": PRIMITIVES_SCRIPT,
  "ui/containers": CONTAINERS_SCRIPT,
  "ui/text": TEXT_SCRIPT,
  "ui/controls": CONTROLS_SCRIPT,
  "ui/forms": FORMS_SCRIPT,
  "ui/metrics": METRICS_SCRIPT,
  "ui/toast": TOAST_SCRIPT,
  "domain/vocab": VOCAB_SCRIPT,
  "domain/context": CONTEXT_SCRIPT,
  "domain/records": RECORDS_SCRIPT,
  "domain/work": WORK_SCRIPT,
  "domain/runs": RUNS_SCRIPT,
  "domain/taskForms": TASK_FORMS_SCRIPT,
  "views/sidebar": SIDEBAR_SCRIPT,
  "views/overview": OVERVIEW_SCRIPT,
  "views/globalInput": GLOBAL_INPUT_SCRIPT,
  "views/createTask": CREATE_TASK_SCRIPT,
  "views/dock/discussion": DISCUSSION_SCRIPT,
  "views/dock/conversation": CONVERSATION_SCRIPT,
  "views/dock/terminal": TERMINAL_SCRIPT,
  "views/task/page": TASK_PAGE_SCRIPT,
  "views/task/actions": TASK_ACTIONS_SCRIPT,
  "views/task/overview": TASK_OVERVIEW_SCRIPT,
  "views/task/observation": TASK_OBSERVATION_SCRIPT,
  "views/task/runtime": TASK_RUNTIME_SCRIPT,
  "views/task/timeline": TASK_TIMELINE_SCRIPT,
  "views/task/records": TASK_RECORDS_SCRIPT,
  "views/task/delivery": TASK_DELIVERY_SCRIPT,
  "views/task/deliveryResults": TASK_DELIVERY_RESULTS_SCRIPT,
  "views/task/files": TASK_FILES_SCRIPT,
  "layout/resizer": RESIZER_SCRIPT,
  "layout/sizing": SIZING_SCRIPT,
  "layout/workspace": WORKSPACE_SCRIPT,
  "layout/router": ROUTER_SCRIPT,
  "layout/shortcuts": SHORTCUTS_SCRIPT,
  "app/catalog": CATALOG_SCRIPT,
  "app/taskView": TASK_VIEW_SCRIPT,
  "app/settings": SETTINGS_SCRIPT,
  "app/selection": SELECTION_SCRIPT
});
