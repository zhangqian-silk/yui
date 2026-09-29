import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const compilerFlags = process.platform === "linux"
  ? ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static"]
  : process.platform === "darwin"
    // macOS ships no static libc; the owner links only against libSystem.
    ? ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror"]
    : null;
if (compilerFlags === null) {
  throw new Error(`Yui's native process owner does not support ${process.platform}.`);
}
const targetPlatform = `${process.platform}-${process.arch}`;
if (!["linux-x64", "darwin-x64", "darwin-arm64"].includes(targetPlatform)) {
  throw new Error(`Unsupported native build target: ${targetPlatform}.`);
}
const output = fileURLToPath(new URL(`../dist/runtime/native/${targetPlatform}/`, import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const source = fileURLToPath(new URL("../src/", import.meta.url));
// tsc does not remove outputs of deleted/moved source files. Remove only those
// generated JS files after successful compilation, so local packages cannot
// silently retain a removed implementation. Native assets are untouched.
function removeOrphanJavaScript(directory) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) removeOrphanJavaScript(file);
    else if (entry.isFile() && entry.name.endsWith(".js")
      && !existsSync(join(source, relative(dist, file).replace(/\.js$/, ".ts")))) unlinkSync(file);
  }
}
removeOrphanJavaScript(dist);
mkdirSync(output, { recursive: true });
const target = output + "claude-process-owner";
execFileSync(process.env.CC ?? "cc", [
  ...compilerFlags,
  fileURLToPath(new URL("../native/claude-process-owner.c", import.meta.url)),
  "-o", target + ".building"
], { stdio: "inherit" });
renameSync(target + ".building", target);
if (process.platform === "darwin") {
  const identityTarget = output + "process-identity";
  execFileSync(process.env.CC ?? "cc", [
    ...compilerFlags,
    fileURLToPath(new URL("../native/process-identity.c", import.meta.url)),
    "-o", identityTarget + ".building"
  ], { stdio: "inherit" });
  renameSync(identityTarget + ".building", identityTarget);
}
