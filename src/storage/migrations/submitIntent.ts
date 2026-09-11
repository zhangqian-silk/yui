import type Database from "better-sqlite3";

/**
 * WIRING PLACEHOLDER — owned by Requirement A (intent-worker), not by this
 * WorkItem.
 *
 * The authoritative implementation lives on branch
 * `yui/task-32-8739d2e9/work-item-1` (src/storage/migrations/submitIntent.ts).
 * It backfills exactly one `task.planning-entered` event for each Draft that has
 * a legitimate historical planning submission (an unaddressed user/operator
 * message with `wakePolicy !== "none"`), dated to that message's `createdAt`,
 * touching ONLY the `events` table and the `id_sequences` event high-water. It
 * is independent, deterministic and idempotent.
 *
 * This file exists so WorkItem B (the 18->19 Home migration) can hard-import and
 * CALL `migrateSubmitIntent(db)` as the LAST step of the single v19 `migrateData`
 * transaction, keeping this branch's build green while A's file lives on a
 * separate branch. It is a NO-OP on purpose: a silent dependency-injection
 * default could let the submit-intent backfill be skipped forever after merge,
 * whereas a direct import forces the real implementation to be present.
 *
 * MERGE RESOLUTION (Leader): resolve the add/add on this path by taking
 * work-item-1's HEAD of this file verbatim. The export name and signature are
 * frozen — `migrateSubmitIntent(db: Database.Database): void` — so B's import and
 * call site need no change. Do NOT keep this placeholder body after merge.
 */
export function migrateSubmitIntent(_db: Database.Database): void {
  // Intentionally empty. Replaced at merge by the Requirement A implementation.
}
