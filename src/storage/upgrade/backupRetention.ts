import {
  closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, unlinkSync, writeFileSync, type Stats
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveMigrationBackupKeep } from "../../config/yuiConfig.js";
import { isForeignHandoverLockHeld, isHandoverLockHeld } from "../../release/runtimeRelease.js";
import { scanProcessPathRefs } from "../../resources/liveReferences.js";

const RECEIPT = ".retention.json";
const NAME = /^pre-storage-v[1-9]\d*\.(?:0|[1-9]\d*)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.db$/u;
type FileIdentity = Readonly<{
  dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number;
}>;
type SuccessReceipt = Readonly<{
  schemaVersion: 1; home: string; homeId: string; name: string;
  createdAt: string; outcome: "validated"; file: FileIdentity;
}>;

export type BackupRetentionReport = {
  keep: number;
  /** Absent when the backup inventory could not be read. */
  retained?: number;
  deleted: string[];
  protected: { path: string; reason: string }[];
  warnings: { path: string; message: string }[];
};

export function isBackupRetentionReport(value: unknown): value is BackupRetentionReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as BackupRetentionReport;
  return Number.isSafeInteger(report.keep) && report.keep >= 1 && report.keep <= 1000
    && (report.retained === undefined || (Number.isSafeInteger(report.retained) && report.retained >= 0))
    && Array.isArray(report.deleted) && report.deleted.every(path => typeof path === "string")
    && Array.isArray(report.protected) && report.protected.every(item =>
      item !== null && typeof item === "object" && typeof item.path === "string" && typeof item.reason === "string")
    && Array.isArray(report.warnings) && report.warnings.every(item =>
      item !== null && typeof item === "object" && typeof item.path === "string" && typeof item.message === "string");
}

/** Reject links, shared directories and paths outside this physical Home. */
export function checkedBackupRoot(home: string): string {
  const root = join(realpathSync(home), "backups");
  const stat = lstatSync(root);
  if (!stat.isDirectory() || realpathSync(root) !== root
    || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new Error("Backup root must be an owned, non-shared real directory inside this Home.");
  }
  return root;
}

export function captureBackupIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  assertRegular(stat);
  return identity(stat);
}

