import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if(process.argv.length!==4 || process.argv[2]!=="--output") {
  throw new Error("Usage: package-baseline-converter.mjs --output <new-archive.tgz>");
}
const root=fileURLToPath(new URL("../",import.meta.url));
const output=resolve(process.argv[3]);
if(existsSync(output) || existsSync(`${output}.sha256`)) throw new Error("Converter archive destination already exists.");
const files=["README.md","cli.mjs","database.mjs","records.mjs","runtime.mjs","files.mjs","legacy-ledger.json"];
mkdirSync(dirname(output),{recursive:true});
execFileSync("tar",["-czf",output,"-C",resolve(root,"tools/baseline-cutover"),...files]);
const packed=execFileSync("tar",["-tzf",output],{encoding:"utf8"}).trim().split("\n").sort();
if(JSON.stringify(packed)!==JSON.stringify([...files].sort())) throw new Error("Converter archive inventory differs from its declared files.");
const digest=createHash("sha256").update(readFileSync(output)).digest("hex");
writeFileSync(`${output}.sha256`,`${digest}  ${basename(output)}\n`,{flag:"wx"});
console.log(`Standalone converter: ${output}`);
