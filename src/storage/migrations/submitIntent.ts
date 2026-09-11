import type Database from "better-sqlite3";
import { createTaskEvent } from "../../event/taskEvent.js";

/**
 * Storage 18 -> 19 data step for task-32 Requirement A (submit intent & Draft
 * auto-routing).
 *
 * This helper is INDEPENDENT, deterministic and idempotent. The unified 18 -> 19
 * migration owned by the artifacts WorkItem REGISTERS it (as its `migrateData`)
 * and bumps `CURRENT_STORAGE_VERSION`; this module neither registers a second
 * migration nor changes any schema. The new Message `intent` field is optional
 * JSON inside `messages.payload`, and an absent value already reads as `discuss`
 * (never `develop`), so historical Messages need no rewrite.
 *
 * The one fact old data cannot express is "this Draft already entered planning".
 * Before Requirement A a Leader-waking user/operator submission on a Draft WAS
 * the planning discussion, but it left no `task.planning-entered` fact because
 * that event type did not exist. After the upgrade `develop` auto-activates an
 * *unplanned* Draft; without this step a Draft that was mid-discussion would be
 * mis-read as unplanned and snatched into auto-activation (task-32 §2.2, §4).
 *
 * So for every Draft that received at least one legitimate historical planning
 * submission this appends exactly one `task.planning-entered` event, which makes
 * {@link draftHasEnteredPlanning} derive `true` and routes a later develop to
 * manual activation. A qualifying submission is an *unaddressed* user/operator
 * Message that was not save-only (`wakePolicy !== "none"`) — byte-for-byte the
 * same shape the new discuss path routes through the shared submission service.
 *
 * This is deliberately the conservative direction: it can only ever make develop
 * MORE cautious, never activate a Draft it should not. Save-only Messages (old
 * `wakePolicy === "none"`, the shape `record` now names) are excluded, so a Draft
 * that only ever recorded context stays legitimately unplanned and its first
 * develop may still auto-activate. Non-Draft Tasks are skipped because
 * {@link draftHasEnteredPlanning} answers only about Drafts, and Activation
 * requests are left untouched — a legacy request's absent `origin` is the
 * truthful marker that it stays behind explicit activation.
 */
export function migrateSubmitIntent(db: Database.Database): void {
  const drafts = db.prepare(
    "SELECT task_id FROM tasks_catalog WHERE status = 'draft'"
  ).all() as { task_id: string }[];
  if (drafts.length === 0) return;

  const listMessages = db.prepare(
    "SELECT payload FROM messages WHERE task_id = ? ORDER BY seq ASC"
  );
  const listEventRows = db.prepare(
    "SELECT event_id, type FROM events WHERE task_id = ?"
  );
  const readHighWater = db.prepare(
    "SELECT high_water FROM id_sequences WHERE task_id = ? AND kind = 'event'"
  );
  // Advance the per-Task event high-water to exactly the id we just consumed, so
  // the runtime keeps allocating strictly above every migrated event (mirrors
  // sqliteStore's id_sequences bookkeeping).
  const upsertHighWater = db.prepare(
    `INSERT INTO id_sequences (task_id, kind, high_water) VALUES (?, 'event', ?)
     ON CONFLICT(task_id, kind) DO UPDATE SET high_water = ?`
  );
  const insertEvent = db.prepare(
    "INSERT INTO events (task_id, event_id, type, occurred_at, payload) VALUES (?, ?, ?, ?, ?)"
  );

  for (const { task_id: taskId } of drafts) {
    const eventRows = listEventRows.all(taskId) as { event_id: string; type: string }[];
    // Idempotent: a Draft that already carries the fact (from a prior run of this
    // migration, or from a real runtime planning entry) is left untouched.
    if (eventRows.some((row) => row.type === PLANNING_ENTERED_EVENT_TYPE)) continue;
    const entry = firstPlanningSubmission(listMessages.all(taskId) as { payload: string }[]);
    if (entry === undefined) continue;

    // Allocate the next event id from the greater of the recorded high-water and
    // the largest event id actually present, so a fixture or historical database
    // whose id_sequences lags the events table can never produce a colliding id.
    const highWater = (readHighWater.get(taskId) as { high_water: number } | undefined)?.high_water ?? 0;
    const maxEventSeq = eventRows.reduce((max, row) => Math.max(max, eventSequence(row.event_id)), 0);
    const seq = Math.max(highWater, maxEventSeq) + 1;

    // Build through the shared constructor so a migrated event is byte-identical
    // in shape to one the shared submission service writes at runtime, and dated
    // to the historical submission rather than the wall-clock upgrade moment.
    const event = createTaskEvent(
      `event-${seq}`,
      taskId,
      PLANNING_ENTERED_EVENT_TYPE,
      { messageId: entry.id, intent: "discuss", derivedBy: MIGRATION_PROVENANCE },
      new Date(entry.createdAt)
    );
    insertEvent.run(taskId, event.id, event.type, event.createdAt, JSON.stringify(event));
    upsertHighWater.run(taskId, seq, seq);
  }
}

/**
 * The never-compacted event type recording a Draft entered planning. Inlined as a
 * literal rather than imported so this released migration stays frozen against a
 * future runtime rename of the constant; `TASK_PLANNING_ENTERED_EVENT` is the
 * runtime owner, and a tripwire test asserts the two never diverge.
 */
const PLANNING_ENTERED_EVENT_TYPE = "task.planning-entered";

/** Marks the event as reconstructed by this migration, for later audit. */
const MIGRATION_PROVENANCE = "submit-intent-migration";

/**
 * The earliest Message on a Draft that represents a historical planning
 * submission, or `undefined` if the Draft only ever recorded save-only context.
 *
 * A qualifying Message is an unaddressed (`recipient === undefined`) user or
 * operator Message whose wake policy was not `none`. An absent wake policy
 * qualifies: before Requirement A that was the default Leader-waking submission,
 * exactly the shape an omitted intent normalizes to `discuss` today.
 */
function firstPlanningSubmission(
  rows: readonly { payload: string }[]
): Readonly<{ id: string; createdAt: string }> | undefined {
  for (const row of rows) {
    const message = JSON.parse(row.payload) as Readonly<{
      id?: unknown; kind?: unknown; recipient?: unknown;
      wakePolicy?: unknown; createdAt?: unknown;
    }>;
    if (message.kind !== "user" && message.kind !== "operator") continue;
    if (message.recipient !== undefined) continue; // an addressed continuation, not a submission
    if (message.wakePolicy === "none") continue;    // old save-only == record, never planning
    if (typeof message.id !== "string") continue;
    if (typeof message.createdAt !== "string") continue;
    return { id: message.id, createdAt: message.createdAt };
  }
  return undefined;
}

/** The numeric suffix of an `event-<n>` id, or 0 for any unexpected shape. */
function eventSequence(eventId: string): number {
  const match = /^event-(\d+)$/.exec(eventId);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}
