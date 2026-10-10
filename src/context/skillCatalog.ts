import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifySkillPackage, type SkillPackageRef } from "./skillPackage.js";
import { BUILTIN_YUI_SKILLS } from "./roleSessionContext.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const MAX_TEXT = 256 * 1024;
const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Read-only source discovery; browsing never snapshots, installs or executes a package. */
export function skillSource(home: string, id: string) {
  if (!SAFE_ID.test(id)) throw new Error("Invalid Skill id.");
  const builtin = BUILTIN_YUI_SKILLS.has(id);
  return { kind: builtin ? "builtin" as const : "configured" as const,
    path: builtin ? fileURLToPath(new URL(`../../skills/${id}`, import.meta.url)) : resolve(home, "skills", id) };
}

function physical(path: string) {
  if (realpathSync(path) !== resolve(path)) throw new Error("Skill paths must not contain symlinks.");
}

function textFile(path: string) {
  physical(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_TEXT) throw new Error("Only regular UTF-8 text files up to 256 KiB can be read.");
  const bytes = readFileSync(path);
  if (bytes.length > MAX_TEXT) throw new Error("Skill content exceeds 256 KiB.");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)) throw new Error("Binary Skill resources cannot be displayed.");
  return { content, byteSize: bytes.length, fileDigest: digest(bytes) };
}

export function listSkillSources(home: string, query = "", cursor = "0") {
  if (query.length > 256 || !/^\d{1,8}$/u.test(cursor)) throw new Error("Invalid Skill search or cursor.");
  let configured: string[] = [];
  try {
    const directory = resolve(home, "skills");
    physical(directory);
    configured = readdirSync(directory).filter(id => SAFE_ID.test(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Bounded discovery has an explicit limit, never silently presents a partial catalog.
  if (configured.length > 2048) throw new Error("Skill directory exceeds the 2048-entry browsing limit.");
  const needle = query.trim().toLowerCase();
  const items = [...new Set([...BUILTIN_YUI_SKILLS, ...configured])].sort().map(id => {
    const source = skillSource(home, id);
    try {
      const file = textFile(join(source.path, "SKILL.md"));
      const description = /^description:\s*(.+)$/mu.exec(file.content)?.[1]
        ?? file.content.split("\n").find(line => line.trim() && !line.startsWith("#")) ?? "";
      return { id, source, description: description.slice(0, 600), error: null };
    } catch (error) {
      return { id, source, description: "", error: error instanceof Error ? error.message : String(error) };
    }
  }).filter(item => !needle || `${item.id} ${item.description}`.toLowerCase().includes(needle));
  const offset = Number(cursor);
  return { items: items.slice(offset, offset + 30), total: items.length,
    nextCursor: offset + 30 < items.length ? String(offset + 30) : null };
}

export function readSkillSource(home: string, id: string, resource = "SKILL.md") {
  const source = skillSource(home, id);
  const files: string[] = [];
  let entries = 0;
  function walk(path: string, depth: number) {
    if (depth > 32) throw new Error("Skill resource depth exceeds 32.");
    physical(path);
    for (const name of readdirSync(path).sort()) {
      if (++entries > 4096) throw new Error("Skill exceeds the 4096-entry browsing limit.");
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Skill contains a symlink or special file.");
      if (stat.isDirectory()) walk(child, depth + 1);
      else files.push(relative(source.path, child).split(sep).join("/"));
      if (files.length > 2048) throw new Error("Skill contains more than 2048 resources.");
    }
  }
  walk(source.path, 0);
  if (!files.includes("SKILL.md")) throw new Error("Skill entrypoint SKILL.md is missing.");
  if (!files.includes(resource)) throw new Error("Resource is not in this Skill package.");
  return { id, source, version: "current-source", resource, files, ...textFile(join(source.path, resource)) };
}

/** The reference must come from a stored Session/Run, never from client paths. */
export function readFrozenSkill(ref: SkillPackageRef, resource?: string) {
  const manifest = verifySkillPackage(ref);
  const root = join(dirname(ref.manifestPath), "files");
  const entrypoint = relative(root, join(ref.path, "SKILL.md")).split(sep).join("/");
  const selected = resource ?? entrypoint;
  if (!manifest.files.some(file => file.path === selected)) throw new Error("Resource is not in this frozen Skill package.");
  return { id: ref.id, source: ref.source, version: ref.digest, resource: selected,
    files: manifest.files.map(file => file.path), ...textFile(join(root, selected)) };
}
