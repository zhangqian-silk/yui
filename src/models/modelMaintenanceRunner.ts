import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteTaskStore } from "../storage/sqliteStore.js";
import { authorizeGlobalJobStart } from "../controller/jobDefinitionControl.js";
import { writeTextFileAtomically } from "../storage/durableFile.js";
import { runReference, type JobBusinessResult } from "../job/jobBusinessResult.js";
import { applyConnectionConfig, planConnectionConfig, type ConnectionConfigInput } from "./connectionConfig.js";
import { modelDigest } from "./modelManagementFiles.js";
import { executeModelMaintenance, validateMaintenanceInput } from "./modelMaintenance.js";
import { modelObject } from "./modelManagementConfig.js";

export async function runModelMaintenance(home: string, runId: string, noteUncertainCommand: () => void = () => {}) {
  const store = new SqliteTaskStore(home, { readonly: true });
  try {
    const run = store.getGlobalJobRun(runId);
    if (!run || !["models.maintenance", "models.connection"].includes(run.action ?? "")) throw new Error("Exact admitted component Job required.");
    const guard = () => {
      const current = store.getGlobalJobRun(runId);
      if (!current || !((current.status === "queued" && current.operation.effect === "possible")
        || (current.status === "running" && current.operation.effect === "confirmed")) || current.cancelRequestedAt) throw new Error("Component Job is no longer active.");
      authorizeGlobalJobStart(store, current);
      if (run.action === "models.maintenance") {
        const input = validateMaintenanceInput(run.actionInput);
        const module = store.getConfig().modelManagement?.modules.find(m => m.id === input.moduleId);
        if (!module || modelDigest(module) !== input.moduleRevision) throw new Error("Module delegation changed before effect.");
      }
    };
    let result: Record<string, unknown>;
    let connectionStarted = false;
    try {
      guard();
      if (run.action === "models.maintenance") {
        result = await executeModelMaintenance(run.actionInput, join(home, run.artifactsLocator, "maintenance"), { beforeEffect: guard });
      } else {
        const input = modelObject(run.actionInput);
        const plan = planConnectionConfig(input.input as ConnectionConfigInput, {});
        if (modelDigest(plan) !== input.planDigest) throw new Error("Native configuration changed after preview; no write.");
        guard();
        connectionStarted = true;
        const applied = applyConnectionConfig(plan, { exclusive: true });
        result = { ...applied, status: ["saved", "unchanged"].includes(applied.status) ? "succeeded"
          : applied.status === "failed" ? "failed" : "unknown", configurationResult: applied.status,
          applied: "files-only", restarted: false, existingSessions: "unchanged", newSessions: "native-config-not-verified" };
      }
    } catch {
      result = { status: connectionStarted ? "unknown" : "failed", error: connectionStarted ? "connection-outcome-unknown" : "preflight-refused",
        notice: "Inspect current Job, module and native file revisions; nothing was automatically replayed." };
    }
    const business: JobBusinessResult = { schemaVersion: 1, sourceRun: runReference(run),
      outcome: result.status === "succeeded" ? "succeeded" : result.status === "unknown" ? "unknown-needs-attention" : "failed",
      summary: `${run.action}: ${result.status}. Runtime readiness and inference are not validated.`,
      data: JSON.parse(JSON.stringify(result)), evidence: [] };
    if (result.error === "command-outcome-unknown") noteUncertainCommand();
    // A lost receipt after effects must be reconciled as unknown by Job custody.
    writeTextFileAtomically(join(home, run.artifactsLocator, "business-result.json"), JSON.stringify(business) + "\n");
    process.stdout.write(JSON.stringify(result) + "\n");
    if (business.outcome !== "succeeded") process.exitCode = 1;
  } finally { store.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let uncertainCommand = false;
  runModelMaintenance(process.argv[2]!, process.argv[3]!, () => { uncertainCommand = true; }).catch(() => {
    process.stderr.write("Component Job receipt unconfirmed; inspect exact run before retry.\n"); process.exitCode = 1;
  }).finally(() => {
    // Only the direct executable owns this Job step group. Do this even when
    // persisting its unknown receipt failed; the supervisor keeps that evidence
    // gap unknown rather than leaving command descendants running.
    if (uncertainCommand) process.kill(-process.pid, "SIGKILL");
  });
}
