import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadRuntime(directory) {
  const root = resolve(directory);
  const load = path => import(pathToFileURL(join(root,"dist",path)).href);
  const require = createRequire(join(root,"package.json"));
  const Database = require("better-sqlite3");
  const schema = await load("storage/sqliteSchema.js");
  const versions = await load("storage/storageVersions.js");
  if (versions.CURRENT_STORAGE_VERSION !== "1.0") throw new Error("This converter targets only the new 1.0 storage baseline.");
  const { validateStoredRecord } = await load("storage/recordValidation.js");
  const { validateYuiConfig } = await load("storage/taskStore.js");
  const { validateTaskBrief } = await load("brief/taskBrief.js");
  const { normalizeVerificationPlan } = await load("verification/verificationPlan.js");
  const { createRuntimeObservation } = await load("runtime/runtimeObservation.js");
  const { validateRuntimeProcessExitObservation } = await load("runtime/processExitObservation.js");
  const { parseResourceRegistryState } = await load("resources/resourceRegistry.js");
  const { acquireHandoverLock } = await load("release/runtimeRelease.js");
  const { SqliteTaskStore } = await load("storage/sqliteStore.js");
  const { parseTaskRuntimeIsolationDescriptor, taskRuntimeIsolationFingerprint } = await load("runtime/taskRuntimeIsolation.js");
  const reference = new Database(":memory:");
  let identitySql;
  try {
    schema.initializeSqliteSchema(reference);
    identitySql = reference.prepare("SELECT sql FROM sqlite_master WHERE name='storage_schema'").get().sql;
  } finally { reference.close(); }
  return {
    Database, identitySql, checksum: schema.CURRENT_SCHEMA_CHECKSUM, acquireHandoverLock,
    parseIsolation: parseTaskRuntimeIsolationDescriptor,
    isolationFingerprint: taskRuntimeIsolationFingerprint,
    validateSchema: schema.validateSqliteSchema, validateBrief: validateTaskBrief,
    validateHome(home) {
      const store=new SqliteTaskStore(home,{readonly:true});
      try {store.validateCurrentRecords();}
      finally {store.close();}
    },
    validateRecord(table, value) {
      if (table === "config") validateYuiConfig(value);
      else if (table === "resource_registry") parseResourceRegistryState({ schemaVersion:1, records:{ [value.id]:value } });
      else validateStoredRecord(table,value);
      if (table === "projects") {
        for (const entry of value.knowledge) {
          if (entry.status !== "active") continue;
          let plan;
          try { plan=JSON.parse(entry.body); } catch { continue; }
          if (plan?.kind === "verification-plan") normalizeVerificationPlan(plan);
        }
      }
      if (table === "events" && value.type === "runtime.observation") createRuntimeObservation(JSON.parse(value.payload.observation));
      if (table === "events" && value.type === "runtime.process-exit-observed") validateRuntimeProcessExitObservation(JSON.parse(value.payload.observation));
    }
  };
}
