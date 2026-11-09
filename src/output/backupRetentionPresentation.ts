import type { BackupRetentionReport } from "../storage/upgrade/backupRetention.js";

/** Both upgrade and update expose the same post-migration cleanup outcome. */
export function renderBackupRetention(report?: BackupRetentionReport): string[] {
  if (report === undefined) return [];
  return [
    `Backup retention: keep=${report.keep}, retained=${report.retained ?? "unknown"}, deleted=${report.deleted.length}.`,
    ...report.deleted.map(path => `Deleted backup: ${path}`),
    ...report.protected.map(item => `Protected: ${item.path}: ${item.reason}`),
    ...report.warnings.map(item => `Cleanup warning (migration succeeded): ${item.path}: ${item.message}`)
  ];
}
