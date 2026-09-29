import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DAEMON_START_TIMEOUT_MS = 15_000;
const CODEX_APP_BUNDLE_ID = "com.openai.codex";

export type CodexProxyLaunch = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}>;

export type MacCodexAppPreparation = Readonly<{
  state: "not-macos" | "ready" | "restart-required";
  socketPath?: string;
}>;

/** A denied probe says nothing about whether the shared daemon is running. */
export function isCodexInspectionPermissionError(error: unknown): boolean {
  if (typeof error === "string") {
    return /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/iu.test(error);
  }
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; message?: unknown; stderr?: unknown; cause?: unknown };
    if (candidate.code === "EPERM" || candidate.code === "EACCES"
      || [candidate.message, candidate.stderr].some((value) => typeof value === "string"
        && /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/iu.test(value))) return true;
    current = candidate.cause;
  }
  return false;
}

/** Locate the installed App by bundle identity, including non-default installs. */
export function findMacCodexAppExecutable(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const home = environment.HOME || homedir();
  const candidates = [
    "/Applications/ChatGPT.app", "/Applications/Codex.app",
    join(home, "Applications/ChatGPT.app"), join(home, "Applications/Codex.app")
  ];
  for (const candidate of candidates) {
    const executable = executableForCodexApp(candidate);
    if (executable !== undefined) return executable;
  }
  try {
    const registered = execFileSync("/usr/bin/osascript", [
      "-e", `POSIX path of (path to application id "${CODEX_APP_BUNDLE_ID}")`
    ], { encoding: "utf8", timeout: 10_000 }).trim();
    return executableForCodexApp(registered);
  } catch {
    return undefined;
  }
}

function executableForCodexApp(bundlePath: string): string | undefined {
  const plist = join(bundlePath, "Contents/Info.plist");
  if (!existsSync(plist)) return undefined;
  try {
    const identifier = execFileSync("/usr/libexec/PlistBuddy", [
      "-c", "Print :CFBundleIdentifier", plist
    ], { encoding: "utf8", timeout: 2_000 }).trim();
    if (identifier !== CODEX_APP_BUNDLE_ID) return undefined;
    const name = execFileSync("/usr/libexec/PlistBuddy", [
      "-c", "Print :CFBundleExecutable", plist
    ], { encoding: "utf8", timeout: 2_000 }).trim();
    const executable = join(bundlePath, "Contents/MacOS", name);
    return existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

/** Prepare future App launches when an interactive Yui Codex Session starts. */
export async function prepareMacCodexAppConnection(
  launch: CodexProxyLaunch,
  appExecutable = findMacCodexAppExecutable(launch.environment),
  daemonStartedEarlier = false
): Promise<MacCodexAppPreparation> {
  if (process.platform !== "darwin") return { state: "not-macos" };
  if (launch.args.at(-2) !== "app-server" || launch.args.at(-1) !== "proxy") {
    throw new Error("Codex App sharing requires the configured app-server proxy connection.");
  }
  const socketPath = codexSharedSocketPath(launch.environment, launch.cwd);
  const started = await ensureCodexSharedDaemon(launch) || daemonStartedEarlier;
  if (appExecutable === undefined) return { state: "ready", socketPath };
  const wsUrl = codexAppWebSocketUrl(launch.environment, launch.cwd);
  try {
    await execFileAsync("/bin/launchctl", ["setenv", "CODEX_APP_SERVER_WS_URL", wsUrl], {
      cwd: launch.cwd, env: launch.environment, timeout: 5_000
    });
  } catch (error) {
    throw new Error(`Could not configure future Codex App launches: ${String(error)}`, { cause: error });
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,args="], {
      cwd: launch.cwd, env: launch.environment, timeout: 5_000, maxBuffer: 4 * 1024 * 1024
    }));
  } catch (error) {
    throw new Error(`Could not inspect running Codex App processes: ${String(error)}`, { cause: error });
  }
  const pids = codexAppProcessIds(stdout, appExecutable);
  for (const pid of pids) {
    let appCommand: string;
    try {
      const app = await execFileAsync("/bin/ps", ["eww", "-p", pid, "-o", "command="], {
        cwd: launch.cwd, env: launch.environment, timeout: 5_000, maxBuffer: 4 * 1024 * 1024
      });
      appCommand = String(app.stdout);
    } catch (error) {
      // The App can exit between listing processes and reading its environment.
      try {
        process.kill(Number(pid), 0);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") continue;
      }
      throw new Error(`Could not inspect Codex App pid=${pid}: ${String(error)}`, { cause: error });
    }
    if (codexAppNeedsRestart(appCommand, wsUrl, started)) {
      return { state: "restart-required", socketPath };
    }
  }
  return { state: "ready", socketPath };
}

