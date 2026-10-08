import { isAbsolute, join, resolve } from "node:path";
import { processGenerationIsLive } from "../core/fileLockOwner.js";
import { scanProcessPathRefs } from "../resources/liveReferences.js";
import {
  inspectTaskRuntimeCleanupClaims, parseTaskRuntimeIsolationDescriptor,
  YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR
} from "../runtime/taskRuntimeIsolation.js";
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
    const serialized = job.env[YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR];
    if (serialized !== undefined) {
      const descriptor = parseTaskRuntimeIsolationDescriptor(serialized);
      const owner = descriptor.workspace.owner;
      if (descriptor.taskId !== job.taskId || descriptor.workspace.root !== job.workspace
        || owner.type !== job.owner.kind
        || (owner.type === "integration-attempt" && job.owner.kind === "integration-attempt"
          && owner.integrationAttemptId !== job.owner.integrationAttemptId)
        || (owner.type === "work-item" && job.owner.kind === "work-item"
          && owner.workItemId !== job.owner.workItemId)) {
        return "Job runtime descriptor does not match its exact owner/workspace.";
      }
      const claims = inspectTaskRuntimeCleanupClaims(descriptor);
      const uncertain = claims.find(claim => claim.ownership !== "owned" || claim.state !== "inactive");
      if (uncertain !== undefined) return `Job runtime cleanup claim is unverified: ${uncertain.id}.`;
      // cwd/fd references follow rename, unlike the recorded environment.
      // Use the same exact claim inventory as deletion, before archive commits.
      paths.push(descriptor.roots.runtime, ...claims.map(claim => claim.id));
    }
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
