// Public DEVELOPMENT corpus. Never use this catalogue, its history or near
// variants as an unknown holdout. Contracts precede the constructed candidates.
const entry = (id, family, perspectives, contract, files, index, gold, repaired = files) => ({
  id, family, split: "development", perspectives, contract, files, index, gold, repaired
});
const root = (id, trigger, violation, impact) => ({ id, trigger, violation, impact });

export const cases = [
  entry("E01", "interval-selection", ["user-path", "contract"],
    "select(rows, start, end) returns rows with start <= row.time < end, in input order. "
    + "Inputs have finite numeric times and start <= end. Empty intervals return []. "
    + "No time-zone conversion, sorting or input mutation is required.",
    { "main.mjs": "export const select = (rows, start, end) => rows.filter(r => r.time >= start && r.time <= end);\n" },
    "Entry: main.mjs/select. The caller supplies the interval and consumes the returned rows.",
    [root("upper-bound", "A row equals end", "The end boundary is exclusive", "Extra records are returned")],
    { "main.mjs": "export const select = (rows, start, end) => rows.filter(r => r.time >= start && r.time < end);\n" }),
  entry("E02", "chunk-confirmation", ["failure", "state"],
    "create(store) returns put(id, bytes) and used(). Inputs are sequential; bytes is a nonnegative integer. "
    + "store.write(id, bytes) either persists then resolves or rejects without persistence. "
    + "put must reject when persistence fails, and used counts successfully stored unique IDs exactly once. "
    + "Retries of a successful ID use the same size and have no extra effects. No crash or concurrency guarantee.",
    { "main.mjs": `export function create(store) {
  let total = 0;
  return {
    async put(id, bytes) {
      try { await store.write(id, bytes); } catch {}
      total += bytes;
      return { ok: true };
    },
    used: () => total
  };
}\n` },
    "Entry: main.mjs/create. put calls the supplied persistence adapter; used exposes committed usage. "
    + "No execution evidence is supplied; inspect both the adapter contract and caller-visible results.",
    [root("failed-ack", "store.write rejects", "A failed persistence must reject put", "False success and inflated usage"),
      root("duplicate-usage", "Retry a successfully stored ID", "Count unique successful IDs once", "Capacity is overcounted")],
    { "main.mjs": `export function create(store) {
  let total = 0;
  const completed = new Set();
  return {
    async put(id, bytes) {
      if (!completed.has(id)) {
        await store.write(id, bytes);
        completed.add(id);
        total += bytes;
      }
      return { ok: true };
    },
    used: () => total
  };
}\n` }),
  entry("E03", "opaque-pagination", ["contract", "verification"],
    "collect(fetchPage) returns all page items in order. The first request passes null. "
    + "fetchPage returns {items, nextCursor}; nextCursor is an opaque string or null. "
    + "Pass strings unchanged and stop only at null. A rejected request rejects collect without partial success. "
    + "Pages are finite; retries and concurrent mutations are out of scope. "
    + "page.mjs demonstrates the server contract; numeric cursors are not promised.",
    { "main.mjs": `export async function collect(fetchPage) {
  const result = [];
  let cursor = null;
  do {
    const page = await fetchPage(cursor);
    result.push(...page.items);
    cursor = page.nextCursor === null ? null : Number(page.nextCursor);
  } while (cursor !== null);
  return result;
}\n`,
    "page.mjs": `export async function fetchPage(cursor) {
  if (cursor === null) return { items: ["a"], nextCursor: "part/+b" };
  if (cursor === "part/+b") return { items: ["b"], nextCursor: null };
  throw new Error("Unknown cursor");
}\n` },
    "Path: caller -> main.mjs/collect -> await page.mjs/fetchPage(cursor) -> consume items/cursor "
    + "-> next request or return. No persistent commit. Inspect the consumer's next request after the wait "
    + "against the producer's input contract; a substitute must preserve that domain. "
    + "A request error rejects collection instead of returning accumulated items. "
    + "Retries/concurrent mutations are non-goals. No execution results are supplied.",
    [root("cursor-coercion", "A nonnumeric string cursor", "Pass opaque cursors unchanged", "Collection fails after the first page")]),
  entry("E04", "reservation-lifecycle", ["state", "user-path"],
    "create(capacity) exposes reserve(id), cancel(id), available(). IDs are unique for new reservations; "
    + "reserve returns false if already known or full. Only active reservations use capacity. "
    + "cancel of unknown/cancelled IDs has no effect. Sequential in-memory calls only.",
    { "main.mjs": `export function create(capacity) {
  let free = capacity;
  const states = new Map();
  return {
    reserve(id) {
      if (free <= 0 || states.has(id)) return false;
      states.set(id, "active"); free--; return true;
    },
    cancel(id) { if (states.has(id)) { states.set(id, "cancelled"); free++; } },
    available: () => free
  };
}\n` },
    "Entry: main.mjs/create. reserve/cancel share the states map and free counter; available is caller-visible.",
    [root("double-release", "Cancel the same reservation twice", "Only active reservations release capacity", "Overbooking")]),
  entry("E05", "batch-correspondence", ["failure", "data"],
    "validate(rows) returns one {id, ok} for every input, preserving order and identity. "
    + "A row is valid exactly when its value is a finite number. Inputs have unique string IDs. "
    + "Partial failure is allowed; there is no all-or-nothing rollback.",
    { "main.mjs": `export function validate(rows) {
  const valid = rows.filter(row => Number.isFinite(row.value));
  return rows.map((row, i) => ({ id: row.id, ok: valid[i] !== undefined }));
}\n` },
    "Entry: main.mjs/validate. Input identities and the positional output are the contract surface.",
    [root("positional-rejoin", "Valid, invalid, valid input", "Each status belongs to its original row", "Wrong acceptance/rejection")],
    { "main.mjs": "export const validate = rows => rows.map(row => ({ id: row.id, ok: Number.isFinite(row.value) }));\n" }),
  entry("E06", "export-authorization", ["authorization", "failure"],
    "exportDoc(user, doc, files) may write only if user.tenant === doc.tenant and doc.readers includes user.id. "
    + "Denied calls return {status:403} and must not call files.write. Allowed calls await files.write(doc.id, doc.body) "
    + "and return {status:200}. files.write is the only output effect and rejects on failure. No admin override.",
    { "main.mjs": `export async function exportDoc(user, doc, files) {
  await files.write(doc.id, doc.body);
  if (user.tenant !== doc.tenant || !doc.readers.includes(user.id)) return { status: 403 };
  return { status: 200 };
}\n` },
    "Entry: main.mjs/exportDoc. Follow the user/document decision and the files adapter effect, "
    + "not just the response status. Adapter failures propagate.",
    [root("write-before-auth", "Denied tenant or reader request", "Denied calls have no write effect", "Unauthorized document output")],
    { "main.mjs": `export async function exportDoc(user, doc, files) {
  if (user.tenant !== doc.tenant || !doc.readers.includes(user.id)) return { status: 403 };
  await files.write(doc.id, doc.body);
  return { status: 200 };
}\n` }),
  entry("E07", "access-ordered-cache", ["state", "non-goals"],
    "create(capacity) is a bounded LRU cache with positive integer capacity. get returns undefined on miss; "
    + "a hit becomes most recently used. set inserts/updates and makes the key most recent. "
    + "Evict the least recently accessed key on overflow. No FIFO or pure-read guarantee.",
    { "main.mjs": `export function create(capacity) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      entries.delete(key); entries.set(key, value); return value;
    },
    set(key, value) {
      entries.delete(key); entries.set(key, value);
      if (entries.size > capacity) entries.delete(entries.keys().next().value);
    }
  };
}\n` },
    "Entry: main.mjs/create. get and set operate on the same ordered collection. "
    + "Compare observed behavior to the stated replacement policy.",
    []),
  entry("E08", "progressive-display", ["failure", "non-goals"],
    "view(entries) receives unique IDs with status pending, success or failure. "
    + "Return {visible, errors, settled}: visible is successful values in order, errors is failed IDs in order, "
    + "settled is true exactly when none are pending (including an empty batch). "
    + "Successes may be shown before settlement; no atomic display/rollback guarantee.",
    { "main.mjs": `export function view(entries) {
  return {
    visible: entries.filter(e => e.status === "success").map(e => e.value),
    errors: entries.filter(e => e.status === "failure").map(e => e.id),
    settled: entries.every(e => e.status !== "pending")
  };
}\n` },
    "Entry: main.mjs/view. Visible values, errors and settled are separate observations; "
    + "consider callers during and after completion.",
    [])
];

// Keep the unchanged producer byte-for-byte identical in the repair control.
cases[2].repaired = { ...cases[2].files,
  "main.mjs": cases[2].files["main.mjs"].replace("Number(page.nextCursor)", "page.nextCursor") };
cases[3].repaired = { "main.mjs": cases[3].files["main.mjs"]
  .replace("states.has(id)) { states.set", 'states.get(id) === "active") { states.set') };

export function getCase(id) {
  const value = cases.find(c => c.id === id);
  if (!value) throw new Error(`Unknown development case: ${id}`);
  return value;
}
