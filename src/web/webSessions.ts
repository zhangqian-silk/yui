// CLI and Web share the same read-only native observation fold.
export { projectTaskSessions as projectWebSessions } from "../runtime/taskSessions.js";
export type { WebSession, WebSessionGroup } from "../runtime/taskSessions.js";
