// Task page sections, shared by the shell's shortcut list and the client.
// Overview: where it stands. Delivery: what it produced. Runtime: what is live
// now. Records: what happened. Retired section names stay addressable.
export const TASK_TABS = ["overview", "delivery", "runtime", "records"] as const;
export const TASK_TAB_ICONS: Readonly<Record<typeof TASK_TABS[number], string>> = {
  overview: "target", delivery: "package", runtime: "pulse", records: "history"
};
export const TASK_TAB_ALIASES = Object.freeze({ work: "delivery", execution: "runtime", history: "records", details: "records" });
