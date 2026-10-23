import { manageHead } from "./manage.js";

// Settings content in the shared management document. Sections stay mounted
// across /settings/* and /models/* navigation.
export const SETTINGS_MAIN = `
      <section class="manage-section" data-section="preferences" aria-labelledby="settings-preferences-title">
        ${manageHead("settings-preferences-title", "settings.section.preferences", "Preferences", "settings.hint.preferences", "Theme, language and workspace layout for this browser. Changes apply here immediately and are never sent to the server.")}
        <section class="card settings-card">
          <h2 data-i18n="settings.browser">This browser</h2>
          <div class="settings-grid">
            <fieldset class="field"><legend data-i18n="settings.theme">Theme</legend><div id="theme-options" class="theme-options"></div></fieldset>
            <div class="settings-stack">
              <label class="field"><span data-i18n="settings.language">Language</span><select id="settings-locale"><option value="en">English</option><option value="zh-CN">简体中文</option></select></label>
              <label class="field"><span data-i18n="settings.accessMode">Default session access</span><select id="access-mode"><option value="structured" data-i18n="settings.structured">Structured view</option><option value="native" data-i18n="settings.native">Native terminal</option></select></label>
              <p data-i18n="settings.accessHelp">Preference for subsequent session selection where supported. It does not switch a live Session.</p>
              <button id="reset-layout" type="button" class="btn" data-i18n="settings.resetLayout">Reset saved workspace layout</button>
              <p id="browser-receipt" role="status"></p>
            </div>
          </div>
        </section>
      </section>
      <section class="manage-section" data-section="skills" aria-labelledby="settings-skills-title" hidden>
        ${manageHead("settings-skills-title", "settings.section.skills", "Skills", "skills.browser.intro", "Read existing packages and choose additional bindings for one explicit Role. Scripts are displayed as data, never run.")}
        <section id="skill-browser" class="card settings-card settings-stack"></section>
      </section>
      <section class="manage-section" data-section="server" aria-labelledby="settings-server-title" hidden>
        ${manageHead("settings-server-title", "settings.section.server", "Agents & server", "settings.hint.server", "Desired configuration for Yui, Roles, Agents and Profiles. Saving targets later launches; it is not proof that existing Sessions adopted it.")}
        <label class="field settings-search"><span data-i18n="settings.search">Find a setting</span><input id="settings-search" type="search" autocomplete="off"></label>
        <p id="settings-status" role="status"></p>
        <div id="settings-groups" class="settings-stack"></div>
      </section>
      <section class="manage-section" data-section="permissions" aria-labelledby="settings-permissions-title" hidden>
        ${manageHead("settings-permissions-title", "settings.section.permissions", "Command permissions", "permissions.intro", "Read-only discovery templates, not authorization for a specific call. No rules or Grants are changed.")}
        <section id="permission-browser" class="settings-stack"></section>
      </section>`;
