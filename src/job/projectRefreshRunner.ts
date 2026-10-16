/**
 * Controlled Project domain action invoked by the artifact-only Job runner.
 * Its catalog connection is read-only; only the shared domain service writes Git.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteTaskStore } from "../storage/sqliteStore.js";
import { authorizeGlobalJobStart } from "../controller/jobDefinitionControl.js";
import { refreshRegisteredProject } from "../repository/projectRefresh.js";
import { projectRefreshDigest } from "./builtinJob.js";
import { CliError } from "../errors/cliError.js";

export async function runProjectRefresh(home: string, runId: string): Promise<void> {
  const store = new SqliteTaskStore(home, { readonly: true });
  try {
    const run = store.getGlobalJobRun(runId);
    if (!run || run.action !== "project.refresh" || !["queued", "running"].includes(run.status)
      || run.operation.effect !== "possible" || run.cancelRequestedAt) {
      throw new Error("No active admitted project.refresh Run.");
    }
    authorizeGlobalJobStart(store, run);
    const result = await refreshRegisteredProject(store, run.projectId!, {
      automatic: true,
      expectedDigest: projectRefreshDigest({
        kind: "builtin", action: run.action, projectId: run.projectId, input: run.actionInput
      }),
      beforeRefresh: () => {
        const current = store.getGlobalJobRun(runId);
        if (!current || !["queued", "running"].includes(current.status) || current.cancelRequestedAt) {
          throw new Error("Project refresh Run stopped while waiting for maintenance.");
        }
        authorizeGlobalJobStart(store, current);
      }
    });
    process.stdout.write(JSON.stringify({ action: run.action, projectId: run.projectId,
      trigger: run.trigger, outcome: "succeeded", observedAt: new Date().toISOString(),
      remoteCheck: { status: "verified", commit: result.toCommit }, refresh: result }) + "\n");
  } finally {
    store.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProjectRefresh(process.argv[2]!, process.argv[3]!).catch(error => {
    process.stderr.write(JSON.stringify({ outcome: "failed", reason: error instanceof Error ? error.message : String(error),
      ...(error instanceof CliError ? { details: error.details } : {}) }) + "\n");
    process.exitCode = 1;
  });
}
