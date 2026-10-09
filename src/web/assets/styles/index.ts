import { FONT_FACE_STYLES } from "../fonts.js";
import { BASE_STYLES } from "./base.js";
import { RESPONSIVE_STYLES } from "./layout/responsive.js";
import { WORKSPACE_STYLES } from "./layout/workspace.js";
import { MARKDOWN_STYLES } from "./markdown.js";
import { TOKEN_STYLES } from "./tokens.js";
import { CONTROL_STYLES } from "./ui/controls.js";
import { FORM_STYLES } from "./ui/forms.js";
import { SURFACE_STYLES } from "./ui/surfaces.js";
import { DELIVERY_STYLES } from "./views/delivery.js";
import { DOCK_STYLES } from "./views/dock.js";
import { PAGE_STYLES } from "./views/page.js";
import { RECORD_STYLES } from "./views/records.js";
import { SIDEBAR_STYLES } from "./views/sidebar.js";
import { TASK_STYLES } from "./views/task.js";
import { TERMINAL_STYLES } from "./views/terminal.js";

// The stylesheet registry, in cascade order: foundations (fonts, tokens,
// element defaults), the workspace frame, shared UI primitives, then one
// sheet per view, rendered prose, and breakpoints last so they override
// everything above. Each entry is served at /assets/css/<name>.css and linked
// by the shell in this order; later sheets may rely on earlier ones.
export const STYLESHEETS: readonly { name: string; body: string }[] = Object.freeze([
  { name: "fonts", body: FONT_FACE_STYLES },
  { name: "tokens", body: TOKEN_STYLES },
  { name: "base", body: BASE_STYLES },
  { name: "layout/workspace", body: WORKSPACE_STYLES },
  { name: "ui/controls", body: CONTROL_STYLES },
  { name: "ui/surfaces", body: SURFACE_STYLES },
  { name: "ui/forms", body: FORM_STYLES },
  { name: "views/sidebar", body: SIDEBAR_STYLES },
  { name: "views/page", body: PAGE_STYLES },
  { name: "views/task", body: TASK_STYLES },
  { name: "views/records", body: RECORD_STYLES },
  { name: "views/delivery", body: DELIVERY_STYLES },
  { name: "views/dock", body: DOCK_STYLES },
  { name: "views/terminal", body: TERMINAL_STYLES },
  { name: "markdown", body: MARKDOWN_STYLES },
  { name: "layout/responsive", body: RESPONSIVE_STYLES }
]);
