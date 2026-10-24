import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { modelFields, modelObject } from "./modelManagementConfig.js";
import { modelDigest, privateModelFile } from "./modelManagementFiles.js";

export type MaintenanceCommand = { argv: string[]; timeoutMs: number };
export type MaintenanceSpec = {
  repository: string; ref: string; directory: string;
  build: MaintenanceCommand[]; verify: MaintenanceCommand[];
  configFiles: string[]; migration: "none" | "manual";
  service: null | { manager: "systemd-user"; unit: string; fragmentPath: string; fragmentRevision: string };
};
export const maintenanceOperations = ["check-update", "update", "rollback", "start", "stop", "restart", "status", "logs", "handoff"] as const;
export type MaintenanceInput = {
  moduleId: string; moduleRevision: string; spec: MaintenanceSpec;
  operation: typeof maintenanceOperations[number]; commit?: string;
  exclusiveWriter?: true; impactAcknowledged?: true;
};
const hex = (v: unknown, size: number) => typeof v === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(v);
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const path = (v: unknown): v is string => typeof v === "string" && isAbsolute(v) && resolve(v) === v && !/[\0\r\n]/.test(v) && v !== "/";
export function validateMaintenanceInput(value: unknown): MaintenanceInput {
  const input = modelObject(value);
  modelFields(input, ["moduleId", "moduleRevision", "spec", "operation", "commit", "exclusiveWriter", "impactAcknowledged"]);
  requireValue(typeof input.moduleId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(input.moduleId)
    && hex(input.moduleRevision, 64) && maintenanceOperations.includes(input.operation as MaintenanceInput["operation"]), "Invalid maintenance identity or operation.");
  const s = modelObject(input.spec);
  modelFields(s, ["repository", "ref", "directory", "build", "verify", "configFiles", "migration", "service"]);
  // Explicit repositories only; no command-line options, credentials in URLs,
  // remote helpers, ext transport, relative paths or inferred running checkout.
  requireValue(typeof s.repository === "string" && s.repository.length <= 4096
    && (path(s.repository) || /^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/[a-zA-Z0-9._/-]+$/.test(s.repository)
      || /^ssh:\/\/git@[a-zA-Z0-9.-]+\/[a-zA-Z0-9._/-]+$/.test(s.repository)), "Explicit local/HTTPS/SSH repository required.");
  requireValue(typeof s.ref === "string" && /^refs\/(heads|tags)\/[a-zA-Z0-9_][a-zA-Z0-9._/-]*$/.test(s.ref)
    && !s.ref.includes("..") && !s.ref.endsWith("/") && !s.ref.includes("//"), "Select an exact remote branch or tag ref.");
  requireValue(path(s.directory) && ["none", "manual"].includes(String(s.migration)), "Owned installation directory and migration declaration required.");
  for (const key of ["build", "verify"] as const) {
    requireValue(Array.isArray(s[key]) && s[key].length <= 8, "Bounded explicit build/verify commands required.");
    for (const c of s[key]) {
      const command = modelObject(c); modelFields(command, ["argv", "timeoutMs"]);
      requireValue(Array.isArray(command.argv) && command.argv.length > 0 && command.argv.length <= 64
        && command.argv.every(a => typeof a === "string" && a.length <= 8192 && !a.includes("\0"))
        && !!command.argv[0] && Number.isInteger(command.timeoutMs) && Number(command.timeoutMs) >= 1
        && Number(command.timeoutMs) <= 300_000, "Invalid authorized command.");
    }
  }
  requireValue(Array.isArray(s.configFiles) && s.configFiles.length <= 32 && s.configFiles.every(path)
    && new Set(s.configFiles).size === s.configFiles.length, "Exact native config/credential file inventory required.");
  if (s.service !== null) {
    const service = modelObject(s.service);
    modelFields(service, ["manager", "unit", "fragmentPath", "fragmentRevision"]);
    requireValue(service.manager === "systemd-user" && typeof service.unit === "string"
      && /^[a-zA-Z0-9_@.-]{1,128}\.service$/.test(service.unit) && !service.unit.startsWith("-")
      && path(service.fragmentPath) && hex(service.fragmentRevision, 64), "Explicit service manager/unit/fragment revision required.");
  }
  const operation = input.operation as string;
  if (["start", "stop", "restart", "status", "logs"].includes(operation)) requireValue(s.service !== null, "Explicit service delegation required.");
  if (operation === "update") requireValue(hex(input.commit, 40) && (s.verify as unknown[]).length > 0, "Update requires pinned commit and validation command.");
  else requireValue(input.commit === undefined, "Commit only applies to update.");
  if (["update", "rollback", "start", "stop", "restart", "handoff"].includes(operation)) {
    requireValue(input.exclusiveWriter === true && input.impactAcknowledged === true,
      "Explicit exclusive maintenance and affected-consumer impact acknowledgement required.");
  }
  return structuredClone(input) as MaintenanceInput;
}

