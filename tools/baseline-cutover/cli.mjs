#!/usr/bin/env node
// Standalone, explicitly invoked converter; not bundled in the Yui runtime.
import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { inspectLegacyDatabase, convertDatabase } from "./database.mjs";
import { loadRuntime } from "./runtime.mjs";
import { isolationMarkers } from "./files.mjs";

const inside = (root,path) => { const rel=relative(root,path); return rel==="" || (!rel.startsWith("../") && rel!==".." && !isAbsolute(rel)); };
function archiveFile(entry,archived) {
  copyFileSync(entry.path,archived,constants.COPYFILE_EXCL);
  const digest=path=>createHash("sha256").update(readFileSync(path)).digest("hex");
  if(digest(archived)!==entry.sha256 || digest(entry.path)!==entry.sha256
    || lstatSync(entry.path).isSymbolicLink()) throw new Error(`Runtime file changed during archival: ${entry.path}.`);
  unlinkSync(entry.path);
}

/** Known Home ownership is fenced exactly; unrelated user processes are not adopted. */
export function assertOffline(home, owners=[]) {
  if (process.platform !== "linux") throw new Error("Offline process verification currently requires Linux.");
  const uid = process.getuid();
  const databaseFiles = new Set(["yui.db","yui.db-wal","yui.db-shm"].map(name=>join(home,name)));
  for(const owner of owners) {
    if(!Number.isSafeInteger(owner.pid) || owner.pid<1 || !/^\d+$/.test(owner.startIdentity)) {
      throw new Error("Stored process custody is invalid; inspect it with the old release.");
    }
    let stat;
    try {stat=readFileSync(`/proc/${owner.pid}/stat`,"utf8");}
    catch(error) {if(error.code==="ENOENT" || error.code==="ESRCH") continue; throw error;}
    const parts=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);
    if(!parts[19]) throw new Error(`Stored process ${owner.pid} has unprovable identity.`);
    if(parts[19]===owner.startIdentity && parts[0]!=="Z") throw new Error(`Stored Home process ${owner.pid} is still alive.`);
  }
  const readable=(path)=> {
    try {return readFileSync(path,"utf8");}
    catch(error) {if(error.code==="EACCES" || error.code==="EPERM") return ""; throw error;}
  };
  for (const id of readdirSync("/proc").filter(value=>/^[1-9]\d*$/.test(value))) {
    if (Number(id) === process.pid) continue;
    const root = `/proc/${id}`;
    try {
      const status = readFileSync(join(root,"status"),"utf8");
      if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
      const env = readable(join(root,"environ")).split("\0");
      if (env.some(value=>value === `YUI_HOME=${home}`)) throw new Error(`Home still has a live process: ${id}. Stop it with 0.99.0.`);
      const argv=readable(join(root,"cmdline")).split("\0");
      if(argv.some(value=>isAbsolute(value) && inside(home,value))) {
        throw new Error(`Process ${id} still references this Home.`);
      }
      let fds;
      try {fds=readdirSync(join(root,"fd"));}
      catch(error) {if(error.code==="EACCES" || error.code==="EPERM") continue; throw error;}
      for (const fd of fds) {
        let target;
        try { target=readlinkSync(join(root,"fd",fd)); }
        catch(error) { if(["ENOENT","EACCES","EPERM"].includes(error.code)) continue; throw error; }
        if (databaseFiles.has(target)) throw new Error(`Database is still open in process ${id}.`);
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue;
      throw new Error(`Cannot establish offline state for PID ${id}: ${error.message}`);
    }
  }
  // Pending native facts are not disposable. A source runtime must consume them.
  for (const name of ["runtime/inbox", "runtime/inbox-invalid"]) {
    const path=join(home,name);
    if (existsSync(path) && readdirSync(path).length) {
      throw new Error(`Pending runtime evidence remains at ${path}; settle it with 0.99.0.`);
    }
  }
  for(const name of ["runtime/controller.json","runtime/controller-candidate.json","runtime/handover-fence.json"]) {
    if(existsSync(join(home,name))) throw new Error(`Unsettled runtime evidence: ${name}. Inspect with 0.99.0; the converter does not infer ownership.`);
  }
}

