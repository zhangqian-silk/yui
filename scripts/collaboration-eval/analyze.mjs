import { analyze, readEvidence } from "./evidence.mjs";

if (process.argv.length !== 3) throw new Error("Usage: node scripts/collaboration-eval/analyze.mjs <record-directory>");
console.log(JSON.stringify(analyze(readEvidence(process.argv[2])), null, 2));
