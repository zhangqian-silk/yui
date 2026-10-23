// The management navigation shared by the static rail (shell/manage) and the
// rail controller (client/layout/manageShell): every section, the page that
// owns its state and the area it belongs to. The model controller owns
// connection state, but its public route is /settings/connection.
// Jobs is its own top-level area (the rail's Jobs entry) served by the same
// document; its list is the Job index, not a set of section links.
export type ManagePage = "models" | "settings" | "jobs";
export type ManageArea = "models" | "settings" | "jobs";

export type ManageSection = Readonly<{ page: ManagePage; section: string; key: string; label: string }>;

export const MANAGE_SECTIONS: Readonly<Record<ManageArea, readonly ManageSection[]>> = Object.freeze({
  models: [
    { page: "models", section: "providers", key: "models.section.providers", label: "Access" },
    { page: "models", section: "catalog", key: "models.section.catalog", label: "Model catalog" },
    { page: "models", section: "quota", key: "models.section.quota", label: "Quota" }
  ],
  settings: [
    { page: "settings", section: "preferences", key: "settings.section.preferences", label: "Preferences" },
    { page: "settings", section: "skills", key: "settings.section.skills", label: "Skills" },
    { page: "settings", section: "permissions", key: "settings.section.permissions", label: "Command permissions" },
    { page: "settings", section: "server", key: "settings.section.server", label: "Agents & server" },
    { page: "models", section: "connection", key: "models.section.connection", label: "Model connection" }
  ],
  jobs: [
    { page: "jobs", section: "jobs", key: "nav.jobs", label: "Jobs" }
  ]
});
