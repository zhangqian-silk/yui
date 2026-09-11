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

import {
  isLinuxProcessLive,
  listOwnedProcessTree,
  type SessionOwnerIdentity
} from "../../runtime/sessionOwnerIdentity.js";

/**
 * Storage 18 -> 19: unify every Yui self-managed path under a single canonical
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
 * FROZEN migration. Its behaviour must never change once released, so it inlines
 * the target layout instead of importing runtime path helpers, and runtime code
 * must not depend on this module. The approved short-path IPC sockets
 * (Controller, tmux, Agent Host, and the integration runtime under `/tmp`) are
 * never touched: their paths do not start with a relocated managed root, so the
 * prefix-anchored rewrite leaves them exactly as they were.
 */
export const UNIFY_HOME_LAYOUT_SQL =
  "SELECT 1; -- data/fs-transform: unify self-managed paths under canonical YUI_HOME";

/** Name of the operator-facing recovery record written before any move. */
const RECOVERY_MANIFEST = "unify-home-migration.json";

/** DurableJob statuses that are not terminal: a runner may still be executing. */
const NON_TERMINAL_JOB_STATUSES = ["queued", "running"] as const;

type PathRewrite = Readonly<{ from: string; to: string }>;

type RecoveryManifest = {
  version: 19;
  startedAt: string;
  home: string;
  moves: Array<{ from: string; to: string; state: "planned" | "completed" }>;
};

/**
 * Copy the one durable managed tree into Home (verifying the replica and
 * preserving the original), repair the copied Git worktrees, then rewrite only
 * the persisted pointers the runtime trusts as live. Runs inside the upgrade
 * transaction: a throw rolls the schema back to 18 while the recovery manifest
 * and idempotent, source-preserving copy let the fenced upgrade be retried to
 * completion without ever losing the original content.
 */
