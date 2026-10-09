import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolveExecutable } from "../external/pinnedCommandRunner.js";

// The fetch isolation boundary needs --no-write-fetch-head. Older Git cannot
// implement it by saving/restoring FETCH_HEAD without racing another writer.
export const MINIMUM_GIT_VERSION = "2.29.0";

export function gitVersionSupport(output: string): Readonly<{
  version: string; supported: boolean; detail: string;
}> {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?(?:[.\s-].*)?$/u.exec(output.trim());
  const version = match === null ? "unknown" : `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
  const supported = match !== null && (Number(match[1]) > 2
    || (Number(match[1]) === 2 && Number(match[2]) >= 29));
  return {
    version, supported,
    detail: `Git ${version}; requires >= ${MINIMUM_GIT_VERSION} (isolated fetch without writing FETCH_HEAD). `
      + "Read-only version check; repository permissions, transport and server capabilities are not tested."
  };
}

let cached: { identity: string; path: string; version: string } | undefined;

/** Pin the executable checked, reusing only an unchanged on-disk identity. */
export function supportedGit(): Readonly<{ path: string; version: string }> {
  const selected = resolveExecutable("git", process.env.PATH);
  if (selected === undefined) throw new Error("Git executable not found in PATH; install a supported Git before retrying. No Git operation was started.");
  const path = realpathSync(selected);
  const stat = statSync(path);
  const identity = `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (cached?.identity === identity) return cached;
  const output = execFileSync(path, ["--version"], {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"]
  });
  const support = gitVersionSupport(output);
  if (!support.supported) {
    throw new Error(`${path}: ${support.detail} No Git operation was started by this call. `
      + "Select a supported Git in PATH, run doctor, then retry; existing resources are retained.");
  }
  cached = { identity, path, version: support.version };
  return cached;
}

/** Git paths are relative to the actual -C directory, not the Node process. */
export function gitOutputLine(output: string): string {
  if (!output.endsWith("\n") || output.length === 1 || output.includes("\0")) {
    throw new Error("Git returned an invalid path or line.");
  }
  // Remove exactly Git's record terminator, never spaces/tabs in a path.
  return output.slice(0, -1);
}

/** rev-parse --verify accepts exactly one validated operand on old Git.
 * Keep option-looking data out before removing the newer option terminator.
 */
export function compatibleGitArguments(args: readonly string[]): string[] {
  const marker = args.indexOf("--end-of-options");
  if (marker < 0) return [...args];
  const operand = args[marker + 1];
  if (!args.includes("rev-parse") || !args.includes("--verify")
    || marker !== args.length - 2 || operand === undefined
    || operand.length === 0 || operand.startsWith("-") || /[\0\r\n]/u.test(operand)) {
    throw new Error("Unsafe Git revision operand; no Git operation was started.");
  }
  return [...args.slice(0, marker), operand];
}
