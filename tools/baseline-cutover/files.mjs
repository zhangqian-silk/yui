import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const digest=bytes=>createHash("sha256").update(bytes).digest("hex");

/** Inspect only the declared runtime inventory depths, never traverse user data or symlinks. */
export function isolationMarkers(home,runtime) {
  const result=[];
  for(const [name,depth] of [["task-runtimes",3],["integration-runtimes",2]]) {
    const root=join(home,"runtime",name);
    if(!existsSync(root)) continue;
    visit(root,depth,name==="task-runtimes");
  }
  function visit(directory,depth,skipPlanning=false) {
    const metadata=lstatSync(directory);
    if(metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Unrecognized runtime inventory: ${directory}.`);
    const path=join(directory,".yui-task-runtime-owner.json");
    if(existsSync(path)) {
      if(!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Unrecognized isolation marker: ${path}.`);
      const bytes=readFileSync(path),marker=JSON.parse(bytes);
      if(marker.schemaVersion!==1 || marker.kind!=="yui-task-runtime-resource-owner"
        || marker.descriptor?.schemaVersion!==2) throw new Error(`Unknown isolation marker format: ${path}.`);
      const descriptor=runtime.parseIsolation(JSON.stringify({...marker.descriptor,schemaVersion:1}));
      const previous={...descriptor,schemaVersion:2};
      if(JSON.stringify(previous)!==JSON.stringify(marker.descriptor)
        || digest(JSON.stringify(previous))!==marker.fingerprint
        || descriptor.roots.runtime!==directory || realpathSync(directory)!==directory) {
        throw new Error(`Isolation marker identity or digest differs: ${path}.`);
      }
      result.push({path,sha256:digest(bytes),mode:lstatSync(path).mode & 0o777,
        replacement:JSON.stringify({...marker,descriptor,fingerprint:runtime.isolationFingerprint(descriptor)})+"\n"});
      return;
    }
    if(depth===0) return;
    for(const entry of readdirSync(directory,{withFileTypes:true})) {
      if(skipPlanning && entry.name==="planning") continue;
      if(entry.isSymbolicLink()) throw new Error(`Unrecognized runtime inventory link: ${join(directory,entry.name)}.`);
      if(entry.isDirectory()) visit(join(directory,entry.name),depth-1);
    }
  }
  return result;
}
