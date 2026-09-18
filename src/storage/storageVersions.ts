/** One Home format version, independent of package and record versions. */
export type StorageVersion = `${number}.${number}`;
export const CURRENT_STORAGE_VERSION: StorageVersion = "1.0";
export const MIN_SUPPORTED_STORAGE_VERSION: StorageVersion = "1.0";
export const STORAGE_FORMAT = "yui-home" as const;

export function isStorageVersion(value: unknown): value is StorageVersion {
  if (typeof value !== "string" || !/^[1-9]\d*\.(0|[1-9]\d*)$/u.test(value)) return false;
  return value.split(".").every(part => Number.isSafeInteger(Number(part)));
}

export function storageVersionParts(value: StorageVersion): Readonly<{ major: number; minor: number }> {
  if (!isStorageVersion(value)) throw new Error(`Invalid storage version: ${String(value)}.`);
  const [major, minor] = value.split(".").map(Number);
  return { major: major!, minor: minor! };
}

export function compareStorageVersions(left: StorageVersion, right: StorageVersion): number {
  const a = storageVersionParts(left), b = storageVersionParts(right);
  return Math.sign(a.major - b.major || a.minor - b.minor);
}

/** Cross-major conversion is never an ordinary update, even if explicitly pinned. */
export function isMinorStorageUpgrade(from: StorageVersion, to: StorageVersion): boolean {
  const a = storageVersionParts(from), b = storageVersionParts(to);
  return a.major === b.major && b.minor > a.minor;
}
