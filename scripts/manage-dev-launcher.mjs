#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { basename, dirname, join, relative, resolve } from "node:path";

export const DEV_LAUNCHER_NAME = "yui";

const managedMarker = "# yui-local-dev: managed";
const controllerDiscoveryName = "controller.json";
const controllerProbeTimeoutMs = 500;
const controllerProtocolVersion = 1;
function validStorageVersion(value) {
  return typeof value === "string" && /^[1-9]\d*\.(0|[1-9]\d*)$/.test(value)
    && value.split(".").every(part=>Number.isSafeInteger(Number(part)));
}
function compareStorageVersion(left,right) {
  const [a,b]=left.split(".").map(Number),[c,d]=right.split(".").map(Number);
  return Math.sign(a-c || b-d);
}

export function installDevLauncher(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const binDir = join(outputDir, "bin");
  const launcherPath = join(binDir, DEV_LAUNCHER_NAME);
  const yuiHome = join(outputDir, "home");

  assertCanReplace(launcherPath);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(launcherPath, renderLauncher({ projectRoot, binDir, yuiHome }), { mode: 0o755 });
  chmodSync(launcherPath, 0o755);

  return { launcherPath, projectRoot, outputDir, binDir, yuiHome };
}

export async function resetDevHome(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const outputDir = resolve(options.outputDir ?? join(projectRoot, "output", "dev"));
  const homePath = join(outputDir, "home");
  if (!pathExists(homePath)) return { homePath, backupPath: null, moved: false };
  const releaseLifecycleLock = acquireHomeLifecycleLock(homePath);
  try {
    if (!pathExists(homePath)) return { homePath, backupPath: null, moved: false };
    const discoveryPath = join(homePath, "runtime", controllerDiscoveryName);
    if (pathExists(discoveryPath)) {
      const homeId = await readHomeIdForReset(homePath).catch((error) => {
        throw cannotVerifyController(discoveryPath, error);
      });
      const discovery = readControllerDiscoveryForReset(
        homePath,
        homeId,
        discoveryPath
      );
      const probe = await probeController(discovery);
      if (probe.status === "running") {
        if (probe.pid !== discovery.pid) {
          throw cannotVerifyController(discoveryPath);
        }
        throw new Error(
          `Refusing to reset a development home while Controller PID ${discovery.pid} is running. `
          + "Run yui controller stop first."
        );
      }
      if (probe.status !== "unreachable") {
        throw cannotVerifyController(discoveryPath);
      }
      let currentProcessStartIdentity;
      try {
        currentProcessStartIdentity = readLinuxProcessStartIdentity(discovery.pid);
      } catch (error) {
        throw cannotVerifyController(discoveryPath, error);
      }
      if (currentProcessStartIdentity === discovery.processStartIdentity) {
        throw cannotVerifyController(discoveryPath);
      }
    } else if (readdirSync(homePath).length > 0) {
      // A non-empty Home needs a readable authoritative identity before its
      // exact orphan endpoint can be ruled out. Unknown data is not an empty Home.
      const homeId = await readHomeIdForReset(homePath).catch((error) => {
        throw cannotVerifyController(discoveryPath, error);
      });
      if (pathExists(controllerSocketPath(homeId))) {
        throw cannotVerifyController(discoveryPath);
      }
    }

    const timestamp = (options.now ?? new Date()).toISOString().replaceAll(/[-:.]/g, "");
    let backupPath = join(outputDir, `home.backup-${timestamp}`);
    for (let suffix = 2; pathExists(backupPath); suffix += 1) {
      backupPath = join(outputDir, `home.backup-${timestamp}-${suffix}`);
    }
    renameSync(homePath, backupPath);
    return { homePath, backupPath, moved: true };
  } finally {
    releaseLifecycleLock();
  }
}

function assertCanReplace(path) {
  const existing = inspectManagedFile(path);
  if (existing !== null && !existing.managed) {
    throw new Error(`Refusing to overwrite a file not managed by this checkout: ${path}`);
  }
}

function inspectManagedFile(path) {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile()) return { managed: false };
    return { managed: readFileSync(path, "utf8").split("\n")[1] === managedMarker };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

