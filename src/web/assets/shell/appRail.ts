import { brandGlyphSvg } from "../shared/brand.js";
import { iconSvg } from "../shared/icons.js";

// The global navigation rail, identical on the workbench and on the
// management pages so Workbench / Models / Settings keep one place and one
// order everywhere. `current` marks the document's own area; the management
// router re-marks Models/Settings as it switches sections. Links carry
// data-nav-area so each returns to where the user last was in that area.
export type RailArea = "workbench" | "models" | "settings";

const item = (area: RailArea, href: string, icon: string, key: string, label: string, current: RailArea, id?: string) =>
  `<a${id ? ` id="${id}"` : ""} class="rail-item" href="${href}" data-area="${area}"${area === current ? ` aria-current="page"` : ""}${area === "workbench" && current === "workbench" ? "" : ` data-nav-area="${area}"`} title="${label}" data-i18n-title="${key}">${iconSvg(icon)}<span data-i18n="${key}">${label}</span></a>`;

export function appRail(current: RailArea): string {
  const brandNav = current === "workbench" ? "" : ` data-nav-area="workbench"`;
  return `<nav class="app-rail" aria-label="Main navigation" data-i18n-aria-label="manage.nav">
      <a class="rail-brand" href="/"${brandNav} title="Yui"><span class="brand-mark" aria-hidden="true">${brandGlyphSvg()}</span><span class="sr-only">Yui</span></a>
      <div class="rail-items">
        ${item("workbench", "/", "workbench", "manage.workbench", "Workbench", current, current === "workbench" ? "rail-workbench" : undefined)}
        ${item("models", "/models", "layers", "models.title", "Models", current)}
        ${item("settings", "/settings", "settings", "settings.title", "Settings", current, current === "workbench" ? "settings-open" : undefined)}
      </div>
    </nav>`;
}
