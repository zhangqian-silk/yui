import { lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "../sqlite/driver.js";
import { maintenanceCallerEnvironment } from "../storage/maintenanceCaller.js";
import { inspectHomeRepair, repairHomeRecord, type HomeRepairRequest } from "../storage/homeRepair.js";
import { CURRENT_DATABASE_FILENAME } from "../storage/storageSchema.js";
import { acquireHandoverLock } from "../release/runtimeRelease.js";
import { acquireHomeLifecycleLock } from "../core/controllerServer.js";
import { CONTROLLER_DISCOVERY_PATH } from "../core/protocol.js";
import { findLiveControllerProcessForHome } from "../core/controllerProcessIdentity.js";
import { readHomeFilesystemId } from "../core/homeFilesystemIdentity.js";

export async function runRepairCommand(args: readonly string[], home: string, environment: NodeJS.ProcessEnv) {
  maintenanceCallerEnvironment(home, environment);
  const [kind, ...rest] = args;
  const options = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === "--apply" && !apply) { apply = true; continue; }
    if (!["--patch", "--from-backup", "--expect"].includes(key) || options.has(key)
      || !rest[i + 1] || rest[i + 1]!.startsWith("--")) throw new Error("Invalid repair options.");
    options.set(key, rest[++i]!);
  }
  if (kind === "inspect") {
    if (rest.length) throw new Error("Repair inspect accepts no options.");
  } else if (kind !== "config" && kind !== "identity") throw new Error("Repair expects inspect, config or identity.");
  if (apply !== options.has("--expect") || (options.has("--expect") && !/^[a-f0-9]{64}$/.test(options.get("--expect")!))) {
    throw new Error("Repair apply requires --apply --expect <preview-digest>.");
  }
  let request: HomeRepairRequest | undefined;
  if (kind === "config") {
    if (!options.has("--patch") || options.has("--from-backup")) throw new Error("Config repair requires --patch <JSON-file>.");
    const path = options.get("--patch")!;
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > 65536) throw new Error("Repair patch must be a regular file no larger than 64 KiB.");
    let patch: unknown;
    try { patch = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Repair patch is not readable valid JSON."); }
    request = { kind, patch };
  } else if (kind === "identity") {
    if (!options.has("--from-backup") || options.has("--patch")) throw new Error("Identity repair requires --from-backup <database>.");
    request = { kind, backup: options.get("--from-backup")! };
  }
  // Open an existing database only; never bootstrap singleton rows or a Home.
  const db = new Database(join(home, CURRENT_DATABASE_FILENAME), { readonly: !apply, fileMustExist: true });
  let releaseHandover: (() => void) | undefined;
  let releaseLifecycle: (() => Promise<void>) | undefined;
  try {
    db.pragma("busy_timeout = 5000");
    if (apply) {
      db.pragma("synchronous = FULL");
      releaseHandover = acquireHandoverLock(home).release;
      releaseLifecycle = await acquireHomeLifecycleLock(home);
      // Even stale/unreadable discovery is a blocker, not proof of quiescence.
      let discoveryPresent = true;
      try { lstatSync(join(home, CONTROLLER_DISCOVERY_PATH)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        discoveryPresent = false;
      }
      if (discoveryPresent || findLiveControllerProcessForHome(readHomeFilesystemId(home))) {
        throw new Error("Controller presence is known or unresolved; stop/reconcile it before offline repair.");
      }
    }
    const operation = () => {
      // Revalidate the actual caller under the same write fence; no Task Role bypass.
      maintenanceCallerEnvironment(home, environment);
      return request === undefined ? inspectHomeRepair(db)
        : repairHomeRecord(db, home, request, options.get("--expect"));
    };
    const data = apply ? db.transaction(operation).immediate() : db.transaction(operation)();
    return { data, output: JSON.stringify(data, null, 2) };
  } finally {
    try { db.close(); }
    finally {
      try { await releaseLifecycle?.(); } finally { releaseHandover?.(); }
    }
  }
}
