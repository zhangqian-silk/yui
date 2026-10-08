// Only public read-back facts reach this deterministic participant process.
// This is a timeout boundary, not a filesystem security sandbox.
import { executeCase } from "./cases/participant.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const { root, readback } = JSON.parse(input);
process.stdout.write(JSON.stringify(await executeCase({ root, readback })));
