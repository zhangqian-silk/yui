import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../../dist/sqlite/driver.js";
import { SqliteTaskStore } from "../../dist/storage/sqliteStore.js";
import { createTask } from "../../dist/task/task.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { validateCurrentTaskStore } from "../../dist/storage/currentTaskStore.js";
import { runStorageUpgrade } from "../../dist/storage/upgrade/upgradeOrchestrator.js";
import { getDoctorChecks, summarizeStorageHealth } from "../../dist/doctor/doctor.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet } from "../../dist/executor/agentExecutor.js";

test("invalid historical records fail exact reads and audit, not core Home admission", async t => {
  const home = mkdtempSync(join(tmpdir(), "yui-record-validation-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new SqliteTaskStore(home);
  const at = new Date("2026-09-15T12:00:00Z");
  const message = createTaskMessage("message-1", "task-1", "Original input", "user", { type: "user" }, at);
  try {
    store.saveTask(createTask("task-1", "Current records", at));
    const revision = store.getRevision();
    assert.throws(() => store.saveMessage("task-1", { ...message, schemaVersion: 999 }), /Message|messages/);
    assert.equal(store.getRevision(), revision);
    assert.deepEqual(store.listMessages("task-1"), []);
    store.saveMessage("task-1", message);
    assert.throws(() => store.updateMessage("task-1", { ...message, intent: undefined }), /intent|messages/);
    assert.deepEqual(store.listMessages("task-1"), [message]);
  } finally { store.close(); }
  const db = new Database(join(home, "yui.db"));
  try { db.exec("UPDATE messages SET payload=json_set(payload,'$.schemaVersion',999)"); }
  finally { db.close(); }
  const invalid = new SqliteTaskStore(home);
  try {
    assert.throws(() => invalid.listMessages("task-1"), /Message|messages/);
    assert.throws(() => invalid.queryContextRecords("task-1", { family: "task-message", limit: 1 }), /Message|messages/);
    assert.throws(() => invalid.validateCurrentRecords(), /Message|messages/);
  }
  finally { invalid.close(); }
  assert.doesNotThrow(() => validateCurrentTaskStore(home));
  const check = await runStorageUpgrade({ home, mode: "dry-run" });
  assert.equal(check.outcome, "already-current");
  const doctor = await getDoctorChecks({ HOME: home, YUI_HOME: home, CODEX_HOME: home }, { run: () => "fixture" });
  assert.equal(doctor.find(check => check.name === "storage state").status, "ok");
  assert.equal(doctor.find(check => check.name === "stored records").status, "invalid");
  assert.equal(summarizeStorageHealth(doctor).healthy, true, "history diagnostics do not block update verification");
});

test("shared version-1 envelopes cannot cross Task and Global record authority", t=>{
  const home=mkdtempSync(join(tmpdir(),"yui-record-scope-"));
  const store=new SqliteTaskStore(home);
  t.after(()=>{store.close();rmSync(home,{recursive:true,force:true});});
  const at=new Date("2026-09-18T00:00:00Z");
  const binding=createRoleAgentBinding({id:"codex",adapterId:"codex"});
  const role=createRole("task-1","worker",[binding],"codex",home,at);
  const taskSet=createRoleSessionSet({scope:"task",taskId:"task-1",roleName:"worker"},"codex",at);
  const globalSet=createRoleSessionSet({scope:"global",roleName:"worker"},"codex",at);
  const before=store.getRevision();
  assert.throws(()=>store.saveGlobalRole(role),/Global|global/);
  assert.throws(()=>store.saveGlobalRoleSessionSet(taskSet),/scope|global/i);
  assert.throws(()=>store.saveTaskRoleSessionSet(globalSet),/scope|task/i);
  assert.equal(store.getRevision(),before);
  assert.deepEqual(store.listGlobalRoles(),[]);
  store.databaseHandle().prepare("UPDATE storage_schema SET format='different-format'").run();
  assert.throws(()=>store.saveTask(createTask("task-1","Do not write across a format change",at)),/schema|format/i);
});
