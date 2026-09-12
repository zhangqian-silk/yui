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
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

/**
 * Storage 23 -> 24: collapse the two-layer managed workspace layout into a
 * single layer of real Git worktrees addressed by Task/owner and Project.
 *
 * Before this migration each managed Git worktree lived under a per-Project
 * physical root (`<home>/workspaces/worktree/<projectName>/<taskKey>/<roleKey>`)
 * and every Task-owned view (`<home>/workspaces/tasks/<taskId>/<owner>/`) was a
 * directory of SYMLINKS whose names were the bound Project directory and whose
 * targets were those physical worktrees. Two families of paths therefore
 * described one worktree: the physical location and the symlink view.
 *
 * This migration removes that indirection. Every real worktree is relocated to
 * the location the view symlink used to point the runtime at —
 * `<home>/workspaces/tasks/<taskId>/<owner>/<projectDirectory>` — so the logical
 * entry path and the physical Git worktree become the same directory. The owner
 * root is the SAME per-Task directory the v19 view used (`main`,
 * `work-items/<id>`, `reviews/<name>`, `execution-lanes/<g>/<l>`); an
 * Integration attempt, whose v19 workspace root WAS its physical worktree under
 * `worktree/`, moves under a new owner root
 * `<home>/workspaces/tasks/<taskId>/integrations/<integrationId>/`.
 *
 * ONLY the durable managed Git worktrees are physically relocated — the sole
 * subtree that holds non-regenerable committed AND uncommitted work. Each is
 * COPIED (never renamed away), content-verified by digest, and atomically
 * published; the original under `worktree/` is PRESERVED as the rollback anchor
 * and is never removed by this data step. The v19 view symlink that occupies the
 * exact publish target is a regenerable pointer: it is unlinked immediately
 * before the real worktree is published there. Read-only context entries (a
 * WorkItem/lane view onto the shared Task main) are NOT relocated — their stored
 * pointer is rewritten to the new Task-main path and their on-disk symlink is
 * rebuilt by `ensureWorkspaceView` at the next launch.
 *
 * The pointer rewrite is SURGICAL, mirroring the 18->19 migration: only the
 * records the runtime dereferences as live launch pointers are touched
 * (`managed_workspaces`, active `turns`, `role_session_sets` /
 * `global_role_session_sets`, live `review_rounds`, open lanes in `work_items`,
 * `task_roles.workspace`, `task_records.cwd`). Frozen evidence (Context
 * snapshots, terminal Run Git evidence, candidate snapshots, terminal lanes and
 * Jobs, reports) is left byte-for-byte intact, and the Git ref names — which are
 * path-independent — are never rewritten.
 *
 * A queued or running `durable_jobs` step runs in a detached process that
 * SURVIVES the Controller quiesce fence, so a live cwd bound under a relocating
 * worktree would be an in-flight silent migration (forbidden). Such a Job is
 * refused up front rather than relocated.
 *
 * OFFLINE migration by design, applied by the standalone `yui upgrade` mutation
 * boundary AFTER the operator has stopped this Home's writers. Its only runtime
 * precondition is the minimal in-flight-Job conflict check. On any failure it
 * throws, the upgrade transaction rolls back to its starting version, and the preserved
 * source under `worktree/` plus the fenced DB backup are the recovery pair for a
 * manual re-run.
 *
 * FROZEN migration. Its behaviour must never change once released, so it inlines
 * the v19 and v20 layouts instead of importing runtime path helpers, and runtime
 * code must not depend on this module.
 */
export const COLLAPSE_WORKTREE_LAYOUT_SQL =
  "SELECT 1; -- data/fs-transform: collapse managed worktrees into single-layer Task/owner paths";

/** DurableJob statuses that are not terminal: a runner may still be executing. */
const NON_TERMINAL_JOB_STATUSES = ["queued", "running"] as const;

/** One planned physical relocation of a real worktree, old path -> new path. */
type PathRewrite = Readonly<{ from: string; to: string }>;

/**
 * Copy every managed worktree into its single-layer Task/owner location
 * (verifying each replica and preserving the original), repair the copied Git
 * worktrees, then rewrite only the persisted pointers the runtime trusts as
 * live. Runs inside the upgrade transaction: any throw rolls the schema back to
 * 19, and because each source is copied (never renamed away) and content-
 * verified before publish, a failed run leaves the originals intact.
 */
