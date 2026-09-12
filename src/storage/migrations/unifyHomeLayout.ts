import type Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Storage 23 -> 24: unify every Yui self-managed path under a single canonical
 * YUI_HOME.
 *
 * Before this migration the managed Git worktrees lived under the user-facing
 * `defaultWorkspace` (`<ws>/worktree`, `<ws>/tasks`) and the provider runtimes
 * under a string-built Home sibling (`<home>.task-runtimes`). This unifies the
 * layout under Home (`<home>/workspaces/{worktree,tasks}`,
 * `<home>/runtime/task-runtimes`) and rewrites the persisted absolute pointers
 * the runtime dereferences as LIVE, without re-cloning Git content or rewriting
 * the path-independent Git ref names.
 *
 * ONLY ONE tree is physically relocated: the managed Git worktree tree, the sole
 * subtree that holds durable, non-regenerable content (committed AND uncommitted
 * work). It is COPIED (never renamed away), content-verified, and atomically
 * published; the original is PRESERVED as the rollback anchor and is never
 * removed by this data step. The regenerable per-Task symlink views and the
 * disposable provider runtimes are NOT copied — their pointers are rewritten and
 * the trees are rebuilt/recreated at the next launch, leaving the old locations
 * inert until an authorized, post-restart cleanup removes them.
 *
 * The pointer rewrite is deliberately SURGICAL, not a table sweep. Only records
 * the runtime dereferences as live launch pointers are touched:
 *
 *   - `managed_workspaces` — the authoritative workspace registry. Workspace
 *     preparation trusts a stored `entry.path` directly, so a stale path is a
 *     hard failure. A dispositioned row is deleted at cleanup, so every
 *     surviving row is live.
 *   - active (`status = 'active'`) `turns` — the AgentRun's live launch cwd. The
 *     actual OS cwd is derived from `run.effective.workspace`, and `validateRun`
 *     binds `run.workspace` to `run.effective.workspace`, so the two are
 *     rewritten together or neither. `.result.systemEvidence.workspaceSnapshot`
 *     is frozen Git evidence and is left byte-for-byte intact.
 *   - `role_session_sets` / `global_role_session_sets` — each live session's
 *     `effective.workspace` in the `sessions` map (a resumable native session's
 *     frozen launch cwd). `history` is terminal evidence and is preserved.
 *   - `review_rounds` — the mirrored ManagedWorkspace while its registry row
 *     still exists, plus each OPEN execution lane's `effective.workspace` and
 *     `workspace.root`. A terminal lane and an orphaned mirror are frozen
 *     evidence and are left untouched.
 *   - `work_items` — each OPEN execution lane inside `executionGroups`. Candidate
 *     snapshots (`work_item_candidates`) are frozen evidence and are preserved.
 *   - `task_roles.workspace` — a live, mutable launch cwd, including a Draft's
 *     planning Role under the old runtime sibling (never self-healed until
 *     activation).
 *   - `task_records.cwd` — self-heals from the registry on the next
 *     `prepareTaskWorkspace`, but is rewritten defensively so no reader observes
 *     a stale cwd between migration and the first preparation pass.
 *
 * Everything else is preserved on purpose. `context_snapshots`, terminal
 * `turns` (with their system evidence), terminal sessions in `history`,
 * `work_item_candidates`, terminal execution lanes, terminal `durable_jobs`,
 * `events` and reports are frozen historical evidence (criterion 2).
 * `resource_registry` is re-discovered from disk. `projects.path` is an
 * external, user-owned checkout.
 *
 * A queued or running `durable_jobs` step runs in a detached process that
 * SURVIVES the Controller quiesce fence, so rewriting a live cwd bound under a
 * relocating root would be an in-flight silent migration (forbidden by
 * criterion 2). Such a job is refused up front rather than rewritten.
 *
 * OFFLINE migration by design. It is applied by the standalone `yui upgrade`
 * mutation boundary AFTER the operator has stopped the Controller, Agent Host,
 * and any execution/Job writers for this Home — it does NOT orchestrate that
 * shutdown, coordinate an online write-stop, or migrate a live Session. Its only
 * runtime precondition is the minimal in-flight-Job conflict check above; a
 * writer the operator failed to stop is out of its contract. On any failure it
 * throws, the upgrade transaction rolls back to its starting version, and the preserved
 * source plus the fenced DB backup are the recovery pair for a manual re-run — it
 * does NOT claim automatic idempotent recovery or take over partial residue with
 * a manifest state machine.
 *
 * FROZEN migration. Its behaviour must never change once released, so it inlines
 * the target layout instead of importing runtime path helpers, and runtime code
 * must not depend on this module. The approved short-path IPC sockets
 * (Controller, tmux, Agent Host, and the integration runtime under `/tmp`) are
 * never touched: their paths do not start with a relocated managed root, so the
 * prefix-anchored rewrite leaves them exactly as they were.
 */
export const UNIFY_HOME_LAYOUT_SQL =
  "SELECT 1; -- data/fs-transform: unify self-managed paths under canonical YUI_HOME";

/** DurableJob statuses that are not terminal: a runner may still be executing. */
const NON_TERMINAL_JOB_STATUSES = ["queued", "running"] as const;

