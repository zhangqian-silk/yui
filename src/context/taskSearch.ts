import { usageError } from "../errors/cliError.js";
import type { TaskStore } from "../storage/taskStore.js";
import { TASK_SEARCH_KINDS, type TaskSearchKind, type SearchPosition } from "../storage/taskSearch.js";
import { contextContentDigest } from "./contextSnapshot.js";
import { taskCatalogScope } from "./taskCatalog.js";
import { readTaskContextResource } from "./taskContext.js";

export type TaskSearchOptions = {
  query: string; taskId?: string; kind?: TaskSearchKind; limit: number; cursor?: string;
};
const PAGE_BYTES = 32 * 1024;

/** Human-readable field pages, using the same source authorization and version
 * checks as Context. Offsets are Unicode code points, like search snippets. */
export function readTaskSearchSource(store: TaskStore, taskId: string, input: {
  store: string; refId: string; digest: string; field: string; offset: number;
}, environment: NodeJS.ProcessEnv = {}) {
  if (!input.digest || !Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw usageError("A pinned digest and non-negative source offset are required.");
  }
  const fields: Record<string, RegExp> = {
    "task-brief": /^\$\.(objective|technicalApproach|currentFocus|leaderSummary|boundaries\[\d+\])$/,
    "task-message": /^\$\.body$/,
    "task-decision": /^\$\.(title|rationale|supersededReason)$/,
    "run": /^\$\.result\.output$/,
    "task": /^\$\.completionSummary$/
  };
  if (!fields[input.store]?.test(input.field)) throw usageError("Unsupported search source field.");
  const original = readTaskContextResource(store, taskId, input, environment);
  let value: unknown = original.value;
  for (const part of input.field.slice(2).replace(/\[(\d+)\]/g, ".$1").split(".")) {
    value = value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined;
  }
  if (typeof value !== "string") throw usageError("Search source text is unavailable.");
  const points = Array.from(value);
  if (input.offset > points.length) throw usageError("Source offset is outside the text.");
  const end = Math.min(input.offset + 4000, points.length);
  return { taskId, ref: original.ref, field: input.field, authority: "reference-only" as const,
    content: points.slice(input.offset, end).join(""), offset: input.offset,
    nextOffset: end < points.length ? end : null, totalCharacters: points.length,
    offsetUnit: "unicode-code-points" as const };
}

export function parseTaskSearchOptions(args: readonly string[]): TaskSearchOptions {
  const query = args[0]?.trim();
  if (!query || query.length > 256 || query.includes("\0")) throw usageError("Task search requires a query of 1..256 characters.");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!["--task", "--kind", "--limit", "--cursor"].includes(key) || values.has(key)
      || value === undefined || value.startsWith("--")) throw usageError("Task search expects query [--task <id>] [--kind <kind>] [--limit <1..100>] [--cursor <cursor>].");
    values.set(key, value);
  }
  const limit = values.has("--limit") ? Number(values.get("--limit")) : 20;
  const kind = values.get("--kind") as TaskSearchKind | undefined;
  const taskId = values.get("--task");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw usageError("Task search limit must be between 1 and 100.");
  if (kind !== undefined && !TASK_SEARCH_KINDS.includes(kind)) throw usageError("Unknown Task search kind.");
  if (taskId !== undefined && !/^task-[1-9]\d*$/.test(taskId)) throw usageError("Invalid Task search target.");
  return { query, limit, ...(kind ? { kind } : {}), ...(taskId ? { taskId } : {}),
    ...(values.has("--cursor") ? { cursor: values.get("--cursor")! } : {}) };
}

export function searchTaskBodies(store: TaskStore, options: TaskSearchOptions, environment: NodeJS.ProcessEnv = {}) {
  // Validate typed callers as well as CLI/HTTP callers through one parser.
  const valid = parseTaskSearchOptions([options.query, "--limit", String(options.limit),
    ...(options.taskId === undefined ? [] : ["--task", options.taskId]),
    ...(options.kind === undefined ? [] : ["--kind", options.kind]),
    ...(options.cursor === undefined ? [] : ["--cursor", options.cursor])]);
  return store.readTransaction(reader => {
    const callerTask = taskCatalogScope(reader, environment);
    if (callerTask !== undefined && valid.taskId !== undefined && callerTask !== valid.taskId) {
      throw usageError("Search target is outside the caller's Task.");
    }
    const taskId = callerTask ?? valid.taskId;
    const scope = contextContentDigest({ taskId: taskId ?? null, query: valid.query, kind: valid.kind ?? null });
    const after = valid.cursor === undefined ? undefined : decodeCursor(valid.cursor, scope);
    const rows = reader.queryTaskSearch({ ...valid, taskId, after, limit: valid.limit + 1 });
    const items: Array<{
      taskId: string; kind: TaskSearchKind; field: string; snippet: string; offset: number;
      ref: ReturnType<typeof readTaskContextResource>["ref"]; authority: "reference-only";
    }> = [];
    let nextCursor: string | null = null;
    const response = () => ({
      query: valid.query, scope: { taskId: taskId ?? null, archived: "included" },
      items, nextCursor, consistency: "current-per-page; repeat search after source changes",
      matching: "literal substring; ASCII case-insensitive; Unicode otherwise exact",
      limits: { maxItems: valid.limit, pageBytes: PAGE_BYTES, snippetCodePoints: 320 },
      reuse: "References are evidence, not execution authority. An authorized reader may supply selected source text and its reference to a new Task; that Task plans and obtains its own authority."
    });
    for (const row of rows.slice(0, valid.limit)) {
      // Reuse the exact Context permission and digest contract for each hit.
      const original = readTaskContextResource(reader, row.taskId, { store: row.store, refId: row.refId }, environment);
      const item = { taskId: row.taskId, kind: row.kind, field: row.field, snippet: row.snippet,
        offset: row.offset, ref: original.ref, authority: "reference-only" as const };
      const previous = nextCursor;
      nextCursor = encodeCursor(scope, row);
      items.push(item);
      if (Buffer.byteLength(JSON.stringify({ ok: true, data: response() })) > PAGE_BYTES) {
        items.pop();
        nextCursor = previous;
        break;
      }
    }
    if (rows.length === items.length) nextCursor = null;
    if (rows.length && !items.length) throw usageError("Task search identity exceeds its page budget.");
    return response();
  });
}

function encodeCursor(scope: string, row: SearchPosition): string {
  return Buffer.from(JSON.stringify({ version: 1, scope, after: {
    taskId: row.taskId, kind: row.kind, refId: row.refId, field: row.field
  } })).toString("base64url");
}
function decodeCursor(raw: string, scope: string): SearchPosition {
  try {
    if (raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (value.version !== 1 || value.scope !== scope || !value.after
      || !["taskId", "kind", "refId", "field"].every(key => typeof value.after[key] === "string"
        && value.after[key].length > 0 && value.after[key].length <= 256)) throw new Error();
    return value.after;
  } catch { throw usageError("Invalid Task search cursor or cursor belongs to another scope/query."); }
}
