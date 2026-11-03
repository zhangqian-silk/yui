/** Public current-Context family names, shared by reads and CLI discovery.
 * Listing a family grants no permission to read its records.
 */
export const CONTEXT_FAMILIES: readonly string[] = Object.freeze([
  "task", "task-brief", "remote-delivery", "role", "role-profile",
  "project-policy", "project-knowledge", "input-request", "work-item",
  "accepted-work-item", "candidate", "environment-preparation", "managed-workspace",
  "change-set", "task-message", "run", "source-run", "review-round", "mailbox",
  "task-decision", "task-milestone", "job", "publication", "task-event"
]);