function runtimeBindings(home) {
  const entries=[];
  for(const [name,version] of [["active-release.json",1],["runtime-identity.json",2]]) {
    const path=join(home,"runtime",name);
    if(!existsSync(path)) continue;
    const metadata=lstatSync(path);
    if(!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Unrecognized runtime binding: ${path}.`);
    const bytes=readFileSync(path),value=JSON.parse(bytes);
    if(value.schemaVersion!==version || typeof value.version!=="string"
      || (name==="runtime-identity.json" && value.storageVersion!==37)) {
      throw new Error(`Runtime binding does not belong to the old baseline: ${path}.`);
    }
    if(name==="active-release.json") {
      if(!/^[a-f0-9]{64}$/.test(value.packageDigest) || value.releaseId!==`${value.version}-${value.packageDigest}`
        || value.buildId!==`${value.version}-${value.packageDigest.slice(0,12)}`
        || !Number.isFinite(Date.parse(value.activatedAt))) throw new Error(`Invalid old release selection: ${path}.`);
    } else if(value.controllerProtocolVersion!==4 || value.minimumStorageVersion!==1
      || value.storageBackend!=="sqlite" || typeof value.workerEnabled!=="boolean"
      || value.mode!=="primary" || value.dualOwner!==false || !Number.isSafeInteger(value.pid) || value.pid<1
      || !/^[0-9]+$/.test(value.processStartIdentity) || !Array.isArray(value.args)
      || value.args.some(arg=>typeof arg!=="string")
      || !["executablePath","cliRealpath","controllerRealpath","buildId"].every(key=>typeof value[key]==="string" && value[key])
      || !Number.isFinite(Date.parse(value.writtenAt))) {
      throw new Error(`Invalid or unsettled old runtime identity: ${path}.`);
    }
    entries.push({name,path,sha256:createHash("sha256").update(bytes).digest("hex"),
      ...(name==="runtime-identity.json" ? {owner:{pid:value.pid,startIdentity:value.processStartIdentity}} : {})});
  }
  return entries;
}

function options(args) {
  const result={apply:false};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(key==="--apply" && !result.apply) {result.apply=true;continue;}
    if(!["--home","--runtime","--backup-dir"].includes(key) || !args[i+1] || args[i+1].startsWith("--")
      || result[key.slice(2)]!==undefined) throw new Error("Usage: cli.mjs --home <absolute-path> --runtime <new-package> [--apply --backup-dir <new-directory>]");
    result[key.slice(2)]=args[++i];
  }
  if (!result.home || !result.runtime || !isAbsolute(result.home) || !isAbsolute(result.runtime)
    || (result.apply && (!result["backup-dir"] || !isAbsolute(result["backup-dir"])))) {
    throw new Error("Explicit absolute Home/runtime paths are required; --apply also requires a new absolute backup directory.");
  }
  return result;
}

export async function main(args) {
  const opt=options(args), home=realpathSync(opt.home);
  if (process.env.YUI_SESSION_SCOPE === "task" || process.env.YUI_TASK_ID) {
    throw new Error("A managed Task cannot convert the control-plane Home.");
  }
  const runtime=await loadRuntime(opt.runtime);
  const path=join(home,"yui.db");
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Home database must be a regular file.");
  let db=new runtime.Database(path,{readonly:true,fileMustExist:true}),owners;
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='storage_schema'").get()) {
      runtime.validateSchema(db);
      runtime.validateHome(home);
      return {outcome:"already-current",storageVersion:"1.0",home};
    }
    inspectLegacyDatabase(db);
    owners=db.prepare("SELECT payload FROM session_owners").all().map(row=>JSON.parse(row.payload).providerRoot);
  } finally {db.close();}
  owners.push(...runtimeBindings(home).flatMap(entry=>entry.owner ? [entry.owner] : []));
  assertOffline(home,owners);
  isolationMarkers(home,runtime);
  if(!opt.apply) return {outcome:"conversion-plan",source:"legacy:37",target:"1.0",home,
    action:"Repeat with --apply and --backup-dir while the old runtime remains stopped."};
  const backup=resolve(opt["backup-dir"]);
  if (inside(home,backup) || inside(backup,home) || existsSync(backup)
    || !existsSync(dirname(backup)) || realpathSync(dirname(backup)) !== dirname(backup)) {
    throw new Error("Backup must be a new directory outside Home, under an existing canonical parent.");
  }
  const fence=runtime.acquireHandoverLock(home);
  let report;
  try {
    assertOffline(home,owners);
    db=new runtime.Database(path,{fileMustExist:true});
    try {
      inspectLegacyDatabase(db);
      const before=db.pragma("data_version",{simple:true});
      mkdirSync(backup,{mode:0o700});
      cpSync(home,join(backup,"home"),{recursive:true,dereference:false,verbatimSymlinks:true,errorOnExist:true,force:false});
      // SQLite backup yields one self-contained snapshot, independent of WAL.
      await db.backup(join(backup,"yui.db"));
      const receipt={source:"legacy:37",target:"1.0",home,targetChecksum:runtime.checksum,
        backupDatabase:join(backup,"yui.db"),backupHome:join(backup,"home"),
        backupSha256:createHash("sha256").update(readFileSync(join(backup,"yui.db"))).digest("hex")};
      writeFileSync(join(backup,"receipt.json"),JSON.stringify({...receipt,outcome:"backed-up"},null,2)+"\n",{flag:"wx",mode:0o600});
      assertOffline(home,owners);
      const bindings=runtimeBindings(home),markers=isolationMarkers(home,runtime),moved=[];
      mkdirSync(join(backup,"retired-runtime"),{mode:0o700});
      db.exec("BEGIN IMMEDIATE");
      try {
        if(db.pragma("data_version",{simple:true})!==before) throw new Error("Source changed during backup; preserve the backup and retry with a fresh destination.");
        // Detach old executable selection, never relabel a past process as a
        // new-baseline process. Original bytes remain in both backup and archive.
        for(const entry of bindings) {
          const archived=join(backup,"retired-runtime",entry.name);
          archiveFile(entry,archived);moved.push({...entry,archived});
        }
        for(const [index,entry] of markers.entries()) {
          if(createHash("sha256").update(readFileSync(entry.path)).digest("hex")!==entry.sha256) {
            throw new Error(`Isolation marker changed during cutover: ${entry.path}.`);
          }
          const archived=join(backup,"retired-runtime",`isolation-${index}.json`);
          archiveFile(entry,archived);
          const change={...entry,archived,replaced:false};
          moved.push(change);
          writeFileSync(entry.path,entry.replacement,{flag:"wx",mode:entry.mode});
          change.replaced=true;
        }
        report=convertDatabase(db,runtime);
        db.exec("COMMIT");
      } catch(error) {
        if(db.inTransaction) db.exec("ROLLBACK");
        const failures=[];
        for(const entry of moved.reverse()) {
          try {
            if(entry.replaced) {
              if(readFileSync(entry.path,"utf8")!==entry.replacement) throw new Error("replacement was changed");
              unlinkSync(entry.path);
            }
            if(existsSync(entry.path)) throw new Error("original path was recreated");
            copyFileSync(entry.archived,entry.path,constants.COPYFILE_EXCL);
          } catch(restoreError) {failures.push(`${entry.path}: ${restoreError.message}`);}
        }
        if(failures.length) throw new Error(`${error.message}; runtime binding restoration incomplete: ${failures.join("; ")}`);
        throw error;
      }
      writeFileSync(join(backup,"receipt.complete.json"),JSON.stringify({...receipt,...report,
        retiredRuntime:bindings,isolationMarkers:markers.map(({replacement,...entry})=>entry),
        outcome:"converted"},null,2)+"\n",{flag:"wx",mode:0o600});
      renameSync(join(backup,"receipt.complete.json"),join(backup,"receipt.json"));
      return {...report,outcome:"converted",home,backup};
    } finally {db.close();}
  } finally {fence.release();}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(report=>console.log(JSON.stringify({ok:true,...report}))).catch(error=>{
    console.error(JSON.stringify({ok:false,message:error.message,
      action:"Keep the Home stopped. Preserve the backup/receipt and inspect the exact failed stage; never infer permission to discard data."}));
    process.exitCode=5;
  });
}
