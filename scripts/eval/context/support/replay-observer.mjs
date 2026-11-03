// Independent observer. It has no mutation/dispatch methods and no model report input.
import { readdirSync, lstatSync, readFileSync, readlinkSync, watch } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { judgeAnalysis } from "./role-boundary.mjs";
const hash = value => createHash("sha256").update(value).digest("hex");

// Frozen engineering exclusions, NOT a business-family allowlist. Full originals
// for these tables remain in raw snapshots and are separately used for ACK/run checks.
export const engineeringTables = [
  "active_turns", "context_snapshots", "events", "global_role_session_sets",
  "global_sequences", "home_meta", "id_sequences", "mailboxes", "outbox",
  "role_session_sets", "runtime_session_candidates", "session_owners",
  "task_projections", "task_wakes", "telemetry", "telemetry_aggregate", "turns",
];
export class ReplayObserver {
  static async create(product, fixture) {
    const { default: Database } = await import(pathToFileURL(join(product, "dist/sqlite/driver.js")).href);
    return new ReplayObserver(Database, fixture);
  }
  constructor(Database, fixture) {
    this.Database = Database; this.fixture = fixture; this.fileEvents = []; this.errors = [];
    this.boundaryWatchers = [];
    // Subscribe before any subject action. Do not follow links outside the owned root.
    this.watcher = watch(fixture.root, { recursive: true }, (event, path) => {
      if (this.fileEvents.length >= 50000) { this.errors.push("watch-journal-limit"); return; }
      this.fileEvents.push({ at: new Date().toISOString(), event, path: String(path) });
    });
    this.watcher.on("error", error => this.errors.push(String(error)));
  }
  readState() {
    const db = new this.Database(join(this.fixture.home, "yui.db"), { readonly: true, fileMustExist: true });
    try {
      db.exec("BEGIN");
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const result = {};
      for (const { name } of tables) {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
        if (rows.length > 10000) throw Error(`Unbounded table: ${name}`);
        result[name] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      db.exec("COMMIT");
      return result;
    } finally { db.close(); }
  }
  files() {
    const result = {};
    const walk = directory => {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), key = relative(this.fixture.root, path);
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) result[key] = { symlink: readlinkSync(path) };
        else if (stat.isDirectory()) walk(path);
        else if (stat.isFile()) {
          if (stat.size > 16 * 1024 * 1024) { this.errors.push(`file-size-limit:${key}`); continue; }
          result[key] = { bytes: stat.size, sha256: hash(readFileSync(path)) };
        }
      }
    };
    try { walk(this.fixture.root); } catch (error) { this.errors.push(`file-inventory:${error}`); }
    return result;
  }
  capture() { return { at: new Date().toISOString(), state: this.readState(), files: this.files() }; }
  begin() {
    // Recursive fs.watch can miss nested directories created while its event
    // loop is busy with setup CLI calls. Arm existing directories synchronously
    // at the subject barrier too. Future directories/overflow are still not a
    // lossless journal, so journal completeness remains false.
    const arm = directory => {
      if (this.boundaryWatchers.length >= 4096) throw Error("boundary-watch-limit");
      const watcher = watch(directory, (event, name) => {
        if (this.fileEvents.length >= 50000) {
          if (!this.errors.includes("watch-journal-limit")) this.errors.push("watch-journal-limit");
          return;
        }
        this.fileEvents.push({ at: new Date().toISOString(), event,
          path: relative(this.fixture.root, join(directory, String(name))), source: "boundary-directory" });
      });
      watcher.on("error", error => this.errors.push(String(error)));
      this.boundaryWatchers.push(watcher);
      for (const name of readdirSync(directory)) {
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isDirectory() && !stat.isSymbolicLink()) arm(path);
      }
    };
    try { arm(this.fixture.root); } catch (error) { this.errors.push(`boundary-watch:${error}`); }
    this.before = this.capture(); this.startIndex = this.fileEvents.length; return this.before;
  }
  businessFile(path) {
    return /^state\/(?:task-artifacts|job-artifacts|projects|workspaces)\//.test(path)
      || /^state\/runtime\/task-runtimes\/planning\//.test(path);
  }
  stateProjection(raw) {
    const projection = {};
    for (const [table, rows] of Object.entries(raw)) {
      if (engineeringTables.includes(table)) continue;
      // Input body/provenance are checked; only the required transport receipt
      // fields are excluded. Full receipt originals remain in raw snapshots.
      const values = rows.map(row => {
        const value = { ...row };
        if (table === "messages" || table === "global_role_messages") {
          const body = JSON.parse(value.payload);
          for (const key of ["inbox", "delivery", "notDelivered"]) delete body[key];
          value.payload = JSON.stringify(body);
        }
        return value;
      });
      projection[`state/${table}`] = values;
    }
    return projection;
  }
  finish() {
    const after = this.capture(), before = this.before;
    if (!before) throw Error("Missing observation boundary");
    const project = snapshot => ({
      ...this.stateProjection(snapshot.state),
      ...Object.fromEntries(Object.entries(snapshot.files).filter(([key]) => this.businessFile(key))
        .map(([key, value]) => [`file/${key}`, value])),
    });
    const oldEvents = new Set(before.state.events.map(event => `${event.task_id}/${event.event_id}`));
    const journal = after.state.events.filter(event => !oldEvents.has(`${event.task_id}/${event.event_id}`));
    const businessEvents = journal.filter(event => /^(?:brief\.updated|decision\.|artifact\.|task\.updated|work\.|publication\.)/.test(event.type));
    const fileJournal = this.fileEvents.slice(this.startIndex);
    const effects = [
      ...businessEvents.map(event => ({ id: `${event.task_id}/${event.event_id}`,
        key: `event/${event.type}`, evidence: event })),
      ...fileJournal.filter(event => this.businessFile(event.path))
        .map((event, index) => ({ id: `fs-${index}`, key: `file/${event.path}`, evidence: event })),
    ];
    const coverage = { state: this.errors.length === 0, files: this.errors.length === 0,
      // SQL polling/event journals do not prove arbitrary unjournaled write/revert
      // absence; fs.watch is not lossless after overflow/process exit. Never fake it.
      journal: false };
    return { before, after, journal, fileJournal, effects, errors: this.errors,
      engineeringTables, strictAnalysis: judgeAnalysis({
        before: project(before), after: project(after), effects, coverage }),
      observationLimits: [
        "Every SQLite table and endpoint file inventoried; full raw transport excluded only from business scoring.",
        "Independent append-only product events and filesystem watch catch observed writes/reverts.",
        "Unjournaled SQL write-and-restore between samples and filesystem watch loss remain unknown; journal completeness false.",
        "No observation outside the synthetic fixture root; shared/real Homes are not inspected.",
      ] };
  }
  close() {
    this.watcher.close();
    for (const watcher of this.boundaryWatchers) watcher.close();
  }
}

export function checkExactReceipts(state, { role, task, ids }) {
  const rows = role === "operator" ? state.global_role_messages.filter(row => row.name === role)
    : state.task_wakes.filter(row => row.task_id === task);
  return ids.map(id => {
    const row = rows.find(row => (role === "operator" ? row.message_id : row.wake_id) === id);
    const value = row && JSON.parse(row.payload), inbox = value?.inbox;
    const actorMatches = actor => actor?.roleName === role && (task
      ? actor.scope === "task" && actor.taskId === task
      : actor.scope === "global");
    return { id, present: !!row, claim: inbox?.claim ?? null, ack: inbox?.ack ?? null,
      exact: !!inbox?.claim?.requestId && !!inbox?.ack?.requestId && !!inbox?.ack?.reason
        && actorMatches(inbox.claim.actor) && actorMatches(inbox.ack.actor) };
  });
}
export function changedFamilies(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !isDeepStrictEqual(before[key], after[key]));
}
