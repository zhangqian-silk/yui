import { compareStorageVersions, isStorageVersion } from "../storage/storageVersions.js";
import type { YuiVersionIdentity } from "../version.js";

/** Stable launch/contract identity. PID and instance nonce change on restoration. */
export type ControllerIdentity = Readonly<YuiVersionIdentity & {
  executablePath: string;
  args: readonly string[];
}>;

export function isControllerIdentity(value: unknown): value is ControllerIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.executablePath === "string" && record.executablePath.length > 0
    && Array.isArray(record.args) && record.args.every(arg => typeof arg === "string")
    && typeof record.version === "string" && record.version.length > 0
    && Number.isSafeInteger(record.controllerProtocolVersion) && (record.controllerProtocolVersion as number) > 0
    && isStorageVersion(record.storageVersion) && isStorageVersion(record.minimumStorageVersion)
    && compareStorageVersions(record.minimumStorageVersion, record.storageVersion) <= 0;
}

export function parseControllerIdentity(value: unknown): ControllerIdentity {
  if (!isControllerIdentity(value)) {
    throw new Error("Controller identity must include the exact executable, argv, package, protocol and storage versions.");
  }
  return {
    executablePath: value.executablePath,
    args: [...value.args],
    version: value.version,
    controllerProtocolVersion: value.controllerProtocolVersion,
    storageVersion: value.storageVersion,
    minimumStorageVersion: value.minimumStorageVersion
  };
}
