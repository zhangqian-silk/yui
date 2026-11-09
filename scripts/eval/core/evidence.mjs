// Read-only historical evidence boundary. No runner, Home or Provider imports.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "./io.mjs";
export function safeMember(name) {
  if (typeof name !== "string" || isAbsolute(name) || name.includes("\\") || /[\0\r\n]/.test(name)
    || name.split("/").some(p => p === "..")) throw Error(`Unsafe evidence member ${JSON.stringify(name)}`);
  return name.replace(/^\.\/+/, "").replace(/\/+$/, "");
}
function inventory(root, path = "") {
  return readdirSync(join(root, path)).sort().flatMap(name => {
    const member = safeMember(path ? `${path}/${name}` : name), stat = lstatSync(join(root, member));
    if (stat.isSymbolicLink()) throw Error(`Unsafe symbolic evidence member ${member}`);
    return stat.isDirectory() ? inventory(root, member) : stat.isFile() ? [member] : [];
  });
}
export function openEvidence(source) {
  const absolute = resolve(source);
  let root = absolute, temporaryRoot, files;
  // Own cleanup before extraction. Reject links and escaping names BEFORE tar.
  // Nested owned-home archives remain opaque until one explicit member is read.
  const store = { source: absolute, released: false, close() {
    if (temporaryRoot && existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true });
    store.released = !temporaryRoot || !existsSync(temporaryRoot);
  } };
  try {
    if (!lstatSync(absolute).isDirectory()) {
      const args = ["--quoting-style=literal", "-tf", absolute];
      const names = execFileSync("tar", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\n").filter(Boolean);
      names.forEach(safeMember);
      const modes = execFileSync("tar", ["--quoting-style=literal", "-tvf", absolute],
        { encoding: "utf8", maxBuffer: 24 * 1024 * 1024 }).split("\n").filter(Boolean);
      if (modes.some(line => !["-", "d"].includes(line[0]))) throw Error("Unsafe link/special archive member");
      temporaryRoot = mkdtempSync(join(tmpdir(), "yui-history-read-"));
      store.temporaryRoot = temporaryRoot; root = temporaryRoot;
      execFileSync("tar", ["-xf", absolute, "-C", root, "--no-same-owner", "--no-same-permissions", "--keep-old-files"],
        { maxBuffer: 1024 * 1024 });
      store.archiveSha256 = hash(readFileSync(absolute));
    }
    files = inventory(root);
    const available = new Set(files);
    store.list = prefix => files.filter(name => !prefix || name.startsWith(`${safeMember(prefix)}/`));
    store.has = name => available.has(safeMember(name));
    store.bytes = name => {
      name = safeMember(name);
      if (!available.has(name)) throw Error(`Missing evidence member ${name}`);
      const path = resolve(root, name);
      if (isAbsolute(relative(root, path)) || relative(root, path).startsWith("..")) throw Error("Unsafe evidence path");
      return readFileSync(path);
    };
    store.json = name => JSON.parse(store.bytes(name));
    return store;
  } catch (error) { store.close(); throw error; }
}
