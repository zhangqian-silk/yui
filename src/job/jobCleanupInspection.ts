import { isAbsolute, join, resolve } from "node:path";
import { processGenerationIsLive } from "../core/fileLockOwner.js";
import { scanProcessPathRefs } from "../resources/liveReferences.js";
import type { DurableJob } from "./durableJob.js";

/** Result uncertainty and physical occupancy are different facts. Reuse the
 * recorded process generation and resource scanner, without rewriting the Job
 * or treating acknowledgement as stop evidence. Every cleanup reads this anew.
 */
export function jobCleanupBlocker(job: DurableJob, home?: string): string | undefined {
  if (job.status === "queued" || job.status === "running") return `DurableJob is ${job.status}.`;
  if (job.status !== "unknown-needs-attention") return undefined;
  if (job.acknowledgedAt === undefined) return "Unknown Job result requires explicit acknowledgement.";
  if (job.process === undefined || home === undefined) {
    return "Unknown Job has no exact process/Home evidence for physical inspection.";
  }
  try {
    if (processGenerationIsLive(job.process.pid, job.process.startIdentity)) {
      return "The exact Job runner process is still live.";
    }
    // Steps may outlive a killed runner. Their cwd, logs and isolated runtime
    // paths remain protective references; no process is signalled here.
    const paths = [job.workspace, join(resolve(home), "artifacts", "jobs", job.taskId, job.id),
      ...["TMPDIR", "XDG_DATA_HOME", "XDG_CACHE_HOME"].flatMap(key => {
        const path = job.env[key];
        return path !== undefined && isAbsolute(path) ? [path] : [];
      })];
    const scan = scanProcessPathRefs(paths);
    if (scan.diagnostics.some(diagnostic => diagnostic.severity === "error")
      || [...scan.refs.values()].some(refs => refs.length > 0)) {
      return "Job workspace/log/runtime references are still live or unverified.";
    }
  } catch (error) {
    return `Job physical inspection is unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}
