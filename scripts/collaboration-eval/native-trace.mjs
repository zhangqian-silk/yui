// Test-owned diagnostics, not participant business context or Yui state.
// Keep raw CLI bytes out of native reports to avoid recursively paging traces.
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function externalizeTrace(root, result) {
  if (!Array.isArray(result.trace)) throw new Error("Missing native diagnostic trace");
  const directory = join(root, "native-traces");
  mkdirSync(directory, { recursive: true });
  const bytes = JSON.stringify({ threadId: result.threadId, turnId: result.turnId, trace: result.trace });
  const path = join(directory, `${digest(`${result.threadId}/${result.turnId}`)}.json`);
  writeFileSync(path, bytes, { flag: "wx" });
  const { trace, ...body } = result;
  return { ...body, traceRef: { path, digest: digest(bytes), bytes: Buffer.byteLength(bytes) } };
}

export function readNativeTrace(root, result) {
  if (result.trace) return result.trace; // Small in-memory unit/calibration producers.
  const ref = result.traceRef;
  if (!ref || ref.bytes > 8 * 1024 * 1024) throw new Error("Missing or oversized native diagnostics");
  const directory = realpathSync(join(root, "native-traces")), path = realpathSync(ref.path);
  if (relative(directory, path).startsWith("..") || resolve(path) === directory) {
    throw new Error("Native diagnostics outside owned fixture");
  }
  const bytes = readFileSync(path);
  if (bytes.length !== ref.bytes || digest(bytes) !== ref.digest) throw new Error("Native diagnostic digest mismatch");
  const value = JSON.parse(bytes);
  if (value.threadId !== result.threadId || value.turnId !== result.turnId || !Array.isArray(value.trace)) {
    throw new Error("Native diagnostic identity mismatch");
  }
  return value.trace;
}