type PathRewrite = Readonly<{ from: string; to: string }>;

/**
 * Copy the one durable managed tree into Home (verifying the replica and
 * preserving the original), repair the copied Git worktrees, then rewrite only
 * the persisted pointers the runtime trusts as live. Runs inside the upgrade
 * transaction: any throw rolls back to its starting version, and because the source is
 * copied (never renamed away) and the copy is content-verified before publish, a
 * failed run leaves the original content intact for a manual re-run.
 */
export function migrateUnifyHomeLayout(db: Database.Database): void {
  const home = resolve(dirname(db.name));
  const { relocations, rewrites } = planUnifyHomeRewrites(home, readDefaultWorkspace(db));

  if (rewrites.length === 0) return;

  // Offline precheck — no filesystem or row mutation happens before this passes.
  // The migration runs AFTER the operator has stopped this Home's writers, so it
  // does not scan for live processes; the one residual runtime signal it still
  // guards is a queued/running durable Job bound under a relocating root, whose
  // detached runner could outlive the Controller quiesce fence and turn the copy
  // into an in-flight silent move. Let the Job drain or cancel it, then retry.
  const oldRoots = rewrites.map((move) => move.from);
  assertNoInFlightJobUnderRoots(db, oldRoots);

  // Physically relocate the durable tree(s). The copy is non-destructive and
  // verified (copy -> digest-verify -> atomic publish -> preserve source), so a
  // throw before publish leaves the source intact and nothing published. There is
  // no relocation manifest: the fenced upgrade backs up the DB and the preserved
  // source is the on-disk rollback anchor, and a failed run is recovered by a
  // manual re-run, not by an idempotent-resume state machine.
  for (const move of relocations) {
    relocateTree(move.from, move.to);
  }
  if (relocations.some((move) => existsSync(move.to))) {
    repairRelocatedWorktrees(db, rewrites);
  }

  // Rewrite every LIVE launch pointer consistently; frozen evidence is untouched.
  rewriteManagedWorkspaces(db, rewrites);
  rewriteActiveRunWorkspaces(db, rewrites);
  rewriteRoleSessionSets(db, rewrites);
  rewriteReviewRoundWorkspaces(db, rewrites);
  rewriteWorkItemExecutionGroups(db, rewrites);
  rewriteRoleWorkspaces(db, rewrites);
  rewriteTaskCwd(db, rewrites);
}

/**
 * One planned relocation blocker discovered by a READ-ONLY preflight. `reason`
 * is a stable machine tag; `detail` is the same operator-facing text the execute
 * path would throw. The preflight runs the identical checks execute runs first
 * (in-flight Job, target conflict), so a clean preflight is a genuine — not
 * merely schema-level — readiness signal.
 */
export type UnifyHomePreflightBlocker = Readonly<{
  reason: "in-flight-job" | "target-conflict";
  detail: string;
}>;

export type UnifyHomePreflight = Readonly<{
  /** True when the Home is already unified (no relocation/rewrite is pending). */
  noop: boolean;
  /** Number of on-disk trees this migration would physically copy. */
  plannedRelocations: number;
  /** Number of persisted pointer prefixes this migration would rewrite. */
  plannedRewrites: number;
  blockers: readonly UnifyHomePreflightBlocker[];
}>;

/**
 * Read-only counterpart to {@link migrateUnifyHomeLayout}: derive the SAME plan
 * and evaluate the SAME blocking conditions WITHOUT mutating the database or the
 * filesystem. This is what lets `yui upgrade --dry-run` and the updater's
 * `--update-preflight` report a trustworthy verdict — a target conflict or an
 * in-flight Job is surfaced before the Controller is stopped, not discovered only
 * inside the apply transaction.
 *
 * Every branch collects rather than throws, so one run reports all independent
 * blockers. The checks mirror the offline execute path exactly (in-flight Job,
 * target conflict), keeping the two in lockstep. It does NOT scan for live
 * processes: the migration is applied offline, after the operator has stopped
 * this Home's writers.
 */
export function preflightUnifyHomeLayout(db: Database.Database): UnifyHomePreflight {
  const home = resolve(dirname(db.name));
  const { relocations, rewrites } = planUnifyHomeRewrites(home, readDefaultWorkspace(db));
  if (rewrites.length === 0) {
    return Object.freeze({ noop: true, plannedRelocations: 0, plannedRewrites: 0, blockers: [] });
  }

  const blockers: UnifyHomePreflightBlocker[] = [];
  const oldRoots = rewrites.map((move) => move.from);
  for (const detail of collectInFlightJobBlockers(db, oldRoots)) {
    blockers.push({ reason: "in-flight-job", detail });
  }
  // The target-conflict check reads the same filesystem state relocateTree acts
  // on, without copying or writing anything.
  for (const detail of collectRelocationConflicts(relocations)) {
    blockers.push(detail);
  }

  return Object.freeze({
    noop: false,
    plannedRelocations: relocations.length,
    plannedRewrites: rewrites.length,
    blockers: Object.freeze(blockers)
  });
}

/**
 * Derive the relocation (physically copied) and rewrite (pointer-prefix) plans
 * from the canonical Home and the configured out-of-Home workspace. Pure: no IO,
 * no DB. Shared by the execute path and the read-only preflight so the two can
 * never diverge on what would move.
 */