export function migrateUnifyHomeLayout(db: Database.Database): void {
  const home = resolve(dirname(db.name));
  const { relocations, rewrites } = planUnifyHomeRewrites(home, readDefaultWorkspace(db));

  if (rewrites.length === 0) return;

  // Precheck — no filesystem or row mutation happens before this passes. Two
  // independent in-flight signals must both be clear, because the upgrade fence
  // (Controller quiesce) stops only in-process scheduling, NOT the detached
  // execution processes and durable Job runners that outlive it:
  //   1. A physically LIVE Agent execution whose process tree is cwd'd or holds
  //      an open write handle under a tree about to be copied — it would keep
  //      writing the OLD tree after the verified copy, silently diverging from
  //      the relocated pointers. Proven from the enumerable session-owner
  //      registry (OS process custody, PID-reuse-safe), fail-closed when a live
  //      owner cannot be introspected.
  //   2. A queued/running durable Job bound under a relocating root (its
  //      detached runner survives the fence).
  const oldRoots = rewrites.map((move) => move.from);
  assertNoLiveExecutionUnderRoots(home, oldRoots);
  assertNoInFlightJobUnderRoots(db, oldRoots);

  // Physically relocate the durable tree(s) under a fail-closed recovery
  // manifest. Only touch the manifest when there is real work: a tree exists to
  // copy, or a prior interrupted run left a manifest to finish. A fresh Home (or
  // one whose managed trees were never created) has nothing to relocate and must
  // not leave a spurious recovery record behind.
  const manifestPath = join(home, "backups", RECOVERY_MANIFEST);
  const hasTreesToMove = relocations.some((move) => existsSync(move.from));
  if (relocations.length > 0 && (hasTreesToMove || existsSync(manifestPath))) {
    const manifest = loadOrStartManifest(manifestPath, home, relocations);
    for (const move of relocations) {
      relocateTree(move.from, move.to, manifest, manifestPath);
    }
    repairRelocatedWorktrees(db, rewrites);
    finalizeManifest(manifestPath, manifest);
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
 * (in-flight execution, in-flight Job, target conflict, corrupt manifest), so a
 * clean preflight is a genuine — not merely schema-level — readiness signal.
 */
export type UnifyHomePreflightBlocker = Readonly<{
  reason:
    | "live-execution"
    | "in-flight-job"
    | "target-conflict"
    | "recovery-manifest"
    | "registry-unreadable";
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
 * `--update-preflight` report a trustworthy verdict — target conflicts and
 * in-flight risk are surfaced before the Controller is stopped, not discovered
 * only inside the apply transaction.
 *
 * Every branch collects rather than throws, so one run reports all independent
 * blockers. The checks mirror execute exactly, keeping the two in lockstep.
 */
export function preflightUnifyHomeLayout(db: Database.Database): UnifyHomePreflight {
  const home = resolve(dirname(db.name));
  const { relocations, rewrites } = planUnifyHomeRewrites(home, readDefaultWorkspace(db));
  if (rewrites.length === 0) {
    return Object.freeze({ noop: true, plannedRelocations: 0, plannedRewrites: 0, blockers: [] });
  }

  const blockers: UnifyHomePreflightBlocker[] = [];
  const oldRoots = rewrites.map((move) => move.from);
  for (const detail of collectLiveExecutionBlockers(home, oldRoots)) {
    blockers.push({ reason: detail.reason, detail: detail.detail });
  }
  for (const detail of collectInFlightJobBlockers(db, oldRoots)) {
    blockers.push({ reason: "in-flight-job", detail });
  }
  // Target-conflict and recovery-manifest checks read the same filesystem state
  // relocateTree/loadOrStartManifest act on, without copying or writing anything.
  for (const detail of collectRelocationConflicts(home, relocations)) {
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
 * Read-only detection of the filesystem conditions that would make the relocate
 * step REFUSE: a corrupt/foreign recovery manifest, or a relocation target that
 * already exists with content that does not match its source (a foreign
 * conflict). Mirrors `loadOrStartManifest` and `relocateTree`'s refusal branches
 * WITHOUT copying, staging, or writing anything, so a dry-run/preflight verdict
 * reflects the same decisions execute would make. An interrupted-publish target
 * (digest matches) is NOT a blocker — execute would adopt it.
 */
function collectRelocationConflicts(
  home: string,
  relocations: readonly PathRewrite[]
): readonly UnifyHomePreflightBlocker[] {
  const blockers: UnifyHomePreflightBlocker[] = [];

  // Manifest gate (fail-closed): only meaningful when there is work to do.
  const manifestPath = join(home, "backups", RECOVERY_MANIFEST);
  const hasTreesToMove = relocations.some((move) => existsSync(move.from));
  if ((hasTreesToMove || existsSync(manifestPath)) && existsSync(manifestPath)) {
    let prior: unknown;
    let parseError: string | undefined;
    try {
      prior = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    if (parseError !== undefined) {
      blockers.push({
        reason: "recovery-manifest",
        detail: `the recovery manifest at ${manifestPath} is not valid JSON (${parseError}); `
          + "inspect and remove it once you have confirmed no partial relocation is in progress"
      });
    } else if (!isRecoveryManifest(prior)) {
      blockers.push({
        reason: "recovery-manifest",
        detail: `the recovery manifest at ${manifestPath} is not a recognised storage-19 record; `
          + "inspect and remove it once you have confirmed no partial relocation is in progress"
      });
    } else {
      const identityMismatch = manifestIdentityMismatch(prior, home, relocations);
      if (identityMismatch !== undefined) {
        blockers.push({
          reason: "recovery-manifest",
          detail: `the recovery manifest at ${manifestPath} does not match the migration now `
            + `planned (${identityMismatch}); inspect and remove it once you have confirmed no `
            + "partial relocation is in progress"
        });
      }
    }
  }

  // Target-conflict gate: a target present with DURABLE content differing from
  // its preserved source is a foreign directory execute would refuse to
  // overwrite. The comparison is repair-invariant — identical to the digest
  // `relocateTree` uses to adopt an interrupted publish and to re-verify a
  // completed relocation — so a target git has already relinked (its `.git`
  // stub and `worktrees/<name>/gitdir` back-pointer repointed to the new
  // location) is NOT falsely flagged. Using the plain inventory digest here
  // would diverge from execute: it would block a published/relinked target
  // that execute would cleanly adopt or skip.
  for (const move of relocations) {
    if (!existsSync(move.to) || !existsSync(move.from)) continue;
    let matches: boolean;
    try {
      matches = repairInvariantDigest(move.to) === repairInvariantDigest(move.from);
    } catch (error) {
      blockers.push({
        reason: "target-conflict",
        detail: `the relocation target ${move.to} could not be compared with its source `
          + `(${error instanceof Error ? error.message : String(error)}); resolve access to both `
          + "trees before retrying"
      });
      continue;
    }
    if (!matches) {
      blockers.push({
        reason: "target-conflict",
        detail: `the relocation target ${move.to} already exists and does not match the source `
          + `content at ${move.from}; move or remove the conflicting directory before upgrading`
      });
    }
  }
  return blockers;
}

/**
 * Refuse to relocate a tree a physically LIVE Agent execution is still writing.
 *
 * The upgrade fence quiesces the Controller, but a Provider/Agent Host process
 * runs DETACHED and outlives that quiesce (it is not one of the in-process loops
 * `shutdownAndDrain` awaits). If such a process is cwd'd under, or holds an open
 * writable handle into, a tree we are about to copy-and-repoint, it would keep
 * writing the OLD location after the verified copy — a silent in-flight move
 * (criterion 2). We therefore consult the durable, enumerable session-owner
 * registry (`<home>/runtime/session-owners/`), which records concrete OS process
 * custody and survives Controller restarts, and prove each owner ABSENT before
 * proceeding.
 *
 * This uses only existing precise run facts — it never stops another session and
 * never equates a durable active Run pointer with a live process. It is
 * FAIL-CLOSED: a live owner whose write-safety cannot be positively established
 * (its process tree, cwd, or descriptors are unreadable) is treated as a
 * blocker, with actionable diagnostics, rather than assumed idle.
 */
function assertNoLiveExecutionUnderRoots(
  home: string,
  roots: readonly string[]
): void {
  const blockers = collectLiveExecutionBlockers(home, roots);
  if (blockers.length > 0) {
    throw new Error(
      "Refusing to unify YUI_HOME layout: a live Agent execution is still bound to a managed "
        + "tree under relocation, so copying it now would silently strand its writes at the old "
        + `location. Blockers: ${blockers.map((blocker) => blocker.detail).join("; ")}. Quiesce these `
        + "executions (let them finish or stop them from their own sessions), confirm with "
        + "`yui doctor`, then retry the upgrade."
    );
  }
}

/**
 * Read-only enumeration of live-execution write-safety blockers. Never throws:
 * a registry/record that cannot be read is itself reported as a blocker (reason
 * `registry-unreadable`), so the read-only preflight and the throwing execute
 * path reach the identical verdict. No filesystem mutation.
 */
function collectLiveExecutionBlockers(
  home: string,
  roots: readonly string[]
): readonly UnifyHomePreflightBlocker[] {
  const enumeration = listSessionOwnerRecords(home);
  if (enumeration.unreadable !== undefined) {
    return [{ reason: "registry-unreadable", detail: enumeration.unreadable }];
  }
  const blockers: UnifyHomePreflightBlocker[] = [];
  for (const record of enumeration.records) {
    if (record.malformed !== undefined) {
      blockers.push({ reason: "registry-unreadable", detail: record.malformed });
      continue;
    }
    const owner = record.owner!;
    const { pid, startIdentity } = owner.providerRoot;
    // A dead Provider root cannot write; its record is stale (reconciliation
    // prunes it). Liveness is proven from /proc with a PID-reuse-safe identity
    // check, exactly as live-reference GC does.
    if (!isLinuxProcessLive(pid, startIdentity)) continue;

    // The owner is live. Establish, POSITIVELY, that neither it nor any process
    // in its owned tree is writing under a relocating root. Any gap in that
    // proof is a blocker, not a pass.
    const overlap = liveOwnerWriteOverlap(owner, roots);
    if (overlap !== undefined) {
      blockers.push({
        reason: "live-execution",
        detail: `session owner pid ${pid} (${describeOwner(owner)}) ${overlap}`
      });
    }
  }
  return blockers;
}

type SessionOwnerRecordRead = Readonly<{
  owner?: SessionOwnerIdentity;
  malformed?: string;
}>;

type SessionOwnerEnumeration = Readonly<{
  records: readonly SessionOwnerRecordRead[];
  /** Set when the directory itself could not be enumerated (fail-closed). */
  unreadable?: string;
}>;

/**
 * Enumerate session-owner custody records without throwing. A directory that
 * cannot be read yields `unreadable`; an individual record that cannot be parsed
 * yields a per-record `malformed` note. Both are fail-closed signals the callers
 * surface as blockers — never as "no live writer".
 */
function listSessionOwnerRecords(home: string): SessionOwnerEnumeration {
  const directory = join(home, "runtime", "session-owners");
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [] };
    }
    return {
      records: [],
      unreadable:
        `the session-owner registry at ${directory} is unreadable `
        + `(${error instanceof Error ? error.message : String(error)}), so live executions cannot `
        + "be ruled out; resolve the permission/IO problem, confirm no execution is running, then retry"
    };
  }
  const records: SessionOwnerRecordRead[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(directory, entry);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      records.push({
        malformed:
          `the session-owner record at ${path} is unreadable `
          + `(${error instanceof Error ? error.message : String(error)}); inspect it once you have `
          + "confirmed no execution is running, remove it, then retry"
      });
      continue;
    }
    const record = parsed as {
      providerRoot?: { pid?: unknown; startIdentity?: unknown; processGroupId?: unknown };
      owner?: { scope?: unknown; taskId?: unknown; roleName?: unknown };
      runtimeRoot?: unknown;
    };
    const pid = record.providerRoot?.pid;
    const startIdentity = record.providerRoot?.startIdentity;
    if (typeof pid !== "number" || pid <= 0 || typeof startIdentity !== "string") {
      records.push({
        malformed:
          `the session-owner record at ${path} has no valid provider-root identity, so a live `
          + "execution cannot be ruled out; inspect and remove it once you have confirmed no "
          + "execution is running, then retry"
      });
      continue;
    }
    records.push({ owner: record as unknown as SessionOwnerIdentity });
  }
  return { records };
}

/**
 * Positively establish whether a LIVE owner overlaps any relocating root. Returns
 * a human-readable reason when it does OR when write-safety cannot be proven
 * (fail-closed), and `undefined` only when the owner is provably clear.
 */
function liveOwnerWriteOverlap(
  owner: SessionOwnerIdentity,
  roots: readonly string[]
): string | undefined {
  // 1. A recorded runtimeRoot under a relocating root is itself an overlap — the
  //    execution's disposable roots would move under it. (Runtime roots are
  //    pointer-rewritten, but a LIVE writer there is still an in-flight move.)
  if (
    typeof owner.runtimeRoot === "string"
    && owner.runtimeRoot.length > 0
    && isUnderAnyRoot(resolve(owner.runtimeRoot), roots)
  ) {
    return `has a live runtime root under ${owner.runtimeRoot}`;
  }

  // 2. Inspect the owned process tree's actual cwds and open writable handles.
  //    listOwnedProcessTree proves ownership by process-group / ancestry, never
  //    by name or shared cwd, so we do not implicate unrelated processes.
  const tree = listOwnedProcessTree(
    owner.providerRoot.pid,
    owner.providerRoot.processGroupId
  );
  if (tree.length === 0) {
    // The root is live (checked by the caller) yet we cannot enumerate its tree.
    // We cannot prove it is clear, so fail closed.
    return "is live but its process tree could not be read to prove write-safety";
  }
  for (const process of tree) {
    const cwd = readProcessCwd(process.pid);
    if (cwd === undefined) {
      // A live owned process whose cwd we cannot read is an unprovable writer.
      return `includes pid ${process.pid} whose working directory could not be read`;
    }
    if (isUnderAnyRoot(resolve(cwd), roots)) {
      return `includes pid ${process.pid} working under ${cwd}`;
    }
    const writtenPath = firstWriteHandleUnderRoots(process.pid, roots);
    if (writtenPath !== undefined) {
      return `includes pid ${process.pid} holding an open handle under ${writtenPath}`;
    }
  }
  return undefined;
}

/** A live process's cwd via /proc, or undefined when it cannot be read. */
function readProcessCwd(pid: number): string | undefined {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return undefined;
  }
}

/**
 * The first open regular-file descriptor a process holds under any relocating
 * root, or undefined when it holds none. Sockets/pipes/anon inodes are ignored;
 * an unreadable fd directory returns undefined (the cwd check above already
 * fails closed for a live process we cannot introspect).
 */
function firstWriteHandleUnderRoots(
  pid: number,
  roots: readonly string[]
): string | undefined {
  let fds: string[];
  try {
    fds = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return undefined;
  }
  for (const fd of fds) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    } catch {
      continue;
    }
    if (
      target.startsWith("socket:")
      || target.startsWith("pipe:")
      || target.startsWith("anon_inode:")
    ) {
      continue;
    }
    if (isUnderAnyRoot(resolve(target), roots)) return target;
  }
  return undefined;
}

