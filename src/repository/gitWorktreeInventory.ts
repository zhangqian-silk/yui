import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { gitOutputLine, supportedGit } from "./gitCompatibility.js";

const execute = promisify(execFile);
export type GitWorktreeRecord = Readonly<{
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  prunable: boolean;
  locked: boolean;
}>;

async function run(args: string[]): Promise<string> {
  return (await execute(supportedGit().path, args, {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024
  })).stdout;
}

export async function gitPath(cwd: string, args: string[]): Promise<string> {
  return resolve(cwd, gitOutputLine(await run(["-C", cwd, "rev-parse", ...args])));
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Old porcelain omits locks and does not delimit/quote arbitrary paths. Read
 * Git's worktree administrative records instead. These are observations only:
 * never write/prune them, and never infer ownership merely from a directory.
 * Mutating consumers still check the recorded owner and ask Git to remove it.
 */
export async function readGitWorktrees(cwd: string): Promise<GitWorktreeRecord[]> {
  const common = await realpath(await gitPath(cwd, ["--git-common-dir"]));
  const result: GitWorktreeRecord[] = [];
  // This is also Git's own main-worktree listing convention (including bare
  // and separate-git-dir repositories), not a claim of managed ownership.
  const main = basename(common) === ".git" ? dirname(common) : common;
  result.push(await inspect(common, main, false));
  const directory = join(common, "worktrees");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) throw new Error(`Uncertain Git worktree administration: ${join(directory, entry.name)}; retained.`);
    const admin = join(directory, entry.name);
    const pointer = gitOutputLine(await readFile(join(admin, "gitdir"), "utf8"));
    if (!isAbsolute(pointer) || basename(pointer) !== ".git") {
      throw new Error(`Invalid Git worktree back-pointer: ${admin}; retained.`);
    }
    const path = dirname(pointer);
    const adminCommon = await realpath(resolve(cwd, gitOutputLine(await run([
      "-C", cwd, `--git-dir=${admin}`, "rev-parse", "--git-common-dir"
    ]))));
    if (adminCommon !== common) throw new Error(`Git worktree common directory mismatch: ${admin}; retained.`);
    if (await exists(path)) {
      const actual = await realpath(await gitPath(path, ["--git-dir"]));
      if (actual !== admin) throw new Error(`Git worktree back-pointer mismatch: ${path}; retained.`);
    }
    result.push(await inspect(admin, path, true));
  }
  if (new Set(result.map(entry => entry.path)).size !== result.length) {
    throw new Error("Duplicate Git worktree registrations; retained.");
  }
  return result;
}

async function inspect(admin: string, path: string, linked: boolean): Promise<GitWorktreeRecord> {
  // Ask Git rather than parsing HEAD: Git owns ref storage (including newer
  // backends), symbolic resolution and per-worktree pseudorefs.
  let branch: string | undefined;
  try {
    branch = gitOutputLine(await run([`--git-dir=${admin}`, "symbolic-ref", "--quiet", "HEAD"]));
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  if (branch !== undefined && !branch.startsWith("refs/")) {
    throw new Error(`Invalid Git worktree HEAD: ${admin}; retained.`);
  }
  let head: string | undefined;
  try {
    head = gitOutputLine(await run([`--git-dir=${admin}`, "rev-parse", "--verify", "HEAD"]));
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(head)) throw new Error("Invalid Git HEAD");
  } catch (error) {
    // A genuinely unborn branch (main or linked) is valid discovery, not cleanup proof.
    if (branch === undefined) throw error;
    try {
      await run([`--git-dir=${admin}`, "show-ref", "--verify", "--quiet", branch]);
    } catch (missing) {
      if ((missing as { code?: unknown }).code === 1) {
        return {
          path, branch, detached: false, prunable: !await exists(path),
          locked: linked && await exists(join(admin, "locked"))
        };
      }
      throw missing;
    }
    throw error;
  }
  return {
    path, ...(head === undefined ? {} : { head }),
    ...(branch === undefined ? {} : { branch }),
    detached: branch === undefined, prunable: !await exists(path),
    locked: linked && await exists(join(admin, "locked"))
  };
}
