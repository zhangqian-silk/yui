/** `yui upgrade` plans or applies the supported linear storage migration chain. */
import {
  runStorageUpgrade,
  type UpgradeResult
} from "../storage/upgrade/upgradeOrchestrator.js";
import {
  ensureFileTaskController,
  ensureFileTaskControllerIdentity,
  type ControllerRuntimeProcessIdentity,
  stopFileTaskController
} from "../controller/clientRuntime.js";
import { callController, ControllerClientError } from "../core/controllerClient.js";
import { spawn } from "node:child_process";
import { runtimeError, usageError } from "../errors/cliError.js";
import {
  acquireHandoverLock,
  isForeignHandoverLockHeld,
  isHandoverLockHeld
} from "../release/runtimeRelease.js";

export type UpgradeCommandResult = Readonly<{
  output: string;
  data: UpgradeResult;
  exitCode: number;
}>;

/**
 * Run the upgrade command. Parses the public `[--dry-run]` form plus the staged
 * updater's internal `--update-preflight` form, then returns rendered text,
 * structured data, and an exit code (0 for a safe result, 5 for a blocker).
 */
export async function runUpgradeCommand(
  args: readonly string[],
  home: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<UpgradeCommandResult> {
  const mode = parseUpgradeArgs(args);
  const result = mode === "execute"
    ? await runInteractiveUpgrade(home, environment)
    : mode === "update-apply"
      ? await runUpdateOwnedUpgrade(home, environment)
      : await runStorageUpgrade({ home, mode });
  return {
    output: renderUpgradeResult(result, mode),
    data: result,
    exitCode: result.outcome === "blocked" || result.outcome === "failed" ? 5 : 0
  };
}

export type UpgradeCommandMode =
  | "dry-run"
  | "execute"
  | "update-preflight"
  | "update-apply";

function parseUpgradeArgs(args: readonly string[]): UpgradeCommandMode {
  if (args.length === 0) return "execute";
  if (args.length === 1 && args[0] === "--dry-run") return "dry-run";
  // Intentionally omitted from public command help: this is the machine contract
  // used by a staged `yui update`, not a replacement for user-facing dry-run.
  if (args.length === 1 && args[0] === "--update-preflight") return "update-preflight";
  if (args.length === 1 && args[0] === "--update-apply") return "update-apply";
  throw usageError("Upgrade usage: yui upgrade [--dry-run]");
}

async function runInteractiveUpgrade(
  home: string,
  environment: NodeJS.ProcessEnv
): Promise<UpgradeResult> {
  const preflight = await runStorageUpgrade({ home, mode: "update-preflight" });
  if (preflight.outcome !== "update-preflight"
    || preflight.status === "already-current") {
    return runStorageUpgrade({ home, mode: "execute" });
  }

  const handover = acquireHandoverLock(home);
  let controllerWasRunning = false;
  try {
    const previous = await captureUpgradeController(home);
    const stopped = await stopFileTaskController(home, {
      environment,
      handoverOwnerPid: process.pid,
      ...(previous === undefined ? {} : { expectedPid: previous.pid })
    });
    controllerWasRunning = stopped.stopped;
    const result = await runStorageUpgrade({ home, mode: "execute" });
    if (controllerWasRunning && result.outcome === "blocked") {
      if (previous === undefined) {
        throw runtimeError("Upgrade was blocked without changing storage; the stopped Controller identity is unknown. Keep the Home quiesced.");
      }
      await ensureFileTaskControllerIdentity(home, previous.identity, {
        environment, handoverOwnerPid: process.pid,
        spawnController: (_home, launchEnvironment) => {
          const child = spawn(previous.identity.executablePath, [...previous.identity.args], {
            env: launchEnvironment, detached: true, stdio: "ignore"
          });
          child.unref();
          return child.pid;
        }
      });
    }
    if (
      controllerWasRunning
      && (result.outcome === "upgraded" || result.outcome === "already-current")
    ) {
      try {
        await ensureFileTaskController(home, {
          environment,
          handoverOwnerPid: process.pid
        });
      } catch (error) {
        throw runtimeError(
          `Storage reached version ${result.report.targetVersion}, but the current `
            + `Controller could not restart: ${messageOf(error)} Backup: `
            + `${result.report.backupPath ?? "none"}. Keep the Home quiesced, inspect `
            + "Controller ownership, and start only the current Yui Controller."
        );
      }
    }
    return result;
  } finally {
    handover.release();
  }
}

async function captureUpgradeController(home: string): Promise<Readonly<{
  pid: number; identity: ControllerRuntimeProcessIdentity;
}> | undefined> {
  let value;
  try { value = await callController(home, "controller.identity", {}); }
  catch (error) {
    if (error instanceof ControllerClientError && error.code === "CONTROLLER_NOT_RUNNING") return undefined;
    throw error;
  }
  const identity = value as { pid?: number; executablePath?: string; args?: string[]; version?: string };
  if (!Number.isSafeInteger(identity.pid) || identity.pid! < 1
    || typeof identity.executablePath !== "string" || !identity.executablePath
    || !Array.isArray(identity.args) || identity.args.some(arg => typeof arg !== "string")
    || typeof identity.version !== "string" || !identity.version) {
    throw runtimeError("Cannot capture the exact Controller for a reversible upgrade preflight.");
  }
  return { pid: identity.pid!, identity: {
    executablePath: identity.executablePath, args: identity.args, version: identity.version
  } };
}

async function runUpdateOwnedUpgrade(
  home: string,
  environment: NodeJS.ProcessEnv
): Promise<UpgradeResult> {
  const ownerText = environment.YUI_UPDATE_HANDOVER_OWNER_PID;
  const ownerPid = ownerText === undefined ? Number.NaN : Number(ownerText);
  if (
    !Number.isSafeInteger(ownerPid)
    || ownerPid < 1
    || process.ppid !== ownerPid
    || !isHandoverLockHeld(home)
    || isForeignHandoverLockHeld(home, ownerPid)
  ) {
    throw runtimeError(
      "The internal update migration requires its direct parent to own the live "
        + "Controller handover lock."
    );
  }
  return runStorageUpgrade({ home, mode: "execute" });
}

/** Render an {@link UpgradeResult} as concise, CLI-style text. */
export function renderUpgradeResult(
  result: UpgradeResult,
  mode: UpgradeCommandMode
): string {
  const header = versionHeader(result);
  switch (result.outcome) {
    case "already-current":
      return `${header}\nStorage is already at the current version; nothing to upgrade.`;
    case "upgrade-plan":
      return [
        header,
        `Upgrade plan: ${renderSteps(result.report.steps)}. Storage was not modified.`
      ].join("\n");
    case "upgraded":
      return [
        header,
        `Storage upgraded through ${renderSteps(result.report.steps)}.`,
        `Backup: ${result.report.backupPath ?? "none"}`
      ].join("\n");
    case "update-preflight":
      return `${header}\nUpdate preflight: ${result.status} (${result.stepCount} steps). Storage was not modified.`;
    case "blocked": {
      return [
        header,
        `${mode === "dry-run"
          ? "Dry run"
          : mode === "update-preflight"
            ? "Update preflight"
            : "Upgrade"} blocked at ${result.stage}: ${result.message}`,
        `Action: ${result.action}`,
        "The authoritative Home is unchanged."
      ].join("\n");
    }
    case "failed":
      return [
        header,
        `Upgrade failed at ${result.stage}: ${result.message}`,
        `Action: ${result.action}`,
        `Backup: ${result.backupPath ?? "none"}`,
        result.sceneUnchanged
          ? "The authoritative Home was restored."
          : "The authoritative Home may have changed; keep it quiesced."
      ].join("\n");
  }
}

function versionHeader(result: UpgradeResult): string {
  const classification = result.classification;
  const storage = classification.storageVersion === undefined
    ? "unknown"
    : String(classification.storageVersion);
  const verdict = classification.classification.verdict;
  return `Storage: ${verdict} version=${storage}/${classification.currentStorageVersion} `
    + `minimum=${classification.minimumSupportedStorageVersion}`;
}

function renderSteps(
  steps: readonly Readonly<{ fromVersion: number; toVersion: number; name: string }>[]
): string {
  if (steps.length === 0) return "no migrations";
  return steps
    .map(({ fromVersion, toVersion, name }) => `${fromVersion}->${toVersion} ${name}`)
    .join(", ");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
