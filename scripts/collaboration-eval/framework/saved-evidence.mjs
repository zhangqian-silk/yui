// Read-only historical evidence boundary. No runner, Home or Provider imports.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { hash } from "./common.mjs";
export const ANALYSIS_VERSION = "history-quant/4";
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
export function readSavedInvocation(store, prefix = "") {
  prefix = safeMember(prefix);
  const member = path => prefix ? `${prefix}/${safeMember(path)}` : safeMember(path);
  const sealBytes = store.bytes(member("seal.json")), seal = JSON.parse(sealBytes);
  const files = store.list(prefix).map(path => prefix ? path.slice(prefix.length + 1) : path);
  const mismatches = Object.entries(seal).filter(([path, expected]) =>
    !store.has(member(path)) || hash(store.bytes(member(path))) !== expected.sha256).map(([path]) => path);
  const additions = files.filter(path => path !== "seal.json" && !Object.hasOwn(seal, path));
  if (mismatches.length || additions.length) throw Error(`Evidence seal mismatch: ${JSON.stringify({ mismatches, additions })}`);
  const preflightBytes = store.bytes(member("preflight.json")), preflight = JSON.parse(preflightBytes);
  const plan = store.json(member("plan.json"));
  if (plan.preflightIdentity !== hash(preflightBytes)) throw Error("Wrong preflight identity");
  const ledger = store.json(member("ledger.json"));
  const identity = hash(JSON.stringify({ seal: hash(sealBytes), preflight: hash(preflightBytes), plan: hash(store.bytes(member("plan.json"))) }));
  return { store, prefix, files, member, plan, preflight, ledger, seal, identity,
    versions: { run: plan.harnessIdentity ?? "unknown", analysis: ANALYSIS_VERSION },
    bytes: path => store.bytes(member(path)), json: path => store.json(member(path)) };
}
