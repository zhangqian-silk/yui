import type Database from "better-sqlite3";

export const TASK_SEARCH_KINDS = ["brief", "message", "decision", "result", "completion"] as const;
export type TaskSearchKind = typeof TASK_SEARCH_KINDS[number];
export type SearchPosition = { taskId: string; kind: string; refId: string; field: string };
export type TaskSearchQuery = {
  query: string; taskId?: string; kind?: TaskSearchKind; limit: number;
  after?: SearchPosition;
};
export type TaskSearchRow = SearchPosition & {
  kind: TaskSearchKind; store: string; snippet: string; offset: number;
};

/** A read-only view of authoritative JSON, not a persisted index. Apply Task
 * scope before body matching and return only page-sized snippets/identities.
 * No derived state needs rebuilding when a source changes or is removed. */
export function queryTaskSearch(db: Database.Database, input: TaskSearchQuery): TaskSearchRow[] {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 101) {
    throw new Error("Task search query exceeds its bounded contract.");
  }
  const branches = [
    `SELECT task_id AS taskId, 'brief' AS kind, 'task-brief' AS store, task_id AS refId,
      j.fullkey AS field, j.value AS body FROM task_records, json_tree(brief) j
      WHERE j.type = 'text' AND (j.key IN ('objective','technicalApproach','currentFocus','leaderSummary')
        OR j.path = '$.boundaries')`,
    `SELECT task_id, 'message', 'task-message', message_id, '$.body', json_extract(payload, '$.body') FROM messages`,
    `SELECT task_id, 'decision', 'task-decision', decision_id, j.fullkey, j.value
      FROM decisions, json_each(payload) j WHERE j.key IN ('title','rationale','supersededReason') AND j.type = 'text'`,
    `SELECT task_id, 'result', 'run', turn_id, '$.result.output', json_extract(payload, '$.result.output') FROM turns`,
    `SELECT task_id, 'completion', 'task', task_id, '$.completionSummary',
      json_extract(payload, '$.completionSummary') FROM task_records`
  ];
  const params = {
    query: input.query, taskId: input.taskId ?? null, kind: input.kind ?? null, limit: input.limit,
    afterTask: input.after?.taskId ?? "", afterKind: input.after?.kind ?? "",
    afterRef: input.after?.refId ?? "", afterField: input.after?.field ?? ""
  };
  // SQLite lower() folds ASCII only; other Unicode is matched literally.
  // Positions and substr use Unicode code points, not UTF-16 units or bytes.
  return db.prepare(`WITH sources AS (${branches.join(" UNION ALL ")}),
    matches AS (SELECT *, instr(lower(body), lower(@query)) AS hit FROM sources
      WHERE (@taskId IS NULL OR taskId = @taskId) AND (@kind IS NULL OR kind = @kind)
        AND (taskId, kind, refId, field) > (@afterTask, @afterKind, @afterRef, @afterField))
    SELECT taskId, kind, store, refId, field, max(0, hit - 81) AS offset,
      substr(body, max(1, hit - 80), 320) AS snippet
    FROM matches WHERE hit > 0 ORDER BY taskId, kind, refId, field LIMIT @limit`
  ).all(params) as TaskSearchRow[];
}
