// Case-local, dependency-free paging. No subprocesses or historical commands.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const hash = text => createHash("sha256").update(text).digest("hex");
function openIndex(directory) {
  const viewBytes = readFileSync(join(directory, "view-index.json"));
  const seal = JSON.parse(readFileSync(join(directory, "package-seal.json")));
  if (hash(viewBytes) !== seal["view-index.json"]) throw Error("View index integrity mismatch");
  const view = JSON.parse(viewBytes);
  return { view, seal, indexSha256: hash(viewBytes) };
}
function original(directory, context, id, expectedHash) {
  const { view, seal } = context;
  const entry = view.index.find(e => e.id === id);
  if (!entry || !/^view\/V\d{6}\.txt$/.test(entry.file)) throw Error("Unknown view ID");
  if (expectedHash !== undefined && expectedHash !== entry.sha256) throw Error("View source changed");
  const text = readFileSync(join(directory, entry.file), "utf8");
  if (hash(text) !== entry.sha256 || seal[entry.file] !== entry.sha256) throw Error("View integrity mismatch");
  return { entry, text };
}
function pageFrom({ entry, text }, offset, limit, strictBudget = false) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000)
    throw Error("Invalid bounded read offset/limit");
  if (offset > text.length || offset && /[\uDC00-\uDFFF]/.test(text[offset]) && /[\uD800-\uDBFF]/.test(text[offset - 1]))
    throw Error("Invalid text offset");
  let end = Math.min(text.length, offset + limit);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  if (!strictBudget && end === offset && offset < text.length) end = Math.min(text.length, offset + 2);
  // Expose only the source-text spans actually displayed on this page. Labels
  // and field boundaries are not quoteable evidence; these coordinates are not
  // proof that the reviewer loaded other pages or retained a previous read.
  const spans = entry.fields.length ? entry.fields : [{ startUtf16: 0, endUtf16: text.length }];
  const citationSpansUtf16 = spans
    .map(f => [Math.max(offset, f.startUtf16), Math.min(end, f.endUtf16)])
    .filter(([start, finish]) => start < finish);
  return { id: entry.id, sha256: entry.sha256, offsetUtf16: offset, endUtf16: end, totalUtf16: text.length,
    source: { title: entry.title, readClass: entry.readClass, recordedAt: entry.at ?? null,
      role: entry.role ?? null, threadId: entry.threadId ?? null, turnId: entry.turnId ?? null },
    citationSpansUtf16,
    complete: end === text.length, nextOffset: end === text.length ? null : end, text: text.slice(offset, end) };
}
export function readReviewPage(directory, id, offset = 0, limit = 12000) {
  return pageFrom(original(directory, openIndex(directory), id), offset, limit);
}

// Explicitly selected whole semantic documents, in requested order. This is
// mechanical pagination, not automatic relevance selection or a read receipt.
export function readReviewBatch(directory, requests, budget = 24000) {
  if (!Number.isSafeInteger(budget) || budget < 2 || budget > 24000) throw Error("Invalid batch budget");
  if (!Array.isArray(requests) || !requests.length || requests.length > 8) throw Error("Select 1..8 documents");
  const context = openIndex(directory), results = [], next = [];
  let remaining = budget;
  for (const request of requests) {
    try {
      if (!request || typeof request.id !== "string"
        || Object.keys(request).some(k => !["id", "offset", "sha256"].includes(k)))
        throw Error("Invalid document selection");
      const source = original(directory, context, request.id, request.sha256);
      const offset = request.offset ?? 0;
      // Validate even a deferred selection. No error is hidden behind a full budget.
      const page = pageFrom(source, offset, Math.max(1, remaining), true);
      if (!remaining) {
        results.push({ id: request.id, status: "deferred", sha256: source.entry.sha256 });
        next.push({ id: request.id, offset, sha256: source.entry.sha256 });
        continue;
      }
      remaining -= page.text.length;
      results.push({ status: page.text.length || page.complete ? "read" : "deferred", ...page });
      if (!page.complete) next.push({ id: page.id, offset: page.nextOffset, sha256: page.sha256 });
    } catch (error) {
      results.push({ id: request?.id ?? null, status: "error", error: error.message });
    }
  }
  return { indexSha256: context.indexSha256, budgetUtf16: budget, textUtf16: budget - remaining, results, next };
}