function acquireHomeLifecycleLock(homePath) {
  const lockPath = homeLifecycleLockPath(homePath);
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const owner = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString()
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(owner)}\n`, {
        flag: "wx",
        mode: 0o600
      });
      return () => releaseHomeLifecycleLock(lockPath, token);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") {
        throw error;
      }
    }
    let existing;
    try {
      existing = readHomeLifecycleLockOwner(lockPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    const ownerDescription = `owner PID ${existing.pid}, createdAt ${existing.createdAt}`;
    if (isProcessAlive(existing.pid)) {
      throw new Error(
        `Another Yui home lifecycle operation is already running (${ownerDescription}): ${lockPath}`
      );
    }
    throw new Error(
      `A previous Yui home lifecycle operation left a stale lock `
        + `(${ownerDescription}): ${lockPath}. `
        + "If no Controller startup or development reset is running, "
        + "remove this exact lock file and retry."
    );
  }
  throw new Error(
    `Cannot safely acquire the Yui home lifecycle lock because its owner changed repeatedly: `
      + lockPath
  );
}

function homeLifecycleLockPath(homePath) {
  const resolvedHome = resolve(homePath);
  return join(dirname(resolvedHome), `.${basename(resolvedHome)}.controller-lifecycle.lock`);
}

function readHomeLifecycleLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (
      typeof owner !== "object" || owner === null
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.token !== "string" || owner.token.length === 0 || owner.token.length > 128
      || typeof owner.createdAt !== "string" || Number.isNaN(Date.parse(owner.createdAt))
    ) {
      throw new Error("invalid owner");
    }
    return owner;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") throw error;
    throw new Error(
      `Cannot verify the existing Yui home lifecycle lock: ${lockPath}. `
        + "If no Controller startup or development reset is running, remove this exact lock file and retry."
    );
  }
}

function releaseHomeLifecycleLock(lockPath, token) {
  let owner;
  try {
    owner = readHomeLifecycleLockOwner(lockPath);
  } catch {
    return;
  }
  if (owner.token === token && owner.pid === process.pid) rmSync(lockPath, { force: true });
}

function readControllerDiscoveryForReset(homePath, homeId, discoveryPath) {
  try {
    const metadata = lstatSync(discoveryPath);
    if (
      !metadata.isFile()
      || (metadata.mode & 0o077) !== 0
      || metadata.size > 4_096
    ) {
      throw new Error("invalid metadata");
    }
    const discovery = JSON.parse(readFileSync(discoveryPath, "utf8"));
    const expectedSocketPath = controllerSocketPath(homeId);
    const expectedHomeFilesystemId = readHomeFilesystemId(homePath);
    if (
      typeof discovery !== "object" || discovery === null
      || Reflect.ownKeys(discovery).length !== 9
      || discovery.schemaVersion !== 1
      || discovery.protocolVersion !== controllerProtocolVersion
      || discovery.homeId !== homeId
      || discovery.homeFilesystemId !== expectedHomeFilesystemId
      || typeof discovery.controllerInstanceId !== "string"
      || !/^[a-f0-9]{32}$/u.test(discovery.controllerInstanceId)
      || !Object.hasOwn(discovery, "pid")
      || !Object.hasOwn(discovery, "processStartIdentity")
      || !Object.hasOwn(discovery, "socketPath")
      || !Object.hasOwn(discovery, "token")
      || !Number.isSafeInteger(discovery.pid) || discovery.pid <= 0
      || typeof discovery.processStartIdentity !== "string"
      || !/^[0-9]{1,32}$/u.test(discovery.processStartIdentity)
      || discovery.socketPath !== expectedSocketPath
      || typeof discovery.token !== "string"
      || !/^[a-f0-9]{64}$/u.test(discovery.token)
    ) {
      throw new Error("invalid fields");
    }
    return discovery;
  } catch (error) {
    throw cannotVerifyController(discoveryPath, error);
  }
}

async function readHomeIdForReset(homePath) {
  const databasePath = join(homePath, "yui.db");
  let homeId;
  const { default: Database } = await import("better-sqlite3");
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(
      "SELECT home_identity FROM home_meta WHERE id = 1"
    ).get();
    homeId = JSON.parse(row?.home_identity ?? "null")?.homeId;
  } finally {
    database.close();
  }
  if (typeof homeId !== "string" || !/^home-[a-f0-9]{16}$/u.test(homeId)) {
    throw new Error("Development Home identity is invalid.");
  }
  return homeId;
}

function controllerSocketPath(homeId) {
  if (typeof homeId !== "string" || !/^home-[a-f0-9]{16}$/u.test(homeId)) {
    throw new Error("Development Home identity is invalid.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join("/tmp", `yui-${uid}`, `${homeId}.sock`);
}

function readHomeFilesystemId(homePath) {
  const metadata = statSync(homePath, { bigint: true });
  if (!metadata.isDirectory()) throw new Error("Development Home is not a directory.");
  return `${metadata.dev}:${metadata.ino}`;
}

function cannotVerifyController(discoveryPath, cause) {
  return new Error(`Cannot verify development Controller state: ${discoveryPath}`, {
    ...(cause === undefined ? {} : { cause })
  });
}

function readLinuxProcessStartIdentity(pid) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error(`Cannot verify process identity for Controller PID ${pid}.`, {
      cause: error
    });
  }
  const closingParenthesis = stat.lastIndexOf(")");
  const fieldsAfterCommand = closingParenthesis < 0
    ? []
    : stat.slice(closingParenthesis + 1).trim().split(/\s+/u);
  const processStartIdentity = fieldsAfterCommand[19];
  if (
    processStartIdentity === undefined
    || !/^[0-9]{1,32}$/u.test(processStartIdentity)
  ) {
    throw new Error(`Cannot verify process identity for Controller PID ${pid}.`);
  }
  return processStartIdentity;
}

function probeController(discovery) {
  return new Promise((resolveProbe) => {
    const requestId = `dev-reset-${randomUUID()}`;
    const request = `${JSON.stringify({
      id: requestId,
      token: discovery.token,
      protocolVersion: controllerProtocolVersion,
      homeId: discovery.homeId,
      homeFilesystemId: discovery.homeFilesystemId,
      controllerInstanceId: discovery.controllerInstanceId,
      method: "controller.status",
      params: {}
    })}\n`;
    const socket = createConnection(discovery.socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(result);
    };
    const timer = setTimeout(
      () => finish({ status: "unreachable" }),
      controllerProbeTimeoutMs
    );
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4_096) {
        finish({ status: "invalid" });
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (buffer.length !== newline + 1) {
        finish({ status: "invalid" });
        return;
      }
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        const result = response?.result;
        const resultKeys = typeof result === "object" && result !== null
          ? Reflect.ownKeys(result)
          : [];
        if (
          typeof response !== "object" || response === null
          || Reflect.ownKeys(response).length !== 3
          || response.id !== requestId
          || response.ok !== true
          || typeof result !== "object" || result === null
          || resultKeys.length < 11
          || resultKeys.length > 12
          || resultKeys.some((key) => ![
            "pid",
            "running",
            "uptimeMs",
            "rssBytes",
            "protocolVersion",
            "homeId",
            "homeFilesystemId",
            "controllerInstanceId",
            "version",
            "storageVersion",
            "minimumStorageVersion",
            "runtime"
          ].includes(key))
          || result.running !== true
          || result.protocolVersion !== controllerProtocolVersion
          || result.homeId !== discovery.homeId
          || result.homeFilesystemId !== discovery.homeFilesystemId
          || result.controllerInstanceId !== discovery.controllerInstanceId
          || !Number.isSafeInteger(result.pid) || result.pid <= 0
          || !validStorageVersion(result.storageVersion)
          || !validStorageVersion(result.minimumStorageVersion)
          || compareStorageVersion(result.minimumStorageVersion,result.storageVersion) > 0
          || (
            Object.hasOwn(result, "protocolVersion")
            && (!Number.isSafeInteger(result.protocolVersion) || result.protocolVersion <= 0)
          )
          || (
            Object.hasOwn(result, "version")
            && (typeof result.version !== "string" || result.version.length === 0)
          )
          || ["uptimeMs", "rssBytes"].some((key) => (
            Object.hasOwn(result, key)
            && (!Number.isSafeInteger(result[key]) || result[key] < 0)
          ))
          || (
            Object.hasOwn(result, "runtime")
            && (typeof result.runtime !== "object" || result.runtime === null
              || Array.isArray(result.runtime))
          )
        ) {
          finish({ status: "invalid" });
          return;
        }
        finish({ status: "running", pid: result.pid });
      } catch {
        finish({ status: "invalid" });
      }
    });
    socket.once("error", () => finish({ status: "unreachable" }));
    socket.once("end", () => finish({ status: "invalid" }));
  });
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function renderLauncher({ projectRoot, binDir, yuiHome }) {
  const projectFromBin = relative(binDir, projectRoot);
  const homeFromProject = relative(projectRoot, yuiHome);
  return `${renderHeader()}launcher_path=$0
