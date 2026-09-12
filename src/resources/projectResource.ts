import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { requireIdentity, requireText, requireTimestamp } from "../domain/validation.js";

/** Concrete local directory identity. Git keeps its existing owner stores. */
export type LocalResource = Readonly<{
  schemaVersion: 1;
  id: string;
  kind: "local-directory";
  displayName: string;
  path: string;
  device: string;
  inode: string;
  ownership: "user";
  createdAt: string;
}>;

export type EnvironmentPreparation = Readonly<{
  schemaVersion: 1;
  id: string;
  taskId: string;
  disposition: "prepared" | "adopted" | "released";
  intentDigest: string;
  resourceRefs: readonly string[];
  access: "read" | "write";
  /** A directory grant is not a process, filesystem or network sandbox. */
  isolation: "none" | "trusted-local";
  environmentRef?: string;
  directory?: Readonly<{ path: string; device: string; inode: string; ownership: "preparation" | "user" }>;
  createdAt: string;
  updatedAt: string;
  releaseEvidence?: string;
}>;

/** Immutable physical environment selected for one native Session. */
export type ExecutionEnvironmentSnapshot = Readonly<{
  taskId: string;
  preparationId: string;
  environmentRef: string;
  access: "read" | "write";
  isolation: "trusted-local";
  directory: Readonly<{ path: string; device: string; inode: string; ownership: "preparation" | "user" }>;
}>;

export function validateExecutionEnvironmentSnapshot(value: ExecutionEnvironmentSnapshot): ExecutionEnvironmentSnapshot {
  if (!value || typeof value !== "object") throw new Error("Execution environment must be an object.");
  requireIdentity(value.taskId, "Execution environment Task");
  requireIdentity(value.preparationId, "Execution environment preparation");
  if (value.environmentRef !== `${value.taskId}/${value.preparationId}`) {
    throw new Error("Execution environment reference does not match its preparation.");
  }
  if (!["read", "write"].includes(value.access) || value.isolation !== "trusted-local" || !value.directory) {
    throw new Error("Execution environment requires a trusted-local directory and explicit access.");
  }
  requireText(value.directory.path, "Execution environment path");
  if (!isAbsolute(value.directory.path) || resolve(value.directory.path) !== value.directory.path) {
    throw new Error("Execution environment path must be absolute and normalized.");
  }
  requireText(value.directory.device, "Execution environment device");
  requireText(value.directory.inode, "Execution environment inode");
  if (!["preparation", "user"].includes(value.directory.ownership)) throw new Error("Invalid execution directory owner.");
  return value;
}

export function contentDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateLocalResource(resource: LocalResource): LocalResource {
  if (resource.schemaVersion !== 1 || resource.kind !== "local-directory" || resource.ownership !== "user") {
    throw new Error("Invalid local Resource record.");
  }
  requireIdentity(resource.id, "Resource id");
  requireText(resource.displayName, "Resource name");
  requireText(resource.path, "Resource path");
  requireText(resource.device, "Resource device");
  requireText(resource.inode, "Resource inode");
  requireTimestamp(resource.createdAt, "Resource timestamp");
  return resource;
}

export function validateEnvironmentPreparation(record: EnvironmentPreparation): EnvironmentPreparation {
  if (record.schemaVersion !== 1 || !["prepared", "adopted", "released"].includes(record.disposition)) {
    throw new Error("Invalid Environment preparation.");
  }
  requireIdentity(record.id, "Preparation id");
  requireIdentity(record.taskId, "Preparation Task");
  requireText(record.intentDigest, "Preparation intent");
  if (!Array.isArray(record.resourceRefs) || new Set(record.resourceRefs).size !== record.resourceRefs.length) {
    throw new Error("Preparation resources must be unique.");
  }
  record.resourceRefs.forEach((id) => requireIdentity(id, "Preparation resource"));
  if (!["read", "write"].includes(record.access)) throw new Error("Invalid preparation access.");
  if (!["none", "trusted-local"].includes(record.isolation)
    || (record.directory === undefined) !== (record.isolation === "none")) {
    throw new Error("Environment isolation must describe the actual local preparation.");
  }
  if ((record.directory === undefined) !== (record.environmentRef === undefined)) {
    throw new Error("Environment reference requires an actual directory.");
  }
  if (record.directory) {
    requireText(record.directory.path, "Environment path");
    requireText(record.directory.device, "Environment device");
    requireText(record.directory.inode, "Environment inode");
    if (!["preparation", "user"].includes(record.directory.ownership)) throw new Error("Invalid directory owner.");
  }
  requireTimestamp(record.createdAt, "Preparation timestamp");
  requireTimestamp(record.updatedAt, "Preparation update");
  if (record.releaseEvidence !== undefined) {
    if (record.disposition !== "released") throw new Error("Release evidence requires a released preparation.");
    requireText(record.releaseEvidence, "Release evidence");
  }
  return record;
}