/** Compact owner description for a blocker diagnostic. */
function describeOwner(owner: SessionOwnerIdentity): string {
  const scope = owner.owner.scope === "task" && owner.owner.taskId !== undefined
    ? `task ${owner.owner.taskId}`
    : "global";
  return `${scope}/${owner.owner.roleName}`;
}


function loadOrStartManifest(
  manifestPath: string,
  home: string,
  relocations: readonly PathRewrite[]
): RecoveryManifest {
  if (existsSync(manifestPath)) {
    let prior: unknown;
    try {
      prior = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Refusing to unify YUI_HOME layout: the recovery manifest at ${manifestPath} is not `
          + `valid JSON (${error instanceof Error ? error.message : String(error)}). Inspect and `
          + `remove it once you have confirmed no partial relocation is in progress, then retry.`
      );
    }
    if (!isRecoveryManifest(prior)) {
      throw new Error(
        `Refusing to unify YUI_HOME layout: the recovery manifest at ${manifestPath} is not a `
          + `recognised storage-19 record. Inspect and remove it once you have confirmed no `
          + `partial relocation is in progress, then retry.`
      );
    }
    // Structural validity is not enough: the record must describe THIS migration.
    // A manifest for a different Home, or one whose planned moves do not match the
    // relocations we just derived, would let `relocateTree` honour a `completed`
    // state (skipping a copy) for a move it never actually performed. Bind the
    // record's identity to the current plan before trusting any completion flag.
    const identityMismatch = manifestIdentityMismatch(prior, home, relocations);
    if (identityMismatch !== undefined) {
      throw new Error(
        `Refusing to unify YUI_HOME layout: the recovery manifest at ${manifestPath} does not `
          + `match the migration now planned (${identityMismatch}). Inspect and remove it once you `
          + `have confirmed no partial relocation is in progress, then retry.`
      );
    }
    return prior;
  }
  const manifest: RecoveryManifest = {
    version: 19,
    startedAt: new Date().toISOString(),
    home,
    moves: relocations.map((move) => ({ from: move.from, to: move.to, state: "planned" }))
  };
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/**
 * Verify a structurally-valid manifest describes the migration currently planned:
 * the same canonical Home, and a move set that covers exactly the planned
 * relocations (each planned `from`→`to` present; no extra moves for a foreign
 * plan). Returns a human-readable reason on mismatch, or undefined when the
 * manifest's identity is bound to this plan. A `completed` flag is only ever
 * trusted after this passes, so a stale/foreign manifest can never authorize
 * skipping a copy that was never performed for this Home.
 */
function manifestIdentityMismatch(
  manifest: RecoveryManifest,
  home: string,
  relocations: readonly PathRewrite[]
): string | undefined {
  if (resolve(manifest.home) !== resolve(home)) {
    return `it records Home ${manifest.home}, not ${home}`;
  }
  const recorded = new Map(manifest.moves.map((move) => [move.to, move.from]));
  for (const move of relocations) {
    const recordedFrom = recorded.get(move.to);
    if (recordedFrom === undefined) {
      return `it does not record the planned relocation to ${move.to}`;
    }
    if (resolve(recordedFrom) !== resolve(move.from)) {
      return `it maps ${move.to} from ${recordedFrom}, not the planned ${move.from}`;
    }
    recorded.delete(move.to);
  }
  const [extraTo] = recorded.keys();
  if (extraTo !== undefined) {
    return `it records an unplanned relocation to ${extraTo}`;
  }
  return undefined;
}

/** Structural guard for a persisted recovery manifest (fail-closed on anything else). */
function isRecoveryManifest(value: unknown): value is RecoveryManifest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 19 || typeof record.home !== "string") return false;
  if (!Array.isArray(record.moves)) return false;
  return record.moves.every((move) => {
    if (move === null || typeof move !== "object") return false;
    const entry = move as Record<string, unknown>;
    return typeof entry.from === "string"
      && typeof entry.to === "string"
      && (entry.state === "planned" || entry.state === "completed");
  });
}

function finalizeManifest(manifestPath: string, manifest: RecoveryManifest): void {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function markMoveCompleted(
  manifest: RecoveryManifest,
  manifestPath: string,
  move: PathRewrite
): void {
  const entry = manifest.moves.find((candidate) => candidate.to === move.to);
  if (entry !== undefined) entry.state = "completed";
  else manifest.moves.push({ from: move.from, to: move.to, state: "completed" });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function isCompleted(manifest: RecoveryManifest, target: string): boolean {
  return manifest.moves.some(
    (move) => move.to === target && move.state === "completed"
  );
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
 * True when a relative path is a Git worktree cross-reference pointer that
 * `git worktree repair` legitimately rewrites when a worktree tree is relocated:
 * a linked worktree's `.git` stub FILE, or a main clone's
 * `.git/worktrees/<name>/gitdir` back-pointer. Determined empirically: these two
 * file kinds are the ONLY ones repair mutates in a relocated tree (every durable
 * object, ref, index, and working-tree file is untouched). A `.git` DIRECTORY
 * (a main clone's real repository) is NOT a pointer and is never excluded.
 */
function isRepairVariantPointer(relPath: string, isFile: boolean): boolean {
  const parts = relPath.split("/");
  const base = parts[parts.length - 1];
  if (base === ".git" && isFile) return true;
  if (base === "gitdir" && parts.length >= 3 && parts[parts.length - 3] === "worktrees") {
    return true;
  }
  return false;
}

/**
 * Content digest of a tree that is INVARIANT under `git worktree repair`: it is
 * identical to {@link treeInventoryDigest} except it omits the repair-variant Git
 * pointer files ({@link isRepairVariantPointer}). Two trees with an equal
 * repair-invariant digest hold byte-for-byte identical DURABLE content (committed
 * objects, refs, index, and every tracked/untracked working file) even after one
 * has had its worktree links repaired to a new location. This is what lets the
 * idempotent completed-skip verify that a relocated tree still faithfully mirrors
 * its preserved source without falsely flagging the relink git performed on it.
 */
function repairInvariantDigest(root: string): string {
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
        // Skip the repair-variant pointer files entirely — their content is a
        // location detail git rewrites on relocate, not durable user content.
        if (isRepairVariantPointer(relPath, true)) continue;
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
 * Copy one managed subtree into Home, tolerant of interruption and NON-
 * DESTRUCTIVE to the source. The source is copied (never renamed away) to a
 * same-filesystem staging directory, the replica's content digest is verified
 * against the source, and only a verified replica is atomically renamed into
 * place. The original is PRESERVED as the rollback anchor; its removal is a
 * later, authorized cleanup step, never part of this transaction.
 *
 * Idempotent and identity-checked: a target already recorded completed is
 * re-verified against the preserved source (repair-invariant, since git will have
 * relinked the published copy) and then left alone; a target present but not yet
 * recorded is adopted only when its durable content matches the source (an
 * interrupted publish), and is otherwise refused as a foreign conflict. When the
 * source has been removed by an authorized post-success cleanup, a present target
 * is trusted ONLY because the manifest records this exact move completed — a
 * source-less target with no such record is refused, never heuristically adopted.
 * Failing before the atomic rename leaves the source intact and nothing
 * published, so a retry re-copies cleanly.
 */
function relocateTree(
  from: string,
  to: string,
  manifest: RecoveryManifest,
  manifestPath: string
): void {
  const staging = `${to}.incoming`;
  const targetExists = existsSync(to);
  const sourceExists = existsSync(from);

  if (isCompleted(manifest, to) && targetExists) {
    // A prior run copied, verified, published, and recorded this move. Do not
    // trust the manifest blindly: re-verify the published tree still faithfully
    // mirrors the preserved source, tolerant of the worktree relink git performed
    // on the copy after publication. (When the source was removed by an
    // authorized cleanup there is nothing left to compare against; the manifest
    // identity was already validated on load, so the target is authoritative.)
    if (sourceExists && repairInvariantDigest(to) !== repairInvariantDigest(from)) {
      throw new Error(
        `Refusing to unify YUI_HOME layout: the relocated tree at ${to} is recorded complete but `
          + `its durable content no longer matches the preserved source at ${from}. Do not delete `
          + `either tree; inspect both and restore the fenced backup to recover.`
      );
    }
    return;
  }

  if (!sourceExists) {
    // No source. A present target is trusted only via the completed-manifest path
    // above; without that proof we cannot establish the target is our relocated
    // tree, so we refuse rather than heuristically adopt a foreign directory.
    if (targetExists) {
      throw new Error(
        `Refusing to unify YUI_HOME layout: the source tree ${from} is missing and the target `
          + `${to} is not recorded as a completed relocation, so it cannot be verified as Yui's. `
          + `Inspect it and, once you have confirmed it is safe, remove it or restore the fenced `
          + `backup, then retry.`
      );
    }
    // Neither source nor target exists: the tree was never created. Nothing to do.
    return;
  }

  const sourceDigest = treeInventoryDigest(from);
  if (targetExists) {
    // Publish happened but completion was not recorded (crash between rename and
    // manifest write), OR the target is a foreign directory. Durable-content
    // identity decides — repair-invariant, because a crash AFTER the relink step
    // would leave the published copy already repointed.
    if (repairInvariantDigest(to) === repairInvariantDigest(from)) {
      markMoveCompleted(manifest, manifestPath, { from, to });
      return;
    }
    throw new Error(
      `Refusing to unify YUI_HOME layout: relocation target already exists and does not match `
        + `the source content: ${to}. Move or remove the conflicting directory, then retry the `
        + `upgrade. The original at ${from} is untouched.`
    );
  }
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
        + `source content after copying. The original is untouched; retry the upgrade.`
    );
  }
  // Atomic publish: staging and target share the Home filesystem.
  renameSync(staging, to);
  markMoveCompleted(manifest, manifestPath, { from, to });
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
 * is repointed to its NEW location. Two file kinds carry such absolute paths (see
 * {@link isRepairVariantPointer}):
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
