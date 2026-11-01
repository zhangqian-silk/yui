// Case-local, dependency-free paging. No subprocesses or historical commands.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const hash = text => createHash("sha256").update(text).digest("hex");
export function readReviewPage(directory, id, offset = 0, limit = 12000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000)
    throw Error("Invalid bounded read offset/limit");
  const viewBytes = readFileSync(join(directory, "view-index.json"));
  const seal = JSON.parse(readFileSync(join(directory, "package-seal.json")));
  if (hash(viewBytes) !== seal["view-index.json"]) throw Error("View index integrity mismatch");
  const view = JSON.parse(viewBytes);
  const entry = view.index.find(e => e.id === id);
  if (!entry || !/^view\/V\d{6}\.txt$/.test(entry.file)) throw Error("Unknown view ID");
  const text = readFileSync(join(directory, entry.file), "utf8");
  if (hash(text) !== entry.sha256 || seal[entry.file] !== entry.sha256) throw Error("View integrity mismatch");
  if (offset > text.length || offset && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1]))
    throw Error("Invalid text offset");
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  if (end === offset && offset < text.length) end = Math.min(text.length, offset + 2);
  // Expose only the source-text spans actually displayed on this page. Labels
  // and field boundaries are not quoteable evidence; these coordinates are not
  // proof that the reviewer loaded other pages or retained a previous read.
  const spans = entry.fields.length ? entry.fields : [{ startUtf16: 0, endUtf16: text.length }];
  const citationSpansUtf16 = spans
    .map(f => [Math.max(offset, f.startUtf16), Math.min(end, f.endUtf16)])
    .filter(([start, finish]) => start < finish);
  return { id, sha256: entry.sha256, offsetUtf16: offset, endUtf16: end, totalUtf16: text.length,
    citationSpansUtf16,
    complete: end === text.length, nextOffset: end === text.length ? null : end, text: text.slice(offset, end) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3 || process.argv.length > 4) throw Error("Use node ./read.mjs V000001 [offset,limit]");
  const range = process.argv[3] ?? "0,12000";
  if (!/^\d+,\d+$/.test(range)) throw Error("Expected offset,limit");
  const [offset, limit] = range.split(",").map(Number);
  const page = readReviewPage(dirname(fileURLToPath(import.meta.url)), process.argv[2], offset, limit);
  const { text, ...metadata } = page;
  process.stdout.write(JSON.stringify(metadata) + "\n" + text);
}
