// The management navigation shared by the static rail (shell/manage) and the
// rail controller (client/layout/manageShell): every section, the page that
// owns its state and the area it belongs to. The model controller owns
// connection state belongs to the Models area.
// Jobs is its own top-level area (the rail's Jobs entry) served by the same
// document; its list is the Job index, not a set of section links.
export type ManagePage = "models" | "settings" | "jobs";
export type ManageArea = "models" | "settings" | "jobs";

export type ManageSection = Readonly<{ page: ManagePage; section: string; key: string; label: string }>;

export const MANAGE_SECTIONS: Readonly<Record<ManageArea, readonly ManageSection[]>> = Object.freeze({
  models: [
    { page: "models", section: "providers", key: "models.section.providers", label: "Model sources" },
    { page: "models", section: "connection", key: "models.section.connection", label: "Agent access" },
    { page: "models", section: "catalog", key: "models.section.catalog", label: "Models & quota" },
    { page: "models", section: "maintenance", key: "models.section.maintenance", label: "Component maintenance" }
  ],
  settings: [
    { page: "settings", section: "preferences", key: "settings.section.preferences", label: "Preferences" },
    { page: "settings", section: "skills", key: "settings.section.skills", label: "Skills" },
    { page: "settings", section: "permissions", key: "settings.section.permissions", label: "Command permissions" },
    { page: "settings", section: "server", key: "settings.section.server", label: "Agents & server" }
  ],
  jobs: [
    { page: "jobs", section: "jobs", key: "nav.jobs", label: "Jobs" }
  ]
});