while [ -L "$launcher_path" ]; do
  link_target=$(readlink "$launcher_path")
  case "$link_target" in
    /*) launcher_path=$link_target ;;
    *) launcher_path=$(dirname -- "$launcher_path")/$link_target ;;
  esac
done
script_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir"/${shellQuote(projectFromBin)} && pwd)
${renderEnvironment('"$project_root"', homeFromProject, '"$script_dir"')}exec node "$project_root/dist/cli.js" "$@"
`;
}

function renderHeader() {
  return `#!/usr/bin/env sh
${managedMarker}
`;
}

function renderEnvironment(rootExpression, homeFromRoot, binExpression) {
  return `if [ -z "\${YUI_HOME:-}" ]; then
  export YUI_HOME=${rootExpression}/${shellQuote(homeFromRoot)}
fi
case ":$PATH:" in
  *:${binExpression}:*) ;;
  *) export PATH=${binExpression}:"$PATH" ;;
esac
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function runCli() {
  const action = process.argv[2];
  if (action === "install-local") {
    const result = installDevLauncher();
    console.log(`Local yui launcher ready (global yui unchanged): ${result.launcherPath}`);
    console.log(`Isolated YUI_HOME default: ${result.yuiHome}`);
    return;
  }
  if (action === "reset-home") {
    const result = await resetDevHome();
    console.log(
      result.moved
        ? `Moved the previous development home to: ${result.backupPath}`
        : `Development home does not exist; nothing to reset: ${result.homePath}`
    );
    return;
  }
  throw new Error("Usage: node scripts/manage-dev-launcher.mjs install-local|reset-home");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli();
  } catch (error) {
    console.error(`YUI_DEV_LAUNCHER_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