/** Only the caller that just completed validation may publish this receipt. */
export function recordSuccessfulBackup(
  home: string, homeId: string, path: string, original: FileIdentity
): void {
  const root = checkedBackupRoot(home);
  if (resolve(path) !== join(root, basename(path))) throw new Error("Backup is outside its Home.");
  const createdAt = backupTime(basename(path));
  if (createdAt === undefined || !sameIdentity(original, captureBackupIdentity(path))) {
    throw new Error("Backup changed before migration validation completed.");
  }
  const receipt: SuccessReceipt = {
    schemaVersion: 1, home: realpathSync(home), homeId, name: basename(path),
    createdAt, outcome: "validated", file: original
  };
  const fd = openSync(`${path}${RECEIPT}`, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(receipt)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const directory = openSync(root, "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/**
 * Synchronous, fenced tail of a successful migration, never a scheduler or
 * migration step. DB-first deletion leaves an inert orphan receipt on crash.
 * Any WAL/SHM/journal means the whole set stays intact; we never unlink pieces
 * of an unsettled SQLite set. Unreceipted historical/failed backups stay put.
 */
export function retainMigrationBackups(input: Readonly<{
  home: string; homeId: string; keep: number; protectedPaths: readonly string[];
  maintenanceOwnerPid?: number;
  scanProcesses?: typeof scanProcessPathRefs;
}>): BackupRetentionReport {
  const assertFence = () => {
    const owner = input.maintenanceOwnerPid ?? process.pid;
    if ((owner !== process.pid && owner !== process.ppid)
      || !isHandoverLockHeld(input.home) || isForeignHandoverLockHeld(input.home, owner)) {
      throw new Error("Migration backup cleanup requires the live maintenance fence.");
    }
  };
  assertFence();
  const keep = resolveMigrationBackupKeep(input.keep);
  const root = checkedBackupRoot(input.home);
  const home = realpathSync(input.home);
  const report: BackupRetentionReport & { retained: number } = {
    keep, retained: 0, deleted: [], protected: [], warnings: []
  };
  const candidates: { path: string; receipt: SuccessReceipt; receiptFile: FileIdentity }[] = [];
  const protectedPaths = new Set(input.protectedPaths.map(path => resolve(path)));
  for (const name of readdirSync(root).sort()) {
    if (!name.startsWith("pre-storage-") || !name.endsWith(".db")) continue;
    const path = join(root, name);
    report.retained++;
    try {
      assertRegular(lstatSync(path));
      const createdAt = backupTime(name);
      if (createdAt === undefined) throw new Error("Unrecognized historical name; no ownership inferred.");
      if (protectedPaths.has(path)) {
        report.protected.push({ path, reason: "current migration/recovery reference" });
      }
      const receiptPath = `${path}${RECEIPT}`;
      if (!present(receiptPath)) throw new Error("No successful migration receipt; historical or recovery backup.");
      const receiptFile = captureBackupIdentity(receiptPath);
      if (receiptFile.size > 4096) throw new Error("Invalid migration receipt size.");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as SuccessReceipt;
      if (receipt.schemaVersion !== 1 || receipt.outcome !== "validated"
        || receipt.home !== home || receipt.homeId !== input.homeId
        || receipt.name !== name || receipt.createdAt !== createdAt
        || !sameIdentity(receipt.file, captureBackupIdentity(path))) {
        throw new Error("Migration receipt does not identify this unchanged backup in this Home.");
      }
      const reason = unsettledReason(path);
      if (reason !== undefined) {
        report.protected.push({ path, reason });
        protectedPaths.add(path);
      }
      candidates.push({ path, receipt, receiptFile });
    } catch (error) {
      report.protected.push({ path, reason: messageOf(error) });
    }
  }
  // Creation timestamps, not storage version or filesystem modification time.
  candidates.sort((a, b) => b.receipt.createdAt.localeCompare(a.receipt.createdAt)
    || a.path.localeCompare(b.path));
  const old = candidates.slice(keep);
  if (old.length === 0) return report;
  const scan = (input.scanProcesses ?? scanProcessPathRefs)(
    old.map(item => item.path), { strictSameUser: true }
  );
  const scanErrors = scan.diagnostics.filter(item => item.severity === "error");
  if (scanErrors.length > 0) {
    report.warnings.push({ path: root, message: "Process inventory incomplete; no old backups deleted. "
      + scanErrors.slice(0, 3).map(item => item.message).join("; ")
      + (scanErrors.length > 3 ? ` (${scanErrors.length} errors total)` : "") });
  }
  for (const candidate of old) {
    const { path, receipt, receiptFile } = candidate;
    if (protectedPaths.has(path)) continue;
    const refs = scan.refs.get(path) ?? [];
    if (refs.length > 0 || scanErrors.length > 0) {
      report.protected.push({ path, reason: refs.length > 0
        ? `open file: ${refs.join(", ")}` : "unverified process inventory" });
      continue;
    }
    try {
      assertFence();
      if (checkedBackupRoot(home) !== root
        || !sameIdentity(receipt.file, captureBackupIdentity(path))
        || !sameIdentity(receiptFile, captureBackupIdentity(`${path}${RECEIPT}`))) {
        throw new Error("Backup identity changed during cleanup.");
      }
      const reason = unsettledReason(path);
      if (reason !== undefined) throw new Error(reason);
      unlinkSync(path);
      report.deleted.push(path);
      report.retained--;
      unlinkSync(`${path}${RECEIPT}`);
    } catch (error) {
      report.warnings.push({ path, message: messageOf(error) });
    }
  }
  return report;
}

function unsettledReason(path: string): string | undefined {
  if (present(`${path}.pin`)) return "explicit recovery pin";
  if (["-wal", "-shm", "-journal"].some(suffix => present(`${path}${suffix}`))) {
    return "SQLite sidecar present; entire backup set protected";
  }
  return undefined;
}

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertRegular(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
    || (stat.mode & 0o022) !== 0) {
    throw new Error("Not an owned, private regular file with one link.");
  }
}

function identity(stat: Stats): FileIdentity {
  const { dev, ino, size, mtimeMs, ctimeMs } = stat;
  return { dev, ino, size, mtimeMs, ctimeMs };
}

function sameIdentity(a: FileIdentity | undefined, b: FileIdentity): boolean {
  return a !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function backupTime(name: string): string | undefined {
  const match = NAME.exec(name);
  if (!match) return undefined;
  const text = match[1]!;
  const iso = text.slice(0, 13) + ":" + text.slice(14, 16) + ":" + text.slice(17);
  const milliseconds = Date.parse(iso);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === iso ? iso : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