type Command = (file: string, args: string[], cwd: string, timeoutMs: number, build?: boolean) => Promise<string>;
/** Child stays in the enclosing Job's process group. On timeout the runner
 * records unknown; its finalizer kills that owned group, including descendants. */
const command: Command = (file, args, cwd, timeoutMs, build = false) => new Promise((accept, reject) => {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C", GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file:https:ssh" };
  if (build) {
    env.HOME = join(cwd, ".build-home"); env.TMPDIR = join(cwd, ".build-tmp");
    mkdirSync(env.HOME, { recursive: true, mode: 0o700 }); mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
  } else {
    for (const key of ["HOME", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  // An inherited stdout pipe can outlive the direct child's timeout. Do not
  // wait for that pipe before handing unknown custody back to the Job runner.
  const deadline = setTimeout(() => reject(new Error("command-outcome-unknown")), timeoutMs + 250);
  execFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
    clearTimeout(deadline);
    if (error) reject(new Error(error.killed || error.signal ? "command-outcome-unknown" : "command-failed"));
    else accept(stdout);
  });
});
function ownedDirectory(directory: string) {
  const s = lstatSync(directory);
  requireValue(s.isDirectory() && realpathSync(directory) === directory && !(s.mode & 0o022)
    && (!process.getuid || s.uid === process.getuid()), "Installation directory must be owned, non-symlink and private to writers.");
}
function selected(directory: string, name: "current" | "previous"): string | null {
  let target: string;
  try {
    target = readlinkSync(join(directory, name));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  requireValue(/^release-[a-f0-9]{40}-[a-f0-9-]{36}$/.test(target), "Unrecognized installation link; do not adopt it.");
  // A dangling selected release is damaged state, not a fresh installation.
  ownedDirectory(join(directory, target));
  return target;
}
function select(directory: string, name: string, target: string) {
  const temporary = join(directory, `.select-${randomUUID()}`);
  symlinkSync(target, temporary); renameSync(temporary, join(directory, name));
}
type MaintenanceResult = Record<string, unknown> & { status: "succeeded" | "failed" | "unknown" };
export async function executeModelMaintenance(value: unknown, evidenceDirectory: string, ports: {
  command?: Command; fragmentDigest?: (file: string) => string; beforeEffect?: () => void;
} = {}): Promise<MaintenanceResult> {
  const input = validateMaintenanceInput(value), s = input.spec, op = input.operation;
  const run = ports.command ?? command;
  const before = ports.beforeEffect ?? (() => {});
  const cleanup = { lock: "not-acquired" };
  const common = { moduleId: input.moduleId, operation: op, source: s.repository, ref: s.ref,
    runtimeVersion: "unknown", readiness: "unverified", inference: "not-tested", observedAt: new Date().toISOString(), cleanup };
  let locked = false, uncertain = false;
  const effect: Record<string, unknown> = {};
  let stage = "preflight";
  function acquire() {
    ownedDirectory(s.directory);
    const lock = join(s.directory, ".maintenance-lock");
    mkdirSync(lock, { mode: 0o700 }); locked = true;
    cleanup.lock = "owned";
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ evidenceDirectory, input }), { flag: "wx", mode: 0o600 });
  }
  try {
    before();
    if (op === "check-update") {
      ownedDirectory(s.directory);
      const text = await run("git", ["ls-remote", "--exit-code", s.repository, s.ref, `${s.ref}^{}`], process.cwd(), 30_000);
      const rows = text.trim().split("\n").map(line => line.split(/\s+/));
      const commit = rows.find(([, ref]) => ref === `${s.ref}^{}`)?.[0] ?? rows.find(([, ref]) => ref === s.ref)?.[0];
      requireValue(hex(commit, 40), "Remote ref missing or ambiguous.");
      return { ...common, status: "succeeded", commit, remoteCheck: "verified", installedVersion: selected(s.directory, "current") };
    }
    if (op === "handoff") return { ...common, status: "succeeded", stopped: false, deleted: false,
      notice: "Native files, links, credentials and service are retained. Keep the no-effect handoff Job/history; remove unused module references separately after inspecting consumers." };
    if (["start", "stop", "restart", "status", "logs"].includes(op)) {
      const service = s.service!;
      const fragmentDigest = ports.fragmentDigest ?? ((file: string) => {
        ownedDirectory(dirname(file));
        const stat = lstatSync(file);
        requireValue(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o022), "Unsafe service fragment.");
        return modelDigest(privateModelFile(file));
      });
      requireValue(fragmentDigest(service.fragmentPath) === service.fragmentRevision, "Service fragment changed; inspect and delegate again.");
      const inspect = async () => {
        const raw = await run("systemctl", ["--user", "show", service.unit, "--property=Id,FragmentPath,DropInPaths,ActiveState,SubState,MainPID"], process.cwd(), 15_000);
        const facts = Object.fromEntries(raw.trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
        requireValue(facts.Id === service.unit && facts.FragmentPath === service.fragmentPath && !facts.DropInPaths,
          "Service identity changed or has unreviewed drop-ins; inspect the native unit first.");
        requireValue(["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance"].includes(facts.ActiveState!)
          && /^[a-z-]{1,64}$/.test(facts.SubState!) && /^\d+$/.test(facts.MainPID!), "Invalid service status.");
        return { serviceState: facts.ActiveState, processState: facts.SubState, mainPid: facts.MainPID };
      };
      const facts = await inspect();
      if (op === "status") return { ...common, status: "succeeded", ...facts };
      if (op === "logs") {
        const raw = await run("journalctl", ["--user", "-u", service.unit, "-n", "100", "--no-pager", "-o", "json"], process.cwd(), 15_000);
        // Journal MESSAGE is arbitrary application text and may contain bare
        // tokens. Return metadata only, never attempt a guessed key blacklist.
        const entries = raw.trim().split("\n").filter(Boolean).slice(-100).map(line => {
          try {
            const row = JSON.parse(line);
            return { timestamp: /^\d{1,20}$/.test(row.__REALTIME_TIMESTAMP) ? row.__REALTIME_TIMESTAMP : null,
              priority: /^[0-7]$/.test(row.PRIORITY) ? row.PRIORITY : null, message: "[redacted]" };
          } catch { return { message: "[redacted]" }; }
        });
        return { ...common, status: "succeeded", ...facts, entries, redaction: "metadata-only" };
      }
      before();
      acquire();
      if (op === "start" || op === "restart") {
        requireValue(s.verify.length > 0, "Explicit startup configuration, dependency and listener preflight required.");
        const active = selected(s.directory, "current");
        const cwd = active ? join(s.directory, active) : s.directory;
        stage = "startup-preflight";
        for (const c of s.verify) { before(); await run(c.argv[0]!, c.argv.slice(1), cwd, c.timeoutMs, true); }
      }
      before();
      requireValue(fragmentDigest(service.fragmentPath) === service.fragmentRevision, "Service fragment changed during preflight; no service action.");
      stage = "service-action";
      effect.serviceAction = op;
      await run("systemctl", ["--user", op, service.unit], process.cwd(), 30_000);
      effect.serviceActionConfirmed = true;
      return { ...common, status: "succeeded", ...await inspect(),
        notice: "Service manager action confirmed; loaded binary/config revision, readiness and inference remain unverified. Known bindings and unknown external consumers may be affected." };
    }
    acquire();
    const current = selected(s.directory, "current"), previous = selected(s.directory, "previous");
    effect.previous = current;
    effect.originalPrevious = previous;
    if (op === "rollback") {
      requireValue(previous && s.migration === "none", "No previous version, or manual config migration prevents automatic binary rollback.");
      before();
      effect.switchAttempted = true;
      select(s.directory, "current", previous);
      effect.selected = previous;
      if (current) select(s.directory, "previous", current);
      return { ...common, ...effect, status: "succeeded", configRestored: false, restarted: false };
    }
    requireValue(s.migration === "none", "Manual migration: prepare and validate configuration independently before a version switch.");
    mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
    stage = "configuration-backup";
    const backups = join(evidenceDirectory, "config-backup");
    mkdirSync(backups, { mode: 0o700 }); effect.backupDirectory = backups;
    const configs = s.configFiles.map((file, i) => {
      const stat = lstatSync(file);
      requireValue(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o022), "Unsafe native backup file.");
      const raw = privateModelFile(file);
      writeFileSync(join(backups, String(i)), raw, { flag: "wx", mode: 0o600 });
      return { path: file, revision: modelDigest(raw), mode: stat.mode & 0o777, backup: join(backups, String(i)) };
    });
    writeFileSync(join(backups, "inventory.json"), JSON.stringify(configs), { flag: "wx", mode: 0o600 });
    const release = `release-${input.commit}-${randomUUID()}`, checkout = join(s.directory, release);
    mkdirSync(checkout, { mode: 0o700 }); effect.retainedBuildDirectory = checkout;
    stage = "source-init";
    await run("git", ["init", "--quiet", checkout], s.directory, 15_000);
    before();
    stage = "source-fetch";
    await run("git", ["-C", checkout, "fetch", "--no-tags", "--no-write-fetch-head", s.repository, `${input.commit}:refs/yui/target`], s.directory, 60_000);
    const fetched = (await run("git", ["-C", checkout, "rev-parse", "refs/yui/target^{commit}"], s.directory, 5000)).trim();
    requireValue(fetched === input.commit, "Fetched commit differs from pinned update.");
    await run("git", ["-C", checkout, "checkout", "--detach", "--quiet", fetched], s.directory, 15_000);
    stage = "build-and-verify";
    for (const c of [...s.build, ...s.verify]) { before(); await run(c.argv[0]!, c.argv.slice(1), checkout, c.timeoutMs, true); }
    stage = "switch";
    requireValue(configs.every(c => modelDigest(privateModelFile(c.path)) === c.revision && (lstatSync(c.path).mode & 0o777) === c.mode), "Native configuration changed during build; no switch.");
    requireValue(selected(s.directory, "current") === current && selected(s.directory, "previous") === previous, "Installation changed during build; no switch.");
    before();
    effect.switchAttempted = true;
    if (current) select(s.directory, "previous", current);
    select(s.directory, "current", release); effect.selected = release;
    return { ...common, ...effect, status: "succeeded", commit: fetched, installedVersion: fetched, restarted: false,
      notice: "Build and validation passed; current link switched. No service restarted or configuration migrated. Prior version and private config inventory retained. Restore files only against current digests under exclusive ownership." };
  } catch (error) {
    uncertain = error instanceof Error && error.message === "command-outcome-unknown";
    // Once a service command was submitted, nonzero may include partial effects.
    const unknown = uncertain || !!effect.serviceAction || !!effect.switchAttempted;
    return { ...common, ...effect, status: unknown ? "unknown" : "failed",
      stage, error: uncertain ? "command-outcome-unknown" : "maintenance-not-confirmed",
      recovery: "Inspect exact Job evidence, links, service identity and native config. Do not retry unknown effects. Builds/backups are retained; configuration restore and service restart are separate authorized effects." };
  } finally {
    if (locked) {
      if (uncertain) cleanup.lock = "retained-unknown";
      else try {
        // Cleanup must never replace a confirmed effect with a failed receipt.
        const { unlinkSync } = await import("node:fs");
        unlinkSync(join(s.directory, ".maintenance-lock", "owner.json")); rmdirSync(join(s.directory, ".maintenance-lock"));
        cleanup.lock = "released";
      } catch { cleanup.lock = "retained-cleanup-failed"; }
    }
  }
}