export function codexAppProcessIds(processTable: string, appExecutable = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"): string[] {
  return processTable.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match !== null
      && (match[2] === appExecutable || match[2].startsWith(`${appExecutable} `))
      ? [match[1]] : [];
  });
}

export function codexAppWebSocketUrl(environment: NodeJS.ProcessEnv, cwd: string): string {
  return `ws+unix://localhost${codexSharedSocketPath(environment, cwd)}:/rpc`;
}

export function codexAppNeedsRestart(
  runningAppCommand: string,
  wsUrl: string,
  daemonStarted: boolean
): boolean {
  return daemonStarted || !runningAppCommand.split(/\s+/).includes(`CODEX_APP_SERVER_WS_URL=${wsUrl}`);
}

/** Only a failed connection to the default shared socket can start the local daemon. */
export async function startMissingCodexSharedDaemon(launch: CodexProxyLaunch): Promise<boolean> {
  if (launch.args.at(-2) !== "app-server" || launch.args.at(-1) !== "proxy") return false;
  const socketPath = codexSharedSocketPath(launch.environment, launch.cwd);
  if (!await socketIsMissing(socketPath)) return false;
  try {
    await execFileAsync(launch.command, [
      ...daemonBaseArgs(launch), "app-server", "daemon", "start"
    ], {
      cwd: launch.cwd,
      env: launch.environment,
      timeout: DAEMON_START_TIMEOUT_MS,
      maxBuffer: 32 * 1024
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Codex shared app-server is unavailable at ${socketPath}; daemon start failed: ${detail}`, {
      cause: error
    });
  }
  return true;
}

export async function ensureCodexSharedDaemon(launch: CodexProxyLaunch): Promise<boolean> {
  const started = await startMissingCodexSharedDaemon(launch);
  const socketPath = codexSharedSocketPath(launch.environment, launch.cwd);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!await socketIsMissing(socketPath)) return started;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Codex shared app-server did not open ${socketPath}.`);
}

export function codexSharedSocketPath(environment: NodeJS.ProcessEnv, cwd: string): string {
  const accountHome = environment.CODEX_HOME?.trim()
    || join(environment.HOME || homedir(), ".codex");
  const codexHome = isAbsolute(accountHome) ? accountHome : resolve(cwd, accountHome);
  return join(codexHome, "app-server-control", "app-server-control.sock");
}

function daemonBaseArgs(launch: CodexProxyLaunch): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(launch.environment.YUI_AGENT_BASE_ARGS ?? "");
  } catch {
    throw new Error("Codex daemon launch is missing the configured Agent base arguments.");
  }
  if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
    throw new Error("Codex daemon launch has invalid configured Agent base arguments.");
  }
  return parsed;
}

function socketIsMissing(path: string): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1_000, () => socket.destroy(new Error("Codex shared app-server socket probe timed out.")));
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolvePromise(true);
      else if (isCodexInspectionPermissionError(error)) {
        reject(new Error(
          `Cannot verify Codex shared app-server socket at ${path}: access denied; daemon state is unverified. ${error.message}`,
          { cause: error }
        ));
      } else reject(error);
    });
  });
}
