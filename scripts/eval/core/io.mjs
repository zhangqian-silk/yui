// Topic/provider-neutral byte utilities. These do not interpret Agent behavior.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2), { flag: "wx" });
export const now = () => new Date().toISOString();
export function completeJsonLines(text) {
  const end = text.lastIndexOf("\n") + 1, suffix = text.slice(end);
  return { records: text.slice(0, end).split("\n").filter(Boolean).map(s => JSON.parse(s)),
    tail: suffix ? { bytes: Buffer.byteLength(suffix), sha256: hash(suffix) } : undefined };
}
