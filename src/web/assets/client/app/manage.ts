export const MANAGE_SCRIPT = String.raw`
import "/assets/js/app/settings.js";
import "/assets/js/app/models.js";
import "/assets/js/app/jobs.js";
import { startManagement } from "/assets/js/layout/manageShell.js";
import { createSidebarNav } from "/assets/js/layout/sidebarNav.js";
import { isEditing } from "/assets/js/lib/dom.js";

// The section list behaves like the workbench task list: collapsible beside
// the content, a drawer (with the global rail) on narrow screens.
const sidebarNav = createSidebarNav({
  el: { sidebar: document.querySelector(".manage-rail"), rail: document.querySelector(".app-rail"), scrim: document.querySelector("#sidebar-scrim"),
    collapse: document.querySelector("#sidebar-collapse") },
  relayout: function () {}
});
document.querySelectorAll("[data-sidebar-toggle]").forEach(function (button) {
  button.addEventListener("click", sidebarNav.reveal);
});
document.addEventListener("keydown", function (event) {
  if (document.querySelector("dialog[open]") || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === "Escape" && sidebarNav.drawerOpen()) { sidebarNav.closeDrawer(); return; }
  if (event.key === "[" && !isEditing(document.activeElement)) sidebarNav.toggle();
});
startManagement();
`;