export function migrateCollapseWorktreeLayout(db: Database.Database): void {
  const home = resolve(dirname(db.name));
  const rewrites = planCollapseRewrites(db, home);
  if (rewrites.length === 0) return;

  // Offline precheck — no filesystem or row mutation happens before this passes.
  const oldRoots = rewrites.map((move) => move.from);
  assertNoInFlightJobUnderRoots(db, oldRoots);

  // Physically relocate each durable worktree: unlink the regenerable v19 view
  // symlink occupying the target, then copy -> digest-verify -> atomic publish,
  // preserving the source. A throw before publish leaves the source intact.
  for (const move of rewrites) {
    relocateWorktree(move.from, move.to);
  }
  if (rewrites.some((move) => existsSync(move.to))) {
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
 * One planned blocker discovered by a READ-ONLY preflight. `reason` is a stable
 * machine tag; `detail` is the same operator-facing text the execute path would
 * throw. The preflight runs the identical checks execute runs first (in-flight
 * Job, target conflict), so a clean preflight is a genuine readiness signal.
 */
export type CollapseWorktreePreflightBlocker = Readonly<{
  reason: "in-flight-job" | "target-conflict";
  detail: string;
}>;

export type CollapseWorktreePreflight = Readonly<{
  /** True when the Home already uses the single-layer layout (nothing pending). */
  noop: boolean;
  /** Number of on-disk worktrees this migration would physically copy. */
  plannedRelocations: number;
  /** Number of persisted pointer prefixes this migration would rewrite. */
  plannedRewrites: number;
  blockers: readonly CollapseWorktreePreflightBlocker[];
}>;

/**
 * Read-only counterpart to {@link migrateCollapseWorktreeLayout}: derive the
 * SAME plan and evaluate the SAME blocking conditions WITHOUT mutating the
 * database or the filesystem, so `yui upgrade --dry-run` and the updater's
 * `--update-preflight` can report a trustworthy verdict before the Controller is
 * stopped. Every branch collects rather than throws, so one run reports all
 * independent blockers.
 */
export function preflightCollapseWorktreeLayout(
  db: Database.Database
): CollapseWorktreePreflight {
  const home = resolve(dirname(db.name));
  const rewrites = planCollapseRewrites(db, home);
  if (rewrites.length === 0) {
    return Object.freeze({ noop: true, plannedRelocations: 0, plannedRewrites: 0, blockers: [] });
  }

  const blockers: CollapseWorktreePreflightBlocker[] = [];
  const oldRoots = rewrites.map((move) => move.from);
  for (const detail of collectInFlightJobBlockers(db, oldRoots)) {
    blockers.push({ reason: "in-flight-job", detail });
  }
  for (const detail of collectRelocationConflicts(rewrites)) {
    blockers.push(detail);
  }

  return Object.freeze({
    noop: false,
    plannedRelocations: rewrites.length,
    plannedRewrites: rewrites.length,
    blockers: Object.freeze(blockers)
  });
}

/**
 * Derive the structural relocation plan from the authoritative workspace
 * registry. Pure except for reading `managed_workspaces` and `task_records`.
 * Every WRITE entry whose recorded path still lies under the legacy `worktree/`
 * root yields one relocation from that physical path to `join(ownerRoot,
 * segment)`. For a Task/WorkItem/Review/lane the owner root is the v19 view root
 * (unchanged) and the segment is the stored `entry.directory`, which v19 already
 * recorded as the BOUND directory — so the target reproduces the native v20 path
 * even when the Task used `--directory`. An Integration attempt is the sole
 * exception: v19 stored its `entry.directory` as the PROJECT NAME while the v20
 * runtime addresses it by the bound directory, so its owner root is a NEW
 * `integrations/<id>` directory and its segment is the bound directory looked up
 * from the Task (falling back to the stored value when the binding is gone).
 * Read entries reference a Task-main write entry already in the plan, so they add
 * nothing. The list doubles as the physical copy list and the pointer-prefix map.
 */
function planCollapseRewrites(
  db: Database.Database,
  home: string
): readonly PathRewrite[] {
  if (!tableExists(db, "managed_workspaces")) return [];
  const legacyWorktreeRoot = join(home, "workspaces", "worktree");
  const bound = boundDirectories(db);
  const rewrites: PathRewrite[] = [];
  const seen = new Set<string>();
  const rows = db
    .prepare("SELECT owner_kind, payload FROM managed_workspaces")
    .all() as Array<{ owner_kind: string; payload: string }>;
  for (const row of rows) {
    const workspace = parseWorkspace(row.payload);
    if (workspace === undefined) continue;
    const ownerRoot = newOwnerRoot(home, workspace);
    if (ownerRoot === undefined) continue;
    const taskId = typeof workspace.owner?.taskId === "string" ? workspace.owner.taskId : undefined;
    const isIntegration = workspace.owner?.type === "integration-attempt";
    for (const entry of workspace.entries) {
      if (entry.access !== "write") continue;
      if (typeof entry.path !== "string" || typeof entry.directory !== "string") continue;
      const from = resolve(entry.path);
      // Only relocate worktrees still under the legacy physical root; anything
      // already single-layer (a re-run, or a Home built fresh at v20) is skipped
      // so the plan is a clean no-op rather than touching a foreign path.
      if (!isUnderRoot(from, legacyWorktreeRoot)) continue;
      // Non-integration owners already store the bound directory; only an
      // integration attempt must be remapped from its project-name segment to
      // the bound directory the v20 runtime re-derives on re-entry.
      const segment = isIntegration && taskId !== undefined && typeof entry.projectId === "string"
        ? bound.get(`${taskId} ${entry.projectId}`) ?? entry.directory
        : entry.directory;
      const to = join(ownerRoot, segment);
      if (seen.has(from)) continue;
      seen.add(from);
      rewrites.push({ from, to });
    }
  }
  return rewrites;
}

/**
 * The bound Project directory for every (taskId, projectId), read from the
 * authoritative `task_records.projectBindings`. This is the identity the v20
 * runtime uses to address an integration worktree, so the migration relocates to
 * the same segment rather than guessing from the Project name.
 */
function boundDirectories(db: Database.Database): Map<string, string> {
  const bound = new Map<string, string>();
  if (!tableExists(db, "task_records")) return bound;
  const rows = db
    .prepare("SELECT task_id, payload FROM task_records")
    .all() as Array<{ task_id: string; payload: string }>;
  for (const row of rows) {
    let task: { projectBindings?: Array<{ projectId?: unknown; directory?: unknown }> };
    try {
      task = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (!Array.isArray(task.projectBindings)) continue;
    for (const binding of task.projectBindings) {
      if (typeof binding.projectId === "string" && typeof binding.directory === "string") {
        bound.set(`${row.task_id} ${binding.projectId}`, binding.directory);
      }
    }
  }
  return bound;
}

/**
 * The single-layer owner root for a workspace. For every owner except an
 * Integration attempt this is exactly the recorded v19 view root (`main`,
 * `work-items/<id>`, `reviews/<name>`, `execution-lanes/<g>/<l>`), which becomes
 * the real worktree's parent unchanged. An Integration attempt's v19 root was
 * its physical worktree under `worktree/`, so it is remapped to a NEW owner root
 * `<home>/workspaces/tasks/<taskId>/integrations/<integrationId>`.
 */
function newOwnerRoot(
  home: string,
  workspace: ParsedWorkspace
): string | undefined {
  const owner = workspace.owner;
  if (owner === undefined || typeof owner.taskId !== "string") return undefined;
  if (owner.type === "integration-attempt") {
    if (typeof owner.integrationAttemptId !== "string") return undefined;
    return join(home, "workspaces", "tasks", owner.taskId, "integrations", owner.integrationAttemptId);
  }
  return typeof workspace.root === "string" ? resolve(workspace.root) : undefined;
}

/** The workspace payload fields this migration reads (owner identity, root, entries). */
type ParsedWorkspace = Readonly<{
  owner?: {
    type?: string;
    taskId?: unknown;
    integrationAttemptId?: unknown;
  };
  root?: unknown;
  entries: Array<{ projectId?: unknown; directory?: unknown; access?: unknown; path?: unknown }>;
}>;

function parseWorkspace(payload: string): ParsedWorkspace | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const entries = (parsed as { entries?: unknown }).entries;
  return {
    owner: (parsed as ParsedWorkspace).owner,
    root: (parsed as { root?: unknown }).root,
    entries: Array.isArray(entries) ? entries : []
  };
}

/** True when a table currently exists (a read-only preflight may run at v19). */
function tableExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * Refuse to migrate a pointer a non-terminal Job is bound to: a queued/running
 * `durable_jobs` whose workspace (or a step cwd) lies under a relocating
 * worktree, whose detached runner survives the Controller fence. `active_turns`
 * is deliberately NOT consulted — it holds steady-state pointers for every
 * active Task and would over-refuse.
 */
function assertNoInFlightJobUnderRoots(
  db: Database.Database,
  roots: readonly string[]
): void {
  const blockers = collectInFlightJobBlockers(db, roots);
  if (blockers.length > 0) throw new Error(blockers[0]);
}

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
          "Refusing to collapse the managed worktree layout: a queued or running durable Job"
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
 * step REFUSE: a publish target that already exists AND is not the regenerable
 * v19 view symlink this migration is entitled to replace. A symlink target is
 * expected (it is the view pointer the real worktree supersedes); a real
 * directory or file there is a foreign conflict or residue from a failed run.
 */
function collectRelocationConflicts(
  relocations: readonly PathRewrite[]
): readonly CollapseWorktreePreflightBlocker[] {
  const blockers: CollapseWorktreePreflightBlocker[] = [];
  for (const move of relocations) {
    if (!targetConflicts(move.to)) continue;
    blockers.push({
      reason: "target-conflict",
      detail: `the relocation target ${move.to} already exists and is not the expected v19 view `
        + `symlink; it is a foreign directory or residue from a failed prior run. Confirm the `
        + `source at ${move.from} is intact, then move or remove ${move.to} before retrying the upgrade`
    });
  }
  return blockers;
}

/** True when the publish target exists as something other than a symlink. */
function targetConflicts(to: string): boolean {
  let stat;
  try {
    stat = lstatSync(to);
  } catch {
    return false;
  }
  return !stat.isSymbolicLink();
}

/**
 * A content-addressed inventory digest of a tree: for every path in
 * deterministic order, the relative path, kind, and either the file size + byte
 * content or the symlink target. Two trees with an identical digest are byte-for
 * -byte identical in structure and content — the proof a replica is faithful.
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
        hash.update(`O ${relPath}\0`);
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

/**
 * Copy one managed worktree into its single-layer location, NON-DESTRUCTIVELY to
 * the source. The regenerable v19 view symlink occupying the exact target is
 * unlinked first (it is a pointer the real worktree supersedes); a real
 * directory or file there is a foreign conflict and is refused. The source is
 * copied to a same-filesystem staging directory, the replica's content digest is
 * verified against the source, and only a verified replica is atomically renamed
 * into place. The original under `worktree/` is PRESERVED as the rollback anchor.
 *
 * Offline and single-shot. Any throw happens before the atomic rename, so the
 * source is left intact and nothing is published; recovery is a manual re-run.
 */
function relocateWorktree(from: string, to: string): void {
  const staging = `${to}.incoming`;

  // The v19 view symlink at the target is the regenerable pointer the real
  // worktree replaces: unlink it so the publish rename has a clear target. A
  // non-symlink at the target is never silently adopted.
  let existing;
  try {
    existing = lstatSync(to);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `Refusing to collapse the managed worktree layout: the relocation target ${to} already `
          + `exists and is not the expected v19 view symlink. It is a foreign directory or residue `
          + `from a failed prior run. Confirm the source at ${from} is intact, then move or remove `
          + `${to} and re-run the upgrade.`
      );
    }
    unlinkSync(to);
  }
  if (!existsSync(from)) {
    // The source worktree was never materialised on disk (a stale registry row);
    // nothing to copy. Its pointer is still rewritten and re-prepared at launch.
    return;
  }

  const sourceDigest = treeInventoryDigest(from);
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  rmSync(staging, { recursive: true, force: true });
  // Copy (never move) so the original survives as the rollback anchor even if
  // this transaction later throws. Symlinks and Git admin files are verbatim.
  cpSync(from, staging, { recursive: true, verbatimSymlinks: true });
  if (treeInventoryDigest(staging) !== sourceDigest) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `Refusing to collapse the managed worktree layout: the relocated copy of ${from} did not `
        + `match the source content after copying. The original is untouched; re-run the upgrade.`
    );
  }
  renameSync(staging, to);
}

