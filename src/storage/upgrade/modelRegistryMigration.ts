import type Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { modelFields, modelObject, modelUrl } from "../../models/modelManagementConfig.js";
import type { ModelConnection } from "../../models/modelManagementTypes.js";
import { emptyModelRegistry, validateModelRegistry } from "../../models/modelRegistry.js";

/** Historical reader, only admitted by the centralized 1.23 -> 1.24 step. */
function validateModelConnection(value: unknown): ModelConnection {
  const row = modelObject(value);
  const fields = ["bridgeUrl", "bridgeConfigFile", "cpaUrl", "managementKeyFile", "catalogKeyFile"] as const;
  modelFields(row, fields);
  for (const field of fields) {
    if (typeof row[field] !== "string" || (row[field] as string).length > 4096
      || /[\0\r\n]/.test(row[field] as string)) throw new Error("Invalid historical model connection.");
  }
  const result = row as ModelConnection;
  modelUrl(result.bridgeUrl);
  if (result.cpaUrl) modelUrl(result.cpaUrl);
  for (const field of ["bridgeConfigFile", "managementKeyFile", "catalogKeyFile"] as const) {
    if (result[field] && !isAbsolute(result[field])) throw new Error("Invalid historical model file reference.");
  }
  return result;
}

/** 1.23 stored one coupled connection. Convert references only, never read files,
 * contact a service, acquire maintenance ownership or create Agent bindings. */
export function migrateModelRegistry(db: Database.Database): void {
  const row = db.prepare("SELECT payload FROM config WHERE id=1").get() as { payload: string } | undefined;
  if (!row) return;
  const config = JSON.parse(row.payload);
  if (config.modelManagement === undefined) return;
  const old = validateModelConnection(config.modelManagement);
  const registry = emptyModelRegistry();
  registry.modules.push({ id: "bridge", kind: "metabridge", version: "unverified",
    managementUrl: old.bridgeUrl, managementKeyFile: "", configFile: old.bridgeConfigFile,
    maintenance: "external", quotaAdapter: "none" });
  registry.endpoints.push({ id: "bridge-responses", moduleId: "bridge", url: old.bridgeUrl.replace(/\/+$/, "") + "/v1",
    protocol: "responses", clientKeyFile: old.catalogKeyFile });
  if (old.cpaUrl) registry.modules.push({ id: "cpa", kind: "cliproxyapi", version: "unverified",
    managementUrl: old.cpaUrl, managementKeyFile: old.managementKeyFile, configFile: "",
    maintenance: "external", quotaAdapter: "none" });
  config.modelManagement = validateModelRegistry(registry);
  db.prepare("INSERT INTO storage_migration_archive(migration_version,family,record_key,payload) VALUES(?,?,?,?)")
    .run(24, "config", "1", row.payload);
  db.prepare("UPDATE config SET payload=? WHERE id=1").run(JSON.stringify(config));
}