function planUnifyHomeRewrites(
  home: string,
  defaultWorkspace: string | undefined
): Readonly<{ relocations: PathRewrite[]; rewrites: PathRewrite[] }> {
  const relocations: PathRewrite[] = [];
  const rewrites: PathRewrite[] = [];

  if (defaultWorkspace !== undefined) {
    const oldWorktree = join(defaultWorkspace, "worktree");
    const newWorktree = join(home, "workspaces", "worktree");
    const oldTasks = join(defaultWorkspace, "tasks");
    const newTasks = join(home, "workspaces", "tasks");
    if (oldWorktree !== newWorktree) {
      // The Git clones/worktrees hold durable committed AND uncommitted content;
      // they are the only subtree copied on disk.
      relocations.push({ from: oldWorktree, to: newWorktree });
      rewrites.push({ from: oldWorktree, to: newWorktree });
      // The per-Task view directories are regenerable symlink trees: pointer
      // rewrite only, rebuilt by `ensureWorkspaceView` on next launch.
      rewrites.push({ from: oldTasks, to: newTasks });
    }
  }

  // Provider runtime roots (data/cache/tmp + planning cwd) are disposable and
  // recreated at launch: pointer rewrite only, never copied.
  const oldRuntime = `${home}.task-runtimes`;
  const newRuntime = join(home, "runtime", "task-runtimes");
  if (oldRuntime !== newRuntime) {
    rewrites.push({ from: oldRuntime, to: newRuntime });
  }

  return { relocations, rewrites };
}

/** The configured out-of-Home workspace root, if any Project was ever set up. */
function readDefaultWorkspace(db: Database.Database): string | undefined {
  // The read-only preflight may open a Home still at an older schema version in
  // which `config` predates its current shape — but the table itself has existed
  // since the first version, so a missing table only means "no configuration yet".
  if (!tableExists(db, "config")) return undefined;
  const row = db.prepare("SELECT payload FROM config WHERE id = 1").get() as
    | { payload: string }
    | undefined;
  if (row === undefined) return undefined;
  try {
    const config = JSON.parse(row.payload) as { defaultWorkspace?: unknown };
    return typeof config.defaultWorkspace === "string" && config.defaultWorkspace.length > 0
      ? resolve(config.defaultWorkspace)
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when a table currently exists, so a read-only preflight against an older
 * schema version never throws on a table introduced by a later migration. */
function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * Refuse to migrate a pointer a non-terminal Job is bound to. `active_turns` is
 * NOT consulted: it holds durable, steady-state run pointers for every active
 * Task and is present on nearly every live Home, so keying in-flight detection
 * off it would over-refuse. The precise signal is a queued/running `durable_jobs`
 * whose workspace (or a step cwd) lies under a root about to change; its detached
 * runner survives the Controller fence and could hold an open handle.
 */
function assertNoInFlightJobUnderRoots(
  db: Database.Database,
  roots: readonly string[]
): void {
  const blockers = collectInFlightJobBlockers(db, roots);
  if (blockers.length > 0) throw new Error(blockers[0]);
}

/**
 * Read-only enumeration of the queued/running durable Jobs bound under a
 * relocating root. Returns one operator-facing message per offending Job (the
 * execute path throws the first). No DB mutation.
 */
function collectInFlightJobBlockers(
  db: Database.Database,
  roots: readonly string[]
): readonly string[] {
  if (!tableExists(db, "durable_jobs")) return [];
  const placeholders = NON_TERMINAL_JOB_STATUSES.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT payload FROM durable_jobs WHERE status IN (${placeholders})`)
    .all(...NON_TERMINAL_JOB_STATUSES) as Array<{ payload: string }>;
  const blockers: string[] = [];
  for (const row of rows) {
    let job: { id?: unknown; workspace?: unknown; steps?: Array<{ cwd?: unknown }> };
    try {
      job = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const candidates: string[] = [];
    if (typeof job.workspace === "string") candidates.push(job.workspace);
    if (Array.isArray(job.steps)) {
      for (const step of job.steps) {
        if (typeof step.cwd === "string") candidates.push(step.cwd);
      }
    }
    for (const candidate of candidates) {
      if (isUnderAnyRoot(resolve(candidate), roots)) {
        blockers.push(
          "Refusing to unify YUI_HOME layout: a queued or running durable Job"
            + `${typeof job.id === "string" ? ` (${job.id})` : ""} is bound to a managed workspace `
            + `under relocation (${candidate}). Let it drain or cancel it (\`yui job ...\`), then `
            + "retry the upgrade."
        );
        break;
      }
    }
  }
  return blockers;
}

/**
 * Read-only detection of the filesystem condition that would make the relocate
 * step REFUSE: a relocation target that already exists. In the offline model a
 * present target is either a foreign directory or residue from a failed prior run
 * — never something to silently adopt — so `relocateTree` refuses it and the
 * operator resolves it before a manual re-run. This mirrors that refusal WITHOUT
 * copying, staging, or writing anything, so a dry-run/preflight verdict reflects
 * the same decision execute would make.
 */
