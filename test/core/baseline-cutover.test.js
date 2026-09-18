import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { convertDatabase, inspectLegacyDatabase } from "../../tools/baseline-cutover/database.mjs";
import { convertRecord } from "../../tools/baseline-cutover/records.mjs";
import { loadRuntime } from "../../tools/baseline-cutover/runtime.mjs";
import { createTask } from "../../dist/task/task.js";
import { createTaskMessage } from "../../dist/message/message.js";
import { createTaskEvent } from "../../dist/event/taskEvent.js";
import { createWorkItem } from "../../dist/workItem/workItem.js";
import { createRole, createRoleAgentBinding } from "../../dist/role/role.js";
import { createRoleSessionSet, recordRoleAgentSession } from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";
import { contextContentDigest, createContextSnapshot, validateContextSnapshot } from "../../dist/context/contextSnapshot.js";
import { sanitizedTestEnv } from "../helpers/sanitizedEnv.mjs";
import { createManagedWorkspace } from "../../dist/worktree/managedWorkspace.js";
import { createTaskRuntimeIsolationDescriptor, taskRuntimeIsolationFingerprint } from "../../dist/runtime/taskRuntimeIsolation.js";

const runtime=await loadRuntime(resolve(import.meta.dirname,"../.."));
const at=new Date("2026-09-18T00:00:00Z");
function fixture(t) {
  const db=new Database(":memory:");
  t.after(()=>db.close());
  db.exec(readFileSync(new URL("../fixtures/legacy-v37.sql",import.meta.url),"utf8"));
  db.prepare("INSERT INTO config VALUES(1,?,?)").run('{"schemaVersion":6}',at.toISOString());
  db.prepare("INSERT INTO home_meta VALUES(1,?,41,?,?)").run(JSON.stringify({
    schemaVersion:1,homeId:"home-1234567890abcdef",entropy:"a".repeat(32),createdAt:at.toISOString()
  }),at.toISOString(),at.toISOString());
  const task={...createTask("task-1","Preserve intent",at),schemaVersion:7};
  db.prepare("INSERT INTO tasks_catalog(task_id,status,lifecycle,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run(task.id,task.status,"planning",0,task.createdAt,task.updatedAt);
  db.prepare("INSERT INTO task_records(task_id,payload,updated_at) VALUES(?,?,?)")
    .run(task.id,JSON.stringify(task),task.updatedAt);
  return db;
}

test("one-time v37 conversion preserves intent, raw audits, identities and counters", t=>{
  const db=fixture(t);
  const message={...createTaskMessage("message-1","task-1",'{"schemaVersion":99,"body":"user JSON"}',"user",{type:"user"},at),schemaVersion:3};
  const original=JSON.stringify(message);
  db.prepare("INSERT INTO messages(task_id,message_id,seq,payload,created_at) VALUES(?,?,1,?,?)").run(message.taskId,message.id,original,message.createdAt);
  const event={...createTaskEvent("event-1","task-1","user.requirement",{body:original},at),schemaVersion:2};
  db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(event.taskId,event.id,event.type,event.createdAt,JSON.stringify(event));
  db.prepare("INSERT INTO id_sequences VALUES('task-1','event',19)").run();
  const home=db.prepare("SELECT * FROM home_meta").get();
  const plan=inspectLegacyDatabase(db);
  assert.deepEqual(plan,{source:"legacy:37",target:"1.0",ledgerEntries:37});
  db.transaction(()=>convertDatabase(db,runtime))();
  runtime.validateSchema(db);
  assert.deepEqual(db.prepare("SELECT * FROM home_meta").get(),home);
  assert.equal(db.prepare("SELECT high_water FROM id_sequences").get().high_water,19);
  const current=JSON.parse(db.prepare("SELECT payload FROM messages").get().payload);
  assert.equal(current.schemaVersion,1);
  assert.equal(current.body,message.body);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM events").get().payload).payload.body,original);
  assert.equal(db.prepare("SELECT payload FROM storage_migration_archive WHERE family='baseline-0.99.0/messages'").get().payload,original);
  assert.equal(JSON.parse(db.prepare("SELECT payload FROM storage_migration_archive WHERE family='baseline-0.99.0/ledger'").get().payload).length,37);
  const before=db.serialize();
  assert.throws(()=>db.transaction(()=>convertDatabase(db,runtime))(),/exact 0.99.0/);
  assert.deepEqual(db.serialize(),before);
});

test("malformed source and unsettled work never advance the format or partially convert records", t=>{
  const db=fixture(t);
  const item={...createWorkItem("work-item-1","task-1",{title:"Invalid format"},at),schemaVersion:999};
  db.prepare("INSERT INTO work_items(task_id,work_item_id,status,payload,updated_at) VALUES(?,?,?,?,?)")
    .run(item.taskId,item.id,item.status,JSON.stringify(item),item.updatedAt);
  const before=db.serialize();
  assert.throws(()=>db.transaction(()=>convertDatabase(db,runtime))(),/Unsupported 0.99.0 work_items/);
  assert.deepEqual(db.serialize(),before);
  db.prepare("DELETE FROM work_items").run();
  db.prepare("INSERT INTO outbox(request_id,command,state,created_at) VALUES('pending','{}','pending',?)").run(at.toISOString());
  assert.throws(()=>inspectLegacyDatabase(db),/pending outbox/);
  db.prepare("DELETE FROM outbox").run();
  db.prepare("UPDATE schema_migrations SET checksum='bad' WHERE version=37").run();
  assert.throws(()=>inspectLegacyDatabase(db),/ledger differs/);
});

test("nested Session envelopes reset without traversing opaque Context and native data", ()=>{
  const binding=createRoleAgentBinding({id:"codex",adapterId:"codex"});
  const role=createRole("task-1","leader",[binding],"codex","/tmp/fixture",at);
  const set=recordRoleAgentSession(createRoleSessionSet({scope:"task",taskId:"task-1",roleName:"leader"},"codex",at),{
    agentId:"codex",adapterId:"codex",nativeSessionId:"native-1",policy:"fixed",status:"ended",
    effective:resolveEffectiveLaunch({role,purpose:"execution"})
  },at);
  const legacy=structuredClone(set);
  legacy.schemaVersion=12;
  for(const session of Object.values(legacy.sessions)) {
    session.schemaVersion=6;session.effective.schemaVersion=4;
  }
  assert.deepEqual(convertRecord("role_session_sets",legacy),set);
  const opaque={schemaVersion:3,native:{schemaVersion:99},body:"Original frozen source"};
  const ref={layer:"L2",store:"task-message",refId:"message-1",revision:"8",digest:contextContentDigest(opaque)};
  const snapshot=createContextSnapshot({id:"snapshot-1",taskId:"task-1",scope:"task",sequence:1,
    refs:[ref],resources:[{ref,value:opaque}],acceptRefs:[],frozenAt:at,frozenBy:"controller"});
  assert.deepEqual(convertRecord("context_snapshots",snapshot),snapshot);
  validateContextSnapshot(snapshot);
});

test("standalone offline cutover backs up Home, retires old executable selection and is idempotent", async t=>{
  const root=mkdtempSync(join(tmpdir(),"yui-baseline-cli-")),home=join(root,"home"),backup=join(root,"backup");
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(home,"runtime"),{recursive:true});
  mkdirSync(join(home,"workspaces"),{recursive:true});
  writeFileSync(join(home,"workspaces","dirty.txt"),"uncommitted work\n");
  const workspace=createManagedWorkspace({owner:{type:"task",taskId:"task-1"},root:join(home,"workspaces"),entries:[]},at);
  const descriptor=createTaskRuntimeIsolationDescriptor({workspace,runtimeRoot:join(home,"runtime","task-runtimes")});
  const oldDescriptor={...descriptor,schemaVersion:2};
  const marker={schemaVersion:1,kind:"yui-task-runtime-resource-owner",descriptor:oldDescriptor,
    fingerprint:createHash("sha256").update(JSON.stringify(oldDescriptor)).digest("hex")};
  mkdirSync(descriptor.roots.runtime,{recursive:true});
  const markerPath=join(descriptor.roots.runtime,".yui-task-runtime-owner.json");
  writeFileSync(markerPath,JSON.stringify(marker));
  const selection={schemaVersion:1,version:"0.99.0",packageDigest:"c".repeat(64),
    releaseId:`0.99.0-${"c".repeat(64)}`,buildId:`0.99.0-${"c".repeat(12)}`,activatedAt:at.toISOString()};
  const bytes=JSON.stringify(selection);
  writeFileSync(join(home,"runtime","active-release.json"),bytes);
  const db=fixture(t);
  await db.backup(join(home,"yui.db"));
  const cli=resolve(import.meta.dirname,"../../tools/baseline-cutover/cli.mjs");
  const run=(extra=[])=>spawnSync(process.execPath,[cli,"--home",home,"--runtime",
    resolve(import.meta.dirname,"../.."),...extra],{encoding:"utf8",env:sanitizedTestEnv(),timeout:15000});
  const before=readFileSync(join(home,"yui.db"));
  const plan=run();
  assert.equal(plan.status,0,plan.stderr);
  assert.equal(JSON.parse(plan.stdout).outcome,"conversion-plan");
  assert.deepEqual(readFileSync(join(home,"yui.db")),before);
  assert.equal(existsSync(backup),false);
  const invalidate=new Database(join(home,"yui.db"));
  try { invalidate.exec("UPDATE task_records SET payload=json_set(payload,'$.schemaVersion',999)"); }
  finally { invalidate.close(); }
  const rejected=run(["--apply","--backup-dir",join(root,"failed-backup")]);
  assert.equal(rejected.status,5);
  assert.match(rejected.stderr,/Unsupported 0.99.0 task_records/);
  assert.equal(readFileSync(join(home,"runtime","active-release.json"),"utf8"),bytes);
  assert.deepEqual(JSON.parse(readFileSync(markerPath,"utf8")),marker);
  const restored=new Database(join(home,"yui.db"));
  try {
    assert.equal(restored.prepare("SELECT max(version) AS v FROM schema_migrations").get().v,37);
    assert.equal(JSON.parse(restored.prepare("SELECT payload FROM config").get().payload).schemaVersion,6);
    restored.exec("UPDATE task_records SET payload=json_set(payload,'$.schemaVersion',7)");
  } finally { restored.close(); }
  const applied=run(["--apply","--backup-dir",backup]);
  assert.equal(applied.status,0,applied.stderr);
  assert.equal(JSON.parse(applied.stdout).outcome,"converted");
  assert.equal(readFileSync(join(backup,"retired-runtime","active-release.json"),"utf8"),bytes);
  assert.equal(existsSync(join(home,"runtime","active-release.json")),false);
  assert.equal(readFileSync(join(home,"workspaces","dirty.txt"),"utf8"),"uncommitted work\n");
  const convertedMarker=JSON.parse(readFileSync(markerPath,"utf8"));
  assert.deepEqual(convertedMarker.descriptor,descriptor);
  assert.equal(convertedMarker.fingerprint,taskRuntimeIsolationFingerprint(descriptor));
  assert.deepEqual(JSON.parse(readFileSync(join(backup,"retired-runtime","isolation-0.json"),"utf8")),marker);
  assert.equal(readFileSync(join(backup,"home","workspaces","dirty.txt"),"utf8"),"uncommitted work\n");
  const original=new Database(join(backup,"yui.db"),{readonly:true});
  try { assert.equal(original.prepare("SELECT max(version) AS v FROM schema_migrations").get().v,37); }
  finally { original.close(); }
  runtime.validateHome(home);
  const repeated=run(["--apply","--backup-dir",join(root,"unused-backup")]);
  assert.equal(repeated.status,0,repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).outcome,"already-current");
  assert.equal(existsSync(join(root,"unused-backup")),false);
});
