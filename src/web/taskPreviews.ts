import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { assertHttpPreviewSocket, isHttpPreview, validateHttpPreview } from "../job/httpPreview.js";
import { requestDurableJobCancel, type DurableJob } from "../job/durableJob.js";
import type { TaskStore } from "../storage/taskStore.js";
import { webLocalMutation, WebRequestRejected } from "./webMutation.js";

type PreviewStore = Pick<TaskStore, "getTask" | "getDurableJob" | "listDurableJobs" | "transaction">;
const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 2000;

/** Only the authenticated Web composition root constructs this surface.
 * No URL/host/port/cwd is accepted from the browser. Tickets authorize one
 * live Job's GET/HEAD responses only and expire with this Web listener. */
export function createTaskPreviews(store: PreviewStore, home: string) {
  const secret = randomBytes(32);
  const key = (taskId: string, jobId: string) =>
    createHmac("sha256", secret).update(JSON.stringify([taskId, jobId])).digest("base64url");
  const prefix = (job: DurableJob) => `/preview/${encodeURIComponent(job.taskId)}/${encodeURIComponent(job.id)}/${key(job.taskId, job.id)}/`;
  const registered = (taskId: string, jobId: string) => {
    const job = store.getDurableJob(taskId, jobId);
    if (!store.getTask(taskId) || !job || job.taskId !== taskId || !isHttpPreview(job.env)) {
      throw new WebRequestRejected("Registered Task preview not found.");
    }
    validateHttpPreview(job.env, job.steps);
    return job;
  };
  const socket = (job: DurableJob) => {
    // Derive from exact owned IDs, not a caller path or the displayed locator.
    if (![job.taskId, job.id].every(id => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))) {
      throw new Error("Invalid preview owner.");
    }
    const dir = resolve(home, "artifacts", "jobs", job.taskId, job.id);
    return assertHttpPreviewSocket(dir);
  };
  const state = (job: DurableJob) => {
    if (job.status === "unknown-needs-attention") return "unknown";
    if (["cancelled", "succeeded"].includes(job.status)) return "stopped";
    if (["failed", "timed-out"].includes(job.status)) return "failed";
    if (job.cancelRequestedAt) return "stopping";
    const task = store.getTask(job.taskId);
    if (task?.status !== "active" || task.executionGate.state !== "enabled") return "unavailable";
    return job.status === "queued" ? "starting" : "running";
  };
  const read = async (job: DurableJob, path: string, method: string) => {
    if (state(registered(job.taskId, job.id)) !== "running") throw new Error("Service is no longer available.");
    const result = await readSocket(socket(job), path, method, prefix(job));
    if (state(registered(job.taskId, job.id)) !== "running") throw new Error("Service stopped during the request.");
    return result;
  };
  return {
    async list(taskId: string) {
      if (!store.getTask(taskId)) throw new WebRequestRejected("Task not found.");
      const jobs = store.listDurableJobs(taskId).filter(job => isHttpPreview(job.env)).reverse();
      const services = await Promise.all(jobs.slice(0, 16).map(async job => {
        let current = state(job);
        let detail = job.result?.unknownReason ?? `Job: ${job.status}`;
        let status: number | undefined;
        if (current === "running") {
          try {
            validateHttpPreview(job.env, job.steps);
            const result = await read(job, "/", "GET");
            status = result.status;
            current = status >= 200 && status < 400 ? "ready" : "failed";
            detail = `HTTP ${status} from the registered service.`;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            const age = Date.now() - Date.parse(job.startedAt ?? job.createdAt);
            current = (code === "ENOENT" || code === "ECONNREFUSED") && age < 30_000 ? "starting" : "failed";
            detail = error instanceof Error ? error.message : "Service unavailable.";
          }
        }
        const fresh = state(registered(taskId, job.id));
        if (!["running", "starting"].includes(fresh)) current = fresh;
        return {
          id: job.id, name: job.steps[0]?.name ?? job.id, owner: job.owner,
          state: current, detail, httpStatus: status, readAt: new Date().toISOString(),
          ...(current === "ready" ? { url: prefix(job) } : {}),
          canStop: job.status === "queued" || job.status === "running",
          receipt: job.result ? { outcome: job.result.outcome, terminalAt: job.terminalAt,
            evidenceSource: job.result.evidenceSource, artifactsLocator: job.artifactsLocator } : null
        };
      }));
      return { services, total: jobs.length, complete: jobs.length <= 16 };
    },
    stop(taskId: string, jobId: string) {
      // HTTP authenticates the local human before entering this transaction.
      // Reuse the same domain cancellation as CLI; never signal a browser PID.
      return webLocalMutation(store as TaskStore, tx => {
        const job = registered(taskId, jobId);
        const next = requestDurableJobCancel(job, new Date());
        if (next !== job) tx.saveDurableJob(taskId, next);
        return { jobId, status: next.status, cancelRequestedAt: next.cancelRequestedAt,
          stopped: ["cancelled", "succeeded", "failed", "timed-out"].includes(next.status) };
      });
    },
    async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const url = new URL(request.url ?? "/", "http://localhost");
      const match = /^\/preview\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/(.*)$/.exec(url.pathname);
      const fail = (status: number, detail: string) => {
        response.statusCode = status;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end(detail);
      };
      if (!match) { fail(403, "Invalid preview ticket."); return; }
      const [, taskId, jobId, ticket, path] = match;
      const expected = key(taskId!, jobId!);
      if (ticket!.length !== expected.length || !timingSafeEqual(Buffer.from(ticket!), Buffer.from(expected))) {
        fail(403, "Invalid preview ticket."); return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        fail(405, "Preview supports GET and HEAD only."); return;
      }
      let job: DurableJob;
      try {
        job = registered(taskId!, jobId!);
        if (state(job) !== "running") throw new Error("Service is not running; refresh Task preview status.");
      } catch (error) { fail(409, (error as Error).message); return; }
      try {
        const result = await read(job, "/" + path + url.search, request.method);
        const base = prefix(job);
        // No upstream CSP, cookies, auth, redirects, or CORS escape this boundary.
        const source = `http://${request.headers.host}${base}`;
        response.setHeader("content-security-policy", [
          "sandbox allow-scripts", "default-src 'none'",
          `script-src 'unsafe-inline' ${source}`, `style-src 'unsafe-inline' ${source}`,
          `img-src data: ${source}`, `font-src ${source}`, `connect-src ${source}`,
          `base-uri ${source}`, "form-action 'none'", "frame-ancestors 'self'"
        ].join("; "));
        response.removeHeader("x-frame-options");
        response.setHeader("access-control-allow-origin", "null");
        response.setHeader("cross-origin-resource-policy", "cross-origin");
        response.setHeader("content-type", result.contentType);
        if (result.location) {
          // Only relative redirects are supported. A redirect can never select
          // another upstream, even if it names localhost or this control plane.
          if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(result.location)) {
            fail(502, "External/absolute redirects are not supported in preview."); return;
          }
          const target = new URL(result.location, "http://preview.invalid/" + path + url.search);
          response.setHeader("location", base + target.pathname.slice(1) + target.search + target.hash);
        }
        response.statusCode = result.status;
        response.end(request.method === "HEAD" ? undefined : result.body);
      } catch (error) { fail(502, `Preview unavailable: ${(error as Error).message}`); }
    }
  };
}

function readSocket(socketPath: string, path: string, method: string, prefix: string): Promise<{
  status: number; contentType: string; location?: string; body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath, path, method, agent: false,
      headers: { host: "preview.local", "accept-encoding": "identity", "x-forwarded-prefix": prefix }
    });
    // Absolute deadline also bounds a slowly streaming response.
    const timer = setTimeout(() => request.destroy(new Error("Service did not respond within 2 seconds.")), TIMEOUT_MS);
    request.once("error", reject);
    request.once("close", () => clearTimeout(timer));
    request.once("response", response => {
      response.once("error", reject);
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
        response.resume();
        request.destroy(new Error("Service must honor Accept-Encoding: identity for preview."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > MAX_BYTES) request.destroy(new Error("Preview response exceeds 8 MiB."));
        else chunks.push(chunk);
      });
      response.once("end", () => resolve({
        status: response.statusCode ?? 502,
        contentType: response.headers["content-type"] ?? "application/octet-stream",
        ...(response.headers.location ? { location: response.headers.location } : {}),
        body: Buffer.concat(chunks)
      }));
    });
    request.end();
  });
}
