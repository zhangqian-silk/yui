import { createHash } from "node:crypto";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type SkillPackageRef = Readonly<{
  id: string;
  path: string;
  digest: string;
  source: Readonly<{ kind: "builtin" | "configured"; path: string }>;
  manifestPath: string;
  fileCount: number;
  byteSize: number;
}>;
type PackageFile = Readonly<{ path: string; digest: string; size: number; executable: boolean }>;
type PackageManifest = Readonly<{ schemaVersion: 1; files: readonly PackageFile[]; digest: string }>;
const MAX_FILES = 2048;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A package is data: no script, hook or executable is invoked while loading it.
 * Builtin Skills share one tree so their sibling-relative references stay valid. */
export function snapshotSkillPackage(input: {
  home: string; root: string; id: string; subdirectory?: string;
  kind: SkillPackageRef["source"]["kind"];
}): SkillPackageRef {
  const root = resolve(input.root);
  assertPhysical(root);
  const files: PackageFile[] = [];
  const contents = new Map<string, Buffer>();
  let byteSize = 0;
  function walk(directory: string, depth: number): void {
    if (depth > 32) throw new Error("Skill package directory depth exceeds 32.");
    for (const name of readdirSync(directory).sort()) {
      if (name.includes("\\") || /[\x00-\x1f\x7f]/u.test(name)) {
        throw new Error(`Invalid Skill resource name: ${JSON.stringify(name)}.`);
      }
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { walk(path, depth + 1); continue; }
      if (!stat.isFile()) throw new Error(`Skill package requires regular files, not symlinks or special files: ${path}.`);
      if (files.length >= MAX_FILES || stat.size > MAX_FILE_BYTES || byteSize + stat.size > MAX_BYTES) {
        throw new Error(`Skill package exceeds limits (${MAX_FILES} files, 8 MiB/file, 32 MiB total).`);
      }
      const bytes = readFileSync(path);
      if (bytes.length !== stat.size) throw new Error(`Skill resource changed while reading: ${path}.`);
      byteSize += bytes.length;
      const entry = { path: relative(root, path).split(sep).join("/"), digest: hash(bytes),
        size: bytes.length, executable: (stat.mode & 0o111) !== 0 };
      files.push(entry);
      contents.set(entry.path, bytes);
    }
  }
  walk(root, 0);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const subdirectory = input.subdirectory ?? "";
  const entrypoint = subdirectory ? `${subdirectory}/SKILL.md` : "SKILL.md";
  if (!contents.has(entrypoint)) throw new Error(`Configured Skill not found: ${input.id}.`);
  // Names, raw bytes and executable intent all participate; mtimes and source
  // locations do not. Identical bundles deduplicate across Roles and Sessions.
  const digest = hash(JSON.stringify(files));
  const parent = resolve(input.home, "runtime", "skill-packages");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPhysical(parent);
  const destination = join(parent, digest);
  const manifest: PackageManifest = { schemaVersion: 1, files, digest };
  if (!existsSync(destination)) {
    const staging = mkdtempSync(join(parent, ".staging-"));
    try {
      for (const file of files) {
        const path = join(staging, "files", file.path);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, contents.get(file.path)!, { flag: "wx", mode: file.executable ? 0o500 : 0o400 });
      }
      writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o400 });
      try { renameSync(staging, destination); }
      catch (error) {
        if (!existsSync(destination)) throw error;
        // Another producer can have won the same content-addressed destination.
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const ref: SkillPackageRef = {
    id: input.id, path: join(destination, "files", subdirectory), digest,
    source: { kind: input.kind, path: join(root, subdirectory) },
    manifestPath: join(destination, "manifest.json"), fileCount: files.length, byteSize
  };
  verifySkillPackage(ref);
  return ref;
}

export function validateSkillPackageRef(ref: SkillPackageRef): void {
  if (ref === null || typeof ref !== "object"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(ref.id)
    || !/^[a-f0-9]{64}$/u.test(ref.digest)
    || typeof ref.path !== "string" || !isAbsolute(ref.path)
    || typeof ref.manifestPath !== "string" || !isAbsolute(ref.manifestPath)
    || basename(dirname(ref.manifestPath)) !== ref.digest || basename(ref.manifestPath) !== "manifest.json"
    || !ref.source || !["builtin", "configured"].includes(ref.source.kind)
    || typeof ref.source.path !== "string" || !isAbsolute(ref.source.path)
    || !Number.isSafeInteger(ref.fileCount) || ref.fileCount < 1 || ref.fileCount > MAX_FILES
    || !Number.isSafeInteger(ref.byteSize) || ref.byteSize < 0 || ref.byteSize > MAX_BYTES) {
    throw new Error("Skill package reference is invalid.");
  }
}

/** Fail closed on lost/corrupt snapshots. Never refill them from mutable sources. */
export function verifySkillPackage(ref: SkillPackageRef): PackageManifest {
  validateSkillPackageRef(ref);
  const root = join(dirname(ref.manifestPath), "files");
  assertPhysical(dirname(ref.manifestPath));
  assertPhysical(ref.manifestPath);
  if (lstatSync(ref.manifestPath).size > 1024 * 1024) throw new Error("Skill package manifest exceeds limits.");
  const manifest = JSON.parse(readFileSync(ref.manifestPath, "utf8")) as PackageManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)
    || manifest.digest !== ref.digest || hash(JSON.stringify(manifest.files)) !== ref.digest
    || manifest.files.length !== ref.fileCount) throw new Error("Skill package manifest digest mismatch.");
  const entrypoint = relative(root, join(ref.path, "SKILL.md")).split(sep).join("/");
  let byteSize = 0;
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (typeof file.path !== "string" || !file.path || file.path.split("/").some((part: string) => part === ".." || part === "." || part === "")
      || file.path.includes("\\") || isAbsolute(file.path) || paths.has(file.path)) {
      throw new Error("Skill package resource path is invalid.");
    }
    paths.add(file.path);
    const path = join(root, file.path);
    assertPhysical(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== file.size || stat.size > MAX_FILE_BYTES
      || ((stat.mode & 0o111) !== 0) !== file.executable
      || hash(readFileSync(path)) !== file.digest) throw new Error(`Skill package resource changed: ${file.path}.`);
    byteSize += file.size;
  }
  if (!paths.has(entrypoint) || byteSize !== ref.byteSize) throw new Error("Skill package entrypoint or size mismatch.");
  let observed = 0;
  function checkInventory(directory: string, depth: number): void {
    if (depth > 32) throw new Error("Skill package directory depth exceeds 32.");
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) { checkInventory(path, depth + 1); continue; }
      if (!stat.isFile() || !paths.has(relative(root, path).split(sep).join("/"))) {
        throw new Error("Skill package contains an unrecorded resource.");
      }
      observed++;
    }
  }
  checkInventory(root, 0);
  if (observed !== paths.size) throw new Error("Skill package inventory changed.");
  return manifest;
}

function assertPhysical(path: string): void {
  if (realpathSync(path) !== resolve(path)) {
    throw new Error(`Skill package paths must not contain symlinks: ${path}.`);
  }
}