export function listReviewDocuments(directory, options = {}) {
  const { offset = 0, limit = 8, role, threadId, turnId, readClass, indexSha256 } = options;
  if (Object.keys(options).some(k => !["offset", "limit", "role", "threadId", "turnId", "readClass", "indexSha256"].includes(k))
    || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12)
    throw Error("Invalid catalog selection");
  const context = openIndex(directory);
  if (indexSha256 !== undefined && indexSha256 !== context.indexSha256) throw Error("View index changed");
  const selected = context.view.index.filter(e => Object.entries({ role, threadId, turnId, readClass })
    .every(([key, value]) => value === undefined || e[key] === value));
  if (offset > selected.length) throw Error("Invalid catalog offset");
  const end = Math.min(selected.length, offset + limit);
  const items = selected.slice(offset, end).map(e => {
    const { text } = original(directory, context, e.id);
    const field = e.fields.find(f => /\/(command|text|body)$/.test(f.pointer)) ?? e.fields[0];
    const start = field?.startUtf16 ?? 0, finish = field?.endUtf16 ?? text.length;
    let excerptEnd = Math.min(finish, start + 160);
    if (/[\uD800-\uDBFF]/.test(text[excerptEnd - 1] ?? "")) excerptEnd--;
    return { id: e.id, title: e.title, readClass: e.readClass, role: e.role ?? null,
      threadId: e.threadId ?? null, turnId: e.turnId ?? null, recordedAt: e.at ?? null,
      updatedAt: null, sha256: e.sha256, utf8: e.utf8, utf16: text.length,
      fieldCount: e.fields.length,
      excerpt: { kind: "literal-source-excerpt", pointer: field?.pointer ?? null,
        startUtf16: start, endUtf16: excerptEnd, text: text.slice(start, excerptEnd) } };
  });
  return { indexSha256: context.indexSha256, items, total: selected.length, complete: end === selected.length,
    next: end === selected.length ? null : { ...options, offset: end, limit, indexSha256: context.indexSha256 } };
}

function printPage(page) {
  const { text, ...metadata } = page;
  process.stdout.write(JSON.stringify(metadata) + "\n");
  if (text !== undefined) process.stdout.write(text);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = dirname(fileURLToPath(import.meta.url));
  if (process.argv[2] === "--catalog") {
    if (process.argv.length > 4) throw Error("Use --catalog [JSON selection]");
    process.stdout.write(JSON.stringify(listReviewDocuments(directory, JSON.parse(process.argv[3] ?? "{}"))) + "\n");
  } else if (process.argv[2] === "--batch") {
    if (process.argv.length < 4 || process.argv.length > 5) throw Error("Use --batch JSON-selections [text-budget]");
    const batch = readReviewBatch(directory, JSON.parse(process.argv[3]), Number(process.argv[4] ?? 24000));
    process.stdout.write(JSON.stringify({ indexSha256: batch.indexSha256, budgetUtf16: batch.budgetUtf16,
      textUtf16: batch.textUtf16, next: batch.next }) + "\n");
    for (const page of batch.results) { printPage(page); process.stdout.write("\n"); }
    if (batch.results.some(p => p.status === "error")) process.exitCode = 1;
  } else {
    if (process.argv.length < 3 || process.argv.length > 4) throw Error("Use node ./read.mjs V000001 [offset,limit], --catalog or --batch");
    const range = process.argv[3] ?? "0,12000";
    if (!/^\d+,\d+$/.test(range)) throw Error("Expected offset,limit");
    const [offset, limit] = range.split(",").map(Number);
    printPage(readReviewPage(directory, process.argv[2], offset, limit));
  }
}