function collectRelocationConflicts(
  relocations: readonly PathRewrite[]
): readonly UnifyHomePreflightBlocker[] {
  const blockers: UnifyHomePreflightBlocker[] = [];
  for (const move of relocations) {
    if (!existsSync(move.to)) continue;
    blockers.push({
      reason: "target-conflict",
      detail: `the relocation target ${move.to} already exists; it is a foreign directory or `
        + `residue from a failed prior run. Confirm the source at ${move.from} is intact, then `
        + `move or remove ${move.to} before retrying the upgrade`
    });
  }
  return blockers;
}

/**
 * A content-addressed inventory digest of a tree: for every path in
 * deterministic order, the relative path, kind, and either the file size + byte
 * content or the symlink target. Two trees with an identical digest are byte-for
 * -byte identical in structure and content, which is what proves a relocation
 * replica is faithful and complete before it is published.
 */
function treeInventoryDigest(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        hash.update(`L ${relPath}\0${readlinkSync(abs)}\0`);
      } else if (stat.isDirectory()) {
        hash.update(`D ${relPath}\0`);
        walk(abs, relPath);
      } else if (stat.isFile()) {
        hash.update(`F ${relPath}\0${stat.size}\0`);
        hash.update(readFileSync(abs));
        hash.update("\0");
      } else {
        // FIFO/socket/device node: record its presence and kind, never read it.
        hash.update(`O ${relPath}\0`);
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

/**
 * Copy one managed subtree into Home, NON-DESTRUCTIVELY to the source. The source
 * is copied (never renamed away) to a same-filesystem staging directory, the
 * replica's content digest is verified against the source, and only a verified
 * replica is atomically renamed into place. The original is PRESERVED as the
 * rollback anchor; its removal is a later, authorized cleanup step, never part of
 * this transaction.
 *
 * Offline and single-shot — NOT an idempotent resumable move. A relocation target
 * that already exists is refused outright: in the offline model it is either a
 * foreign directory or residue from a failed prior run, and this migration never
 * adopts or re-verifies a pre-existing target (the operator resolves it and
 * re-runs). When neither source nor target exists the tree was never created and
 * there is nothing to do. Any throw happens before the atomic rename, so the
 * source is left intact and nothing is published; recovery is a manual re-run
 * after the operator clears the conflict, backed by the fenced DB backup.
 */
function relocateTree(from: string, to: string): void {
  const staging = `${to}.incoming`;

  if (existsSync(to)) {
    // A pre-existing target is never silently adopted: it is a foreign directory
    // or residue from a failed prior run. Refuse so the transaction rolls back;
    // the operator inspects it, confirms the source is intact, removes the
    // conflict, and re-runs the upgrade.
    throw new Error(
      `Refusing to unify YUI_HOME layout: the relocation target ${to} already exists. It is a `
        + `foreign directory or residue from a failed prior run. Confirm the source at ${from} is `
        + `intact, then move or remove ${to} and re-run the upgrade.`
    );
  }
  if (!existsSync(from)) {
    // Neither source nor target exists: the tree was never created. Nothing to do.
    return;
  }

  const sourceDigest = treeInventoryDigest(from);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  rmSync(staging, { recursive: true, force: true });
  // Copy (never move) so the original survives as the rollback anchor even if
  // this transaction later throws. Symlinks and Git administrative files are
  // preserved verbatim.
  cpSync(from, staging, { recursive: true, verbatimSymlinks: true });
  // Prove the replica is faithful and complete BEFORE publishing it.
  if (treeInventoryDigest(staging) !== sourceDigest) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `Refusing to unify YUI_HOME layout: the relocated copy of ${from} did not match the `
        + `source content after copying. The original is untouched; re-run the upgrade.`
    );
  }
  // Atomic publish: staging and target share the Home filesystem.
  renameSync(staging, to);
}

/**
 * After the worktree subtree is copied into Home, the copies' absolute Git
 * pointers still reference the OLD source location. They are corrected in TWO
 * steps, in this order:
 *
 *   1. Deterministically REWRITE, in the NEW copy only, the two worktree cross-
 *      reference pointer files (a linked worktree's `.git` stub and each main
 *      clone's `.git/worktrees/<name>/gitdir`) from the OLD prefix to the NEW
 *      prefix. This is the crucial step for preserved-source independence: it
 *      makes the copy self-referential BEFORE any native git command runs, so
 *      git never follows a stale absolute pointer back into the OLD tree and
 *      mutates it. (Empirically, `git worktree repair` invoked on a verbatim copy
 *      whose pointers still address the source WILL rewrite the OLD source's
 *      `.git` files — corrupting the rollback anchor. Pre-rewriting prevents it.)
 *   2. Run `git worktree repair` from each main clone at its NEW path as a
 *      belt-and-braces reconciliation (it also fixes any pointer we did not model,
 *      e.g. an unexpected nesting), now guaranteed to operate only within the NEW
 *      tree because step 1 already repointed every cross-reference into it.
 *
 * Committed and uncommitted content is preserved throughout. A repair FAILURE IS
 * FATAL: it aborts the migration so the transaction rolls back and the fenced
 * backup is restored, rather than advancing the version over unrepaired
 * worktrees. The new paths are derived from the registry entries as they will be
 * rewritten.
 */