/**
 * After the worktrees are copied, the copies' absolute Git pointers still
 * reference the OLD `worktree/` locations. They are corrected in two steps, per
 * (Task, Project) group: (1) deterministically REWRITE, in the NEW copy only,
 * each worktree cross-reference pointer file (a linked worktree's `.git` stub
 * and each main clone's `.git/worktrees/<name>/gitdir`) from the OLD path to the
 * NEW path, so no native git command chases a stale pointer back into and
 * mutates the preserved OLD source; then (2) run `git worktree repair` from the
 * main clone at its NEW path as a belt-and-braces reconciliation, now confined
 * to the NEW tree. A repair FAILURE IS FATAL: the transaction rolls back.
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
    const workspace = parseWorkspace(row.payload);
    if (workspace === undefined) continue;
    const taskId = typeof workspace.owner?.taskId === "string" ? workspace.owner.taskId : undefined;
    if (taskId === undefined) continue;
    for (const entry of workspace.entries) {
      // Only real worktrees (write entries) are relocated and repaired; a
      // read-only alias is a symlink view rebuilt at launch, never a Git tree.
      if (entry.access !== "write") continue;
      if (typeof entry.projectId !== "string" || typeof entry.path !== "string") continue;
      // Derive the new path from the SAME relocation map used to copy the tree,
      // so plan and repair can never disagree. A write entry already single-layer
      // (no map match) yields undefined and is skipped.
      const newPath = applyPrefix(resolve(entry.path), rewrites);
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
    // row) has nothing to repair and is re-prepared lazily on next launch. A
    // main that DOES exist but fails to repair is a real integrity failure.
    if (main === undefined || !existsSync(main)) continue;
    const linked = [...group.linked].filter((path) => existsSync(path));
    relinkWorktreePointers(main, linked, rewrites);
    execFileSync("git", ["-C", main, "worktree", "repair", ...linked], {
      stdio: "ignore",
      timeout: 60_000
    });
  }
}

/**
 * Rewrite, in the NEW copy only, the worktree cross-reference pointer files so
 * every path under a relocating OLD worktree is repointed to its NEW location:
 * each main clone's `.git/worktrees/<name>/gitdir` (-> `<linked>/.git`) and each
 * linked worktree's `.git` stub (-> `<main>/.git/worktrees/<name>`). Only OLD->
 * NEW prefixes are substituted, so a pointer already NEW or outside every
 * relocating root is left untouched. Nothing outside the NEW copy is touched.
 */
