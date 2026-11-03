// Reproducible source snapshot, not a managed worktree or a global install.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { save, hash, treeHashes } from "./common.mjs";
const [sourceArg, ref, outArg] = process.argv.slice(2);
if (!sourceArg || !ref || !outArg) throw Error("Usage: prepare-product.mjs <git checkout> <commit> <NEW output>");
const source = resolve(sourceArg), output = resolve(outArg);
if (existsSync(output)) throw Error("Refusing to overwrite product snapshot");
const commit = execFileSync("git", ["-C", source, "rev-parse", `${ref}^{commit}`], { encoding: "utf8" }).trim();
mkdirSync(output);
const archive = join(output, "source.tar");
execFileSync("git", ["-C", source, "archive", "--format=tar", `--output=${archive}`, commit]);
execFileSync("tar", ["-xf", archive, "-C", output]);
unlinkSync(archive);
const sourceFiles = treeHashes(join(output, "src")), skills = treeHashes(join(output, "skills"));
save(join(output, ".eval-source.json"), { kind: "git-archive", commit, source,
  src: hash(JSON.stringify(sourceFiles)), skills: hash(JSON.stringify(skills)) });
// make install-local may run npm ci. Never expose the source dependency tree
// through a symlink: npm may empty its target before replacing the link.
// The new snapshot owns its dependency installation and native ABI.
const env = { PATH: `${resolve(process.execPath, "..")}:/usr/bin:/bin`, HOME: process.env.HOME };
execFileSync("make", ["install-local"], { cwd: output, env, stdio: "inherit" });
console.log(JSON.stringify({ product: output, commit, kind: "git-archive" }));
