import { join } from "node:path";
import { lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import type { DurableJobStep } from "./durableJob.js";
import { jobPreviewSocketRoot } from "../storage/homeLayout.js";

/** An opt-in launch contract, not a second service registry. The Job remains
 * the sole owner of the process, cancellation and exit evidence. */
export function isHttpPreview(env: Readonly<Record<string, string>>): boolean {
  return env.YUI_HTTP_PREVIEW === "1";
}

export function validateHttpPreview(
  env: Readonly<Record<string, string>>, steps: readonly DurableJobStep[]
): void {
  if (env.YUI_HTTP_PREVIEW !== undefined && !isHttpPreview(env)) {
    throw new Error("YUI_HTTP_PREVIEW must be 1 when supplied.");
  }
  if (env.YUI_PREVIEW_SOCKET !== undefined || steps.some(step =>
    step.env?.YUI_PREVIEW_SOCKET !== undefined || step.env?.YUI_HTTP_PREVIEW !== undefined)) {
    throw new Error("Preview environment is Job-scoped; YUI_PREVIEW_SOCKET is assigned by the runner.");
  }
  if (isHttpPreview(env) && steps.length !== 1) {
    throw new Error("An HTTP preview Job must have exactly one foreground service step.");
  }
}

export function httpPreviewSocket(artifactDir: string): string {
  return join(jobPreviewSocketRoot(artifactDir), "http.sock");
}

export function assertHttpPreviewSocket(artifactDir: string): string {
  const dir = jobPreviewSocketRoot(artifactDir);
  return assertSocketAt(dir);
}

function assertSocketAt(dir: string): string {
  const parent = lstatSync(dir);
  const path = join(dir, "http.sock");
  const socket = lstatSync(path);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077)
    || !socket.isSocket() || socket.uid !== parent.uid) {
    throw new Error("Preview endpoint is not an owned Unix socket.");
  }
  return path;
}

/** Exclusive creation; never adopt or unlink another process's old endpoint.
 * Cleanup checks the exact directory inode and removes no unknown contents. */
export function prepareHttpPreview(artifactDir: string) {
  const dir = jobPreviewSocketRoot(artifactDir);
  mkdirSync(dir, { mode: 0o700 });
  const owner = lstatSync(dir);
  return {
    socket: join(dir, "http.sock"),
    cleanup() {
      const current = lstatSync(dir);
      if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) {
        throw new Error(`Preview owner changed; retained endpoint: ${dir}`);
      }
      try {
        const path = assertSocketAt(dir);
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      rmdirSync(dir);
    }
  };
}