function relinkWorktreePointers(
  main: string,
  linked: readonly string[],
  rewrites: readonly PathRewrite[]
): void {
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
  for (const worktree of linked) {
    relinkPointerFile(join(worktree, ".git"), rewrites);
  }
}

/**
 * Rewrite a single Git pointer file's stored path with the OLD->NEW prefix map,
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
 * payload `root` and every `entries[].path`, all via the SAME OLD->NEW leaf map.
 * Every surviving row is a live workspace, so all are rewritten. The map is keyed
 * on each write worktree's old physical path, which makes the rewrite uniform
 * across owners: an Integration attempt (whose v19 `root` and single write entry
 * BOTH hold the old leaf path) and a read-only alias (whose entry path is the
 * Task main's old leaf) are both rewritten by the same prefix substitution, while
 * a Task/WorkItem/Review/lane `root` already addresses the unchanged Task view
 * directory and is left as-is because no map key matches it. Timestamps are
 * untouched so a live mirror stays deep-equal to its row.
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
    const rewritten = rewriteRegistryWorkspace(workspace, rewrites);
    const newPayload = JSON.stringify(rewritten);
    if (newPath === row.path && newPayload === row.payload) continue;
    update.run(newPath, newPayload, row.owner_kind, row.owner_id);
  }
}

/**
 * Rewrite the live launch cwd carried by each active AgentRun. The actual OS cwd
 * is derived from `run.effective.workspace`, and `validateRun` requires
 * `run.workspace` (when present) to stay identical to it, so BOTH are rewritten
 * with the same prefix map — never one without the other. Terminal runs and
 * `.result.systemEvidence.workspaceSnapshot` are frozen evidence.
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
 * Rewrite each live native session's frozen launch cwd. A session in the
 * `sessions` map is a resumable live binding whose `effective.workspace` is the
 * cwd a resume would relaunch under. Terminal sessions in `history` are frozen
 * evidence. Both the per-Task and global session stores carry the same shape.
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
 * still exists) and each OPEN execution lane's live launch pointers. An orphaned
 * mirror and any terminal lane are frozen evidence.
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
 * WorkItemCandidate snapshot is frozen evidence; only an open lane is live.
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
 * Rewrite one lane's `effective.workspace` (root + entries) and `workspace.root`.
 * A lane's root already addresses the Task `execution-lanes/<g>/<l>` view
 * directory and is unchanged by the map; its writable entries' paths are the
 * relocating worktrees. Returns the same reference when unchanged.
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
 * Rewrite the live launch cwd on each Role. Active Roles under a Task root also
 * self-heal via `prepareTaskWorkspace`, but a Draft's planning Role is never
 * prepared until activation, so rewriting here is its only correction. A cwd
 * outside every relocated root is left as-is.
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
 * Defensively rewrite `task_records.cwd`. It self-heals to the freshly resolved
 * Task root on the next `prepareTaskWorkspace`, but rewriting here closes the
 * window in which a reader could observe a stale cwd. Not gate-validated.
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
 * kind. Distinguishes a live embedded mirror (row present) from frozen evidence.
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
 * rewritten. Key order and untouched fields are preserved. Used for launch
 * pointers OUTSIDE `managed_workspaces`; the registry rewriter handles the
 * Integration root exception itself.
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

/**
 * Return a copy of a registry ManagedWorkspace with `root` and every
 * `entries[].path` prefix-rewritten, AND every `entries[].directory` resynced to
 * the basename of its rewritten path. In the single-layer v20 layout a managed
 * worktree always lives at `join(root, directory)`, so `directory` must equal
 * `basename(path)`; consumers reconstruct the worktree location as
 * `join(dirname(entry.path), entry.directory)`. For a Task/WorkItem/Review/lane
 * write entry and every read alias the basename already equals the stored
 * directory, so the resync is a no-op; for an Integration attempt (whose v19
 * `directory` was the Project name but whose relocated path now ends in the bound
 * directory) it rewrites the segment to match, reproducing the native v20 record.
 * Used ONLY for `managed_workspaces`; launch-pointer mirrors elsewhere carry no
 * integration entry and use {@link rewriteWorkspaceObject}.
 */
function rewriteRegistryWorkspace(
  workspace: Record<string, unknown>,
  rewrites: readonly PathRewrite[]
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...workspace };
  if (typeof workspace.root === "string") {
    next.root = applyPrefix(workspace.root, rewrites) ?? workspace.root;
  }
  if (Array.isArray(workspace.entries)) {
    next.entries = workspace.entries.map((entry) => {
      if (entry === null || typeof entry !== "object") return entry;
      const path = (entry as { path?: unknown }).path;
      if (typeof path !== "string") return entry;
      const newPath = applyPrefix(path, rewrites);
      if (newPath === undefined) return entry;
      return { ...(entry as Record<string, unknown>), path: newPath, directory: basename(newPath) };
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
      return join(to, nested);
    }
  }
  return undefined;
}

/** True when `value` is `root` or lies beneath it. */
function isUnderRoot(value: string, root: string): boolean {
  if (value === root) return true;
  const nested = relative(root, value);
  return nested.length > 0 && !nested.startsWith("..") && !isAbsolute(nested);
}

/** True when `value` is one of `roots` or lies beneath one of them. */
function isUnderAnyRoot(value: string, roots: readonly string[]): boolean {
  return roots.some((root) => isUnderRoot(value, root));
}