function repairRelocatedWorktrees(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const groups = new Map<string, { main?: string; linked: Set<string> }>();
  const rows = db
    .prepare("SELECT owner_kind, payload FROM managed_workspaces")
    .all() as Array<{ owner_kind: string; payload: string }>;
  for (const row of rows) {
    let workspace: {
      owner?: { taskId?: unknown };
      entries?: Array<{ projectId?: unknown; path?: unknown }>;
    };
    try {
      workspace = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const taskId = typeof workspace.owner?.taskId === "string" ? workspace.owner.taskId : undefined;
    if (taskId === undefined || !Array.isArray(workspace.entries)) continue;
    for (const entry of workspace.entries) {
      if (typeof entry.projectId !== "string" || typeof entry.path !== "string") continue;
      const newPath = applyPrefix(entry.path, rewrites);
      if (newPath === undefined) continue;
      const key = `${taskId} ${entry.projectId}`;
      const group = groups.get(key) ?? { linked: new Set<string>() };
      if (row.owner_kind === "task") group.main = newPath;
      else group.linked.add(newPath);
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const main = group.main;
    // A group whose main clone was never materialised on disk (a stale registry
    // row pointing at a path that never existed) has nothing to repair and is
    // re-prepared lazily on next launch. A main that DOES exist but fails to
    // repair is a real integrity failure and is allowed to throw.
    if (main === undefined || !existsSync(main)) continue;
    const linked = [...group.linked].filter((path) => existsSync(path));
    // Step 1: repoint the copy's cross-reference pointer files into the NEW tree
    // BEFORE git runs, so no native command can chase a stale pointer into — and
    // rewrite — the preserved OLD source.
    relinkWorktreePointers(main, linked, rewrites);
    // Step 2: reconcile with git as a safety net (now confined to the NEW tree).
    execFileSync("git", ["-C", main, "worktree", "repair", ...linked], {
      stdio: "ignore",
      timeout: 60_000
    });
  }
}

/**
 * Rewrite, in place and in the NEW copy only, the worktree cross-reference
 * pointer files so every path they contain that fell under a relocating OLD root
 * is repointed to its NEW location. Two file kinds carry such absolute paths:
 *
 *   - each linked worktree's `.git` stub file: `gitdir: <main>/.git/worktrees/<n>`
 *   - each main clone's `.git/worktrees/<name>/gitdir`: `<linked>/.git`
 *
 * Only the OLD→NEW prefixes are substituted (via {@link applyPrefix} on the exact
 * path token), so a pointer already addressing the NEW tree, or one outside every
 * relocating root, is left untouched. A missing or malformed pointer file is left
 * for the subsequent `git worktree repair` to reconstruct. Nothing outside the
 * NEW copy is read or written, so the preserved OLD source is never touched.
 */
function relinkWorktreePointers(
  main: string,
  linked: readonly string[],
  rewrites: readonly PathRewrite[]
): void {
  // Main clone's back-pointers: .git/worktrees/<name>/gitdir -> <linked>/.git
  const worktreesDir = join(main, ".git", "worktrees");
  if (existsSync(worktreesDir)) {
    let names: string[];
    try {
      names = readdirSync(worktreesDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      relinkPointerFile(join(worktreesDir, name, "gitdir"), rewrites);
    }
  }
  // Each linked worktree's stub: .git file -> gitdir: <main>/.git/worktrees/<name>
  for (const worktree of linked) {
    relinkPointerFile(join(worktree, ".git"), rewrites);
  }
}

/**
 * Rewrite a single Git pointer file's stored path with the OLD→NEW prefix map,
 * preserving any `gitdir: ` prefix and trailing newline. A file that is absent,
 * unreadable, a directory (a real repository, never a pointer), or whose path is
 * not under any relocating root is left exactly as-is.
 */
function relinkPointerFile(pointerPath: string, rewrites: readonly PathRewrite[]): void {
  let raw: string;
  try {
    if (lstatSync(pointerPath).isDirectory()) return;
    raw = readFileSync(pointerPath, "utf8");
  } catch {
    return;
  }
  const trailing = raw.endsWith("\n") ? "\n" : "";
  const body = trailing === "\n" ? raw.slice(0, -1) : raw;
  const marker = "gitdir: ";
  const hasMarker = body.startsWith(marker);
  const pathToken = hasMarker ? body.slice(marker.length) : body;
  const rewritten = applyPrefix(pathToken.trim(), rewrites);
  if (rewritten === undefined || rewritten === pathToken.trim()) return;
  const next = `${hasMarker ? marker : ""}${rewritten}${trailing}`;
  writeFileSync(pointerPath, next);
}

/**
 * Rewrite the authoritative workspace registry: the `path` column plus the
 * payload `root` and every `entries[].path`. Every surviving row is a live
 * workspace (dispositioned rows are deleted at cleanup), so all are rewritten.
 * Timestamps are left untouched so a live mirror stays deep-equal to its row.
 */
function rewriteManagedWorkspaces(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const rows = db
    .prepare("SELECT owner_kind, owner_id, path, payload FROM managed_workspaces")
    .all() as Array<{ owner_kind: string; owner_id: string; path: string; payload: string }>;
  const update = db.prepare(
    "UPDATE managed_workspaces SET path = ?, payload = ? WHERE owner_kind = ? AND owner_id = ?"
  );
  for (const row of rows) {
    const newPath = applyPrefix(row.path, rewrites) ?? row.path;
    let workspace: Record<string, unknown>;
    try {
      workspace = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const rewritten = rewriteWorkspaceObject(workspace, rewrites);
    const newPayload = JSON.stringify(rewritten);
    if (newPath === row.path && newPayload === row.payload) continue;
    update.run(newPath, newPayload, row.owner_kind, row.owner_id);
  }
}

/**
 * Rewrite the live launch cwd carried by each active AgentRun. The actual OS
 * cwd is derived from `run.effective.workspace`, and `validateRun` requires
 * `run.workspace` (when present) to stay identical to it, so BOTH are rewritten
 * with the same prefix map — never one without the other. Terminal runs keep
 * their old (mutually consistent) paths and are left as frozen evidence, as is
 * `.result.systemEvidence.workspaceSnapshot`.
 */
function rewriteActiveRunWorkspaces(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const rows = db
    .prepare("SELECT task_id, turn_id, payload FROM turns WHERE status = 'active'")
    .all() as Array<{ task_id: string; turn_id: string; payload: string }>;
  const update = db.prepare(
    "UPDATE turns SET payload = ? WHERE task_id = ? AND turn_id = ?"
  );
  for (const row of rows) {
    let run: Record<string, unknown>;
    try {
      run = JSON.parse(row.payload);
    } catch {
      continue;
    }
    let next = run;
    // The required launch snapshot: the actual cwd source.
    const effective = run.effective;
    if (effective !== null && typeof effective === "object") {
      const effectiveWorkspace = (effective as Record<string, unknown>).workspace;
      if (effectiveWorkspace !== null && typeof effectiveWorkspace === "object") {
        const rewritten = rewriteWorkspaceObject(
          effectiveWorkspace as Record<string, unknown>,
          rewrites
        );
        if (!isDeepStrictEqual(rewritten, effectiveWorkspace)) {
          next = {
            ...next,
            effective: { ...(effective as Record<string, unknown>), workspace: rewritten }
          };
        }
      }
    }
    // The optional mirror pointer, kept identical to `effective.workspace`.
    const workspace = run.workspace;
    if (workspace !== null && typeof workspace === "object") {
      const rewritten = rewriteWorkspaceObject(workspace as Record<string, unknown>, rewrites);
      if (!isDeepStrictEqual(rewritten, workspace)) {
        next = { ...next, workspace: rewritten };
      }
    }
    if (next === run) continue;
    update.run(JSON.stringify(next), row.task_id, row.turn_id);
  }
}

/**
 * Rewrite each live native session's frozen launch cwd. A `RoleAgentSession`
 * in the `sessions` map is a resumable live binding whose `effective.workspace`
 * is the cwd a resume would relaunch under. Terminal sessions archived in
 * `history` are frozen evidence and are preserved. Both the per-Task
 * (`role_session_sets`) and global (`global_role_session_sets`) stores carry
 * the same session shape.
 */
function rewriteRoleSessionSets(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  rewriteSessionSetTable(
    db,
    "SELECT task_id, role_name, payload FROM role_session_sets",
    "UPDATE role_session_sets SET payload = ? WHERE task_id = ? AND role_name = ?",
    (row) => [row.task_id as string, row.role_name as string],
    rewrites
  );
  rewriteSessionSetTable(
    db,
    "SELECT name, payload FROM global_role_session_sets",
    "UPDATE global_role_session_sets SET payload = ? WHERE name = ?",
    (row) => [row.name as string],
    rewrites
  );
}

function rewriteSessionSetTable(
  db: Database.Database,
  select: string,
  updateSql: string,
  keyOf: (row: Record<string, unknown>) => unknown[],
  rewrites: readonly PathRewrite[]
): void {
  const rows = db.prepare(select).all() as Array<Record<string, unknown>>;
  const update = db.prepare(updateSql);
  for (const row of rows) {
    let set: Record<string, unknown>;
    try {
      set = JSON.parse(row.payload as string);
    } catch {
      continue;
    }
    const sessions = set.sessions;
    if (sessions === null || typeof sessions !== "object") continue;
    let changed = false;
    const nextSessions: Record<string, unknown> = {};
    for (const [id, session] of Object.entries(sessions as Record<string, unknown>)) {
      const rewrittenSession = rewriteSessionEffectiveWorkspace(session, rewrites);
      if (rewrittenSession !== session) changed = true;
      nextSessions[id] = rewrittenSession;
    }
    if (!changed) continue;
    update.run(JSON.stringify({ ...set, sessions: nextSessions }), ...keyOf(row));
  }
}

/** Rewrite one session's `effective.workspace`, returning the same reference when unchanged. */
function rewriteSessionEffectiveWorkspace(
  session: unknown,
  rewrites: readonly PathRewrite[]
): unknown {
  if (session === null || typeof session !== "object") return session;
  const effective = (session as Record<string, unknown>).effective;
  if (effective === null || typeof effective !== "object") return session;
  const workspace = (effective as Record<string, unknown>).workspace;
  if (workspace === null || typeof workspace !== "object") return session;
  const rewritten = rewriteWorkspaceObject(workspace as Record<string, unknown>, rewrites);
  if (isDeepStrictEqual(rewritten, workspace)) return session;
  return {
    ...(session as Record<string, unknown>),
    effective: { ...(effective as Record<string, unknown>), workspace: rewritten }
  };
}

/**
 * Rewrite the ManagedWorkspace a ReviewRound mirrors (while its registry row
 * still exists) and each OPEN execution lane's live launch pointers. Re-
 * preparation refuses on any deep divergence between the mirror and its row, so
 * the mirror is kept equal to its rewritten row; an orphaned mirror and any
 * terminal lane are frozen evidence and are left as-is.
 */
function rewriteReviewRoundWorkspaces(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const liveReviewOwners = liveOwnerKeys(db, "review-round", (owner) =>
    typeof owner.taskId === "string" && typeof owner.reviewRoundId === "string"
      ? `${owner.taskId} ${owner.reviewRoundId}`
      : undefined
  );
  const rows = db
    .prepare("SELECT task_id, review_round_id, payload FROM review_rounds")
    .all() as Array<{ task_id: string; review_round_id: string; payload: string }>;
  const update = db.prepare(
    "UPDATE review_rounds SET payload = ? WHERE task_id = ? AND review_round_id = ?"
  );
  for (const row of rows) {
    let round: Record<string, unknown>;
    try {
      round = JSON.parse(row.payload);
    } catch {
      continue;
    }
    let next = round;
    const workspace = round.workspace;
    if (workspace !== null && typeof workspace === "object") {
      const owner = (workspace as { owner?: Record<string, unknown> }).owner;
      const ownerKey = owner !== undefined
        && typeof owner.taskId === "string" && typeof owner.reviewRoundId === "string"
        ? `${owner.taskId} ${owner.reviewRoundId}`
        : undefined;
      if (ownerKey !== undefined && liveReviewOwners.has(ownerKey)) {
        const rewritten = rewriteWorkspaceObject(workspace as Record<string, unknown>, rewrites);
        if (!isDeepStrictEqual(rewritten, workspace)) next = { ...next, workspace: rewritten };
      }
    }
    const group = round.executionGroup;
    if (group !== null && typeof group === "object") {
      const rewrittenGroup = rewriteExecutionGroupOpenLanes(group, rewrites);
      if (rewrittenGroup !== group) next = { ...next, executionGroup: rewrittenGroup };
    }
    if (next === round) continue;
    update.run(JSON.stringify(next), row.task_id, row.review_round_id);
  }
}

/**
 * Rewrite the OPEN execution lanes inside each WorkItem's `executionGroups`. A
 * WorkItemCandidate snapshot (`work_item_candidates`) is frozen evidence and is
 * left untouched; only an open lane is a live launch pointer.
 */
function rewriteWorkItemExecutionGroups(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const rows = db
    .prepare("SELECT task_id, work_item_id, payload FROM work_items")
    .all() as Array<{ task_id: string; work_item_id: string; payload: string }>;
  const update = db.prepare(
    "UPDATE work_items SET payload = ? WHERE task_id = ? AND work_item_id = ?"
  );
  for (const row of rows) {
    let item: Record<string, unknown>;
    try {
      item = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const groups = item.executionGroups;
    if (!Array.isArray(groups)) continue;
    let changed = false;
    const nextGroups = groups.map((group) => {
      const rewritten = rewriteExecutionGroupOpenLanes(group, rewrites);
      if (rewritten !== group) changed = true;
      return rewritten;
    });
    if (!changed) continue;
    update.run(JSON.stringify({ ...item, executionGroups: nextGroups }), row.task_id, row.work_item_id);
  }
}

/**
 * Rewrite the live launch pointers of every OPEN lane in an execution group,
 * returning the same reference when nothing changed. A lane is live only while
 * its disposition is `open`; a `succeeded`/`failed` lane is terminal evidence.
 */
function rewriteExecutionGroupOpenLanes(
  group: unknown,
  rewrites: readonly PathRewrite[]
): unknown {
  if (group === null || typeof group !== "object") return group;
  const lanes = (group as Record<string, unknown>).lanes;
  if (!Array.isArray(lanes)) return group;
  let changed = false;
  const nextLanes = lanes.map((lane) => {
    if (lane === null || typeof lane !== "object") return lane;
    if ((lane as Record<string, unknown>).disposition !== "open") return lane;
    const rewritten = rewriteLaneLaunchPointers(lane as Record<string, unknown>, rewrites);
    if (rewritten !== lane) changed = true;
    return rewritten;
  });
  if (!changed) return group;
  return { ...(group as Record<string, unknown>), lanes: nextLanes };
}

/**
 * Rewrite one lane's `effective.workspace` (root + entries) and `workspace.root`
 * (the lane workspace carries only a root path plus writable project ids).
 * Returns the same reference when unchanged.
 */
function rewriteLaneLaunchPointers(
  lane: Record<string, unknown>,
  rewrites: readonly PathRewrite[]
): Record<string, unknown> {
  let next = lane;
  const effective = lane.effective;
  if (effective !== null && typeof effective === "object") {
    const workspace = (effective as Record<string, unknown>).workspace;
    if (workspace !== null && typeof workspace === "object") {
      const rewritten = rewriteWorkspaceObject(workspace as Record<string, unknown>, rewrites);
      if (!isDeepStrictEqual(rewritten, workspace)) {
        next = {
          ...next,
          effective: { ...(effective as Record<string, unknown>), workspace: rewritten }
        };
      }
    }
  }
  const workspace = next.workspace;
  if (workspace !== null && typeof workspace === "object"
    && typeof (workspace as Record<string, unknown>).root === "string") {
    const root = (workspace as Record<string, unknown>).root as string;
    const rewritten = applyPrefix(root, rewrites);
    if (rewritten !== undefined && rewritten !== root) {
      next = { ...next, workspace: { ...(workspace as Record<string, unknown>), root: rewritten } };
    }
  }
  return next;
}

/**
 * Rewrite the live launch cwd on each Role. Active Roles under the task root are
 * also self-healed by `prepareTaskWorkspace`, but a Draft's planning Role points
 * at the old runtime root and is never prepared until activation, so rewriting
 * here is the only correction it receives. A Role workspace is a mutable pointer,
 * never historical evidence; a cwd outside every relocated root is left as-is.
 */
function rewriteRoleWorkspaces(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const rows = db
    .prepare("SELECT task_id, role_name, payload FROM task_roles")
    .all() as Array<{ task_id: string; role_name: string; payload: string }>;
  const update = db.prepare(
    "UPDATE task_roles SET payload = ? WHERE task_id = ? AND role_name = ?"
  );
  for (const row of rows) {
    let role: Record<string, unknown>;
    try {
      role = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (typeof role.workspace !== "string") continue;
    const next = applyPrefix(role.workspace, rewrites);
    if (next === undefined || next === role.workspace) continue;
    update.run(JSON.stringify({ ...role, workspace: next }), row.task_id, row.role_name);
  }
}

/**
 * Defensively rewrite `task_records.cwd`. This field self-heals to the freshly
 * resolved task root on the next `prepareTaskWorkspace` (which runs for every
 * active Task at Controller startup, before any launch), but rewriting it here
 * closes the window in which a reader could observe a stale cwd, and corrects a
 * Task that is not prepared this boot. It is not gate-validated, so the rewrite
 * carries no cross-field obligation.
 */
function rewriteTaskCwd(
  db: Database.Database,
  rewrites: readonly PathRewrite[]
): void {
  const rows = db
    .prepare("SELECT task_id, payload FROM task_records")
    .all() as Array<{ task_id: string; payload: string }>;
  const update = db.prepare("UPDATE task_records SET payload = ? WHERE task_id = ?");
  for (const row of rows) {
    let task: Record<string, unknown>;
    try {
      task = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (typeof task.cwd !== "string") continue;
    const next = applyPrefix(task.cwd, rewrites);
    if (next === undefined || next === task.cwd) continue;
    update.run(JSON.stringify({ ...task, cwd: next }), row.task_id);
  }
}

/**
 * The live owner identity keys present in `managed_workspaces` for one owner
 * kind. Used to tell a live embedded mirror (row still present) from frozen
 * evidence (row already deleted at disposition).
 */
function liveOwnerKeys(
  db: Database.Database,
  ownerKind: string,
  keyOf: (owner: Record<string, unknown>) => string | undefined
): Set<string> {
  const keys = new Set<string>();
  const rows = db
    .prepare("SELECT payload FROM managed_workspaces WHERE owner_kind = ?")
    .all(ownerKind) as Array<{ payload: string }>;
  for (const row of rows) {
    let workspace: { owner?: Record<string, unknown> };
    try {
      workspace = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (workspace.owner === undefined) continue;
    const key = keyOf(workspace.owner);
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * Return a copy of a workspace-shaped object (ManagedWorkspace or
 * EffectiveLaunchWorkspace) with `root` and every `entries[].path` prefix-
 * rewritten. Key order and untouched fields (owner, timestamps, entry metadata)
 * are preserved, so an unchanged root/entry leaves the object structurally
 * identical.
 */
function rewriteWorkspaceObject(
  workspace: Record<string, unknown>,
  rewrites: readonly PathRewrite[]
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...workspace };
  if (typeof workspace.root === "string") {
    next.root = applyPrefix(workspace.root, rewrites) ?? workspace.root;
  }
  if (Array.isArray(workspace.entries)) {
    next.entries = workspace.entries.map((entry) => {
      if (entry !== null && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
        const path = (entry as { path: string }).path;
        return { ...(entry as Record<string, unknown>), path: applyPrefix(path, rewrites) ?? path };
      }
      return entry;
    });
  }
  return next;
}

/** Substitute the first matching root prefix, or undefined when none applies. */
function applyPrefix(value: string, rewrites: readonly PathRewrite[]): string | undefined {
  for (const { from, to } of rewrites) {
    if (value === from) return to;
    const nested = relative(from, value);
    if (nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested)) {
      // `relative` yields a non-escaping, non-absolute path only when `value`
      // is genuinely beneath `from`; join preserves the trailing structure.
      return join(to, nested);
    }
  }
  return undefined;
}

/** True when `value` is one of `roots` or lies beneath one of them. */
function isUnderAnyRoot(value: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    if (value === root) return true;
    const nested = relative(root, value);
    return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
  });
}
