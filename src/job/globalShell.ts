import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { requireKnownFields } from "../domain/validation.js";
import { validateJobExecutionConfiguration, type DurableJobStep } from "./durableJob.js";

export type JobScriptFile = Readonly<{ path: string; content: string }>;
export type GlobalShellConfiguration = Readonly<{
  kind: "shell";
  env: Readonly<Record<string, string>>;
  steps: readonly DurableJobStep[];
  files: readonly JobScriptFile[];
}>;

export function validateJobScriptFiles(files: readonly JobScriptFile[]): void {
  if (!Array.isArray(files) || files.length > 64) throw new Error("Job supports at most 64 script files.");
  const paths = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    requireKnownFields(file, ["path", "content"], "Job script file");
    if (typeof file.path !== "string" || file.path.length > 240
      || !/^[a-zA-Z0-9_-][a-zA-Z0-9._/-]*$/u.test(file.path)
      || file.path.split("/").some((part: string) => !part || part === "." || part === "..")) {
      throw new Error("Script paths must be safe relative paths, for example scripts/check.sh.");
    }
    if (paths.has(file.path) || [...paths].some(path => path.startsWith(file.path + "/") || file.path.startsWith(path + "/"))) {
      throw new Error("Script paths must be unique and cannot overlap directories.");
    }
    if (typeof file.content !== "string" || file.content.includes("\0")) throw new Error("Scripts must be UTF-8 text without NUL.");
    bytes += Buffer.byteLength(file.content);
    if (bytes > 512 * 1024) throw new Error("Job scripts exceed 512 KiB.");
    paths.add(file.path);
  }
}

export function prepareGlobalShell(configuration: GlobalShellConfiguration, workspace: string) {
  requireKnownFields(configuration, ["kind", "env", "steps", "files"], "Global Shell Job");
  if (configuration.kind !== "shell") throw new Error("Not a Shell Job.");
  validateJobScriptFiles(configuration.files);
  // No repository applies. This hash identifies executable configuration,
  // never a Project commit or an Integration candidate.
  const head = createHash("sha1").update(JSON.stringify(configuration)).digest("hex");
  const spec = { workspace, env: configuration.env, steps: configuration.steps, head };
  validateJobExecutionConfiguration(spec);
  return spec;
}

/** A fresh per-Run directory; never overwrite another run's files or follow
 * a pre-existing workspace. The runner's exclusive ready receipt fences replay. */
export function materializeJobScripts(workspace: string, files: readonly JobScriptFile[]): void {
  validateJobScriptFiles(files);
  mkdirSync(workspace, { mode: 0o700 });
  for (const file of files) {
    const path = join(workspace, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.content, { flag: "wx", mode: 0o700 });
  }
}
