/**
 * Resource GC engine (Issue 10).
 *
 * Quarantine-first garbage collection for managed worktrees, deployments, and
 * runtime artifacts. Permanent deletion is always delayed behind an
 * observation window; anything whose ownership, cleanliness, or liveness
 * cannot be proven is retained and reported.
 *
 * Safety model:
 * - `planResourceGc` is strictly read-only: it discovers, scans, classifies,
 *   and returns a plan. It never writes the registry or moves files.
 * - `applyResourceGc` refreshes discovery and scans each physical subtree.
 *   Durable owners are re-read under SQLite's writer fence through the move.
 * - `purgeResourceQuarantine` scans both the original and quarantine paths;
 *   a file held open inside quarantine triggers a restore instead of deletion.
 * - `restoreAllResourceGc` is the explicit rollback entry point.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { TaskStore } from "../storage/taskStore.js";

import {
  scanLiveReferences,
  type LiveReferencePorts,
  type LiveReferenceScan
} from "./liveReferences.js";
import {
  discoverResources,
  type DiscoveredResource
} from "./resourceDiscovery.js";
import {
  isResourceQuarantinePath,
  removeResourceRecord,
  resourceQuarantineRoot,
  upsertResourceRecord
} from "./resourceRegistry.js";
import type { ResourceRegistryStore } from "./resourceRegistryStore.js";
import { withResourceRegistry } from "./resourceRegistryStore.js";
import {
  isReleasable,
  isTerminalTaskStatus,
  type ResourceRecord,
  type ResourceRegistryState
} from "./resourceTypes.js";

export const DEFAULT_QUARANTINE_TTL_HOURS = 24;

export type GcMode = "report" | "quarantine";

export type GcPlan = Readonly<{
  home: string;
  mode: GcMode;
  generatedAt: string;
  records: readonly ResourceRecord[];
  releasable: readonly ResourceRecord[];
  retained: readonly ResourceRecord[];
  quarantined: readonly ResourceRecord[];
  deleted: readonly ResourceRecord[];
  scan: LiveReferenceScan;
}>;

export type GcResult = Readonly<{
  planned: GcPlan;
  applied: readonly ResourceRecord[];
  failed: readonly ResourceRecord[];
  restored: readonly ResourceRecord[];
  purged: readonly ResourceRecord[];
}>;

export type ResourceGcInput = Readonly<{
  home: string;
  /** Registry store; when omitted the GC engine creates one from the Home. */
  registryStore?: ResourceRegistryStore;
  projects: readonly import("../repository/project.js").Project[];
  managedWorkspaces: readonly import("../worktree/managedWorkspace.js").ManagedWorkspace[];
  taskStatusById: ReadonlyMap<string, string>;
  mode: GcMode;
  now: Date;
  quarantineTtlHours?: number;
  environment?: NodeJS.ProcessEnv;
  tmuxServerName?: string;
  /** Test seam for live-reference sources; production callers omit it. */
  liveReferencePorts?: LiveReferencePorts;
  /**
   * Workspace paths claimed by active durable Jobs (AgentRuns). Production
   * callers compute these from the TaskStore; tests may omit them.
   */
  activeWorkspaceOwnerPaths?: readonly string[];
}>;

type ClassifiedResource = Readonly<{
  record: ResourceRecord;
  ownerTerminal: boolean;
}>;

/** One current snapshot shared by manual and automatic GC. The execution
 * boundary reads it again while holding the database's existing writer fence. */
export function readResourceGcState(store: TaskStore) {
  return store.readTransaction(reader => {
    const tasks = reader.listTasks();
    return {
      projects: reader.listProjects(),
      managedWorkspaces: tasks.flatMap(task => reader.listManagedWorkspaces(task.id)),
      taskStatusById: new Map(tasks.map(task => [task.id, task.status])),
      activeWorkspaceOwnerPaths: tasks.flatMap(task => [
        ...reader.listRuns(task.id).filter(run => run.status === "active").flatMap(run => {
          const workspace = run.workspace ?? run.effective.workspace;
          return [workspace.root, ...workspace.entries.map(entry => entry.path)];
        }),
        ...reader.listDurableJobs(task.id).filter(job => job.status === "queued" || job.status === "running"
          || (job.status === "unknown-needs-attention" && job.acknowledgedAt === undefined))
          .map(job => job.workspace)
      ])
    };
  });
}

function within(path: string, parent: string): boolean {
  const child = relative(resolve(parent), resolve(path));
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith("../"));
}

function currentDurableRefs(record: ResourceRecord, state: ReturnType<typeof readResourceGcState>): string[] {
  const refs: string[] = [];
  if (record.owner.taskId === undefined || !state.taskStatusById.has(record.owner.taskId)) {
    refs.push("owner-unproven");
  } else if (!isTerminalTaskStatus(state.taskStatusById.get(record.owner.taskId))) {
    refs.push("owner-not-terminal");
  }
  const paths = [
    ...state.managedWorkspaces.flatMap(workspace => [workspace.root, ...workspace.entries.map(entry => entry.path)]),
    ...state.activeWorkspaceOwnerPaths
  ];
  if (paths.some(path => within(path, record.path) || within(record.path, path))) refs.push("durable-owner");
  return refs;
}

/**
 * Plan a GC pass: discover resources, scan live references, and classify each
 * record. Planning is strictly read-only — it never writes the registry,
 * moves files, or restores quarantined resources.
 */
export async function planResourceGc(input: ResourceGcInput): Promise<GcPlan> {
  const home = resolve(input.home);
  const registry = withResourceRegistry(home, input.registryStore, store => store.load());
  const discovered = await discoverResources({
    home,
    projects: input.projects,
    managedWorkspaces: input.managedWorkspaces,
    taskStatusById: input.taskStatusById,
    now: input.now
  });
  const paths = discovered.map(({ record }) => record.path);
  // Also scan original paths of quarantined records so a new reference is
  // visible in the plan (restore itself happens in apply/purge/restore-all).
  appendRegistryScanPaths(registry, paths, home);
  const scan = await scanLiveReferences({
    home,
    paths,
    environment: input.environment,
    tmuxServerName: input.tmuxServerName,
    ports: {
      ...input.liveReferencePorts,
      managedWorkspaces: () => input.managedWorkspaces,
      activeWorkspaceOwners: () => collectActiveWorkspaceOwners(input)
    }
  });

  const classified = classifyDiscoveredResources(discovered, registry, scan, input, home);
  const records = classified.map(({ record }) => record);

  // Include quarantined records whose original path no longer hosts the
  // resource. They are reported as-is; restore is an explicit apply action.
  const discoveredIds = new Set(records.map((record) => record.id));
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition !== "quarantined" || discoveredIds.has(record.id)) continue;
    records.push(record);
  }

  return Object.freeze({
    home,
    mode: input.mode,
    generatedAt: input.now.toISOString(),
    records: Object.freeze(records),
    releasable: Object.freeze(records.filter((record) => record.disposition === "releasable")),
    retained: Object.freeze(records.filter((record) =>
      record.disposition === "active"
      || record.disposition === "retained-dirty"
      || record.disposition === "retained-unowned"
      || record.disposition === "retained-unproven"
      || record.disposition === "cleanup-failed"
    )),
    quarantined: Object.freeze(records.filter((record) => record.disposition === "quarantined")),
    deleted: Object.freeze(records.filter((record) => record.disposition === "deleted")),
    scan
  });
}

function appendRegistryScanPaths(
  registry: ResourceRegistryState,
  paths: string[],
  home: string
): void {
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (record.disposition === "quarantined" && record.quarantine !== undefined) {
      paths.push(record.quarantine.originalPath);
      continue;
    }
    if (record.disposition === "deleted") continue;
    if (isResourceQuarantinePath(home, record.path)) continue;
    if (existsSync(record.path)) paths.push(record.path);
  }
}

function classifyDiscoveredResources(
  discovered: readonly DiscoveredResource[],
  registry: ResourceRegistryState,
  scan: LiveReferenceScan,
  input: ResourceGcInput,
  home: string
): ClassifiedResource[] {
  const classified: ClassifiedResource[] = discovered.map(({ record, ownerTerminal }) => ({
    record: classifyRecord(record, ownerTerminal, scan, registry, input.now),
    ownerTerminal
  }));
  const discoveredIds = new Set(classified.map(({ record }) => record.id));
  for (const record of Object.values(registry.records) as ResourceRecord[]) {
    if (discoveredIds.has(record.id)) continue;
    if (record.disposition === "quarantined" || record.disposition === "deleted") {
      classified.push({ record, ownerTerminal: false });
      continue;
    }
    if (isResourceQuarantinePath(home, record.path) || !existsSync(record.path)) continue;
    const ownerTerminal = record.owner.taskId === undefined
      ? false
      : isTerminalTaskStatus(input.taskStatusById.get(record.owner.taskId) as never);
    classified.push({
      record: classifyRecord(record, ownerTerminal, scan, registry, input.now),
      ownerTerminal
    });
  }
  return classified;
}

/**
 * Collect active workspace owner path fragments from durable state.
 * These protect resources that an active Session, Job, or AgentRun still
 * references even when the Task itself is terminal.
 */
function collectActiveWorkspaceOwners(input: ResourceGcInput): readonly string[] {
  return input.activeWorkspaceOwnerPaths ?? [];
}

function classifyRecord(
  record: ResourceRecord,
  ownerTerminal: boolean,
  scan: LiveReferenceScan,
  registry: ResourceRegistryState,
  now: Date
): ResourceRecord {
  const liveRefs = scan.refsByPath.get(record.path) ?? [];
  const existing = registry.records[record.id];

  // A quarantined resource stays quarantined until purged or restored.
  if (existing?.disposition === "quarantined") {
    return existing;
  }
  if (existing?.disposition === "deleted") {
    return existing;
  }

  if (scan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      ...record,
      activeRefs: Object.freeze([...liveRefs]),
      disposition: "retained-unproven",
      blocker: "Live-reference source is untrusted; retained.",
      updatedAt: now.toISOString()
    };
  }

  const refs = [...liveRefs];
  if (refs.length > 0) {
    return { ...record, activeRefs: Object.freeze(refs), disposition: "active", updatedAt: now.toISOString() };
  }
  if (record.cleanliness === "dirty") {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "retained-dirty",
      blocker: dirtyWorktreeSuggestion(record),
      updatedAt: now.toISOString()
    };
  }
  if (record.cleanliness === "unknown") {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "retained-unproven",
      blocker: "Cleanliness cannot be proven; retained. Verify the worktree state manually.",
      updatedAt: now.toISOString()
    };
  }
  if (record.owner.basis === "unattributed") {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "retained-unowned",
      blocker: "Ownership cannot be proven; reported, never removed.",
      updatedAt: now.toISOString()
    };
  }
  if (!ownerTerminal) {
    return {
      ...record,
      activeRefs: Object.freeze([]),
      disposition: "active",
      blocker: "Owner is not terminal.",
      updatedAt: now.toISOString()
    };
  }
  return {
    ...record,
    activeRefs: Object.freeze([]),
    disposition: "releasable",
    updatedAt: now.toISOString()
  };
}

/** Suggest how to preserve dirty evidence before releasing a worktree. */
function dirtyWorktreeSuggestion(record: ResourceRecord): string {
  const path = record.path;
  return [
    "Worktree has uncommitted changes; preserve dirty evidence before release.",
    `  git -C ${path} diff > ${path}.patch`,
    `  git -C ${path} bundle create ${path}.bundle --all`,
    "  or commit the changes to a branch."
  ].join("\n");
}

/**
 * Apply a GC plan: quarantine every releasable resource. In `report` mode this
 * is a shadow pass — the plan is returned unchanged and nothing is mutated.
 *
 * Physical discovery is refreshed, each subtree gets a live-reference scan,
 * and current durable ownership is checked under the existing writer fence.
 * No registry connection is held across an asynchronous scan.
 */
export async function applyResourceGc(
  input: ResourceGcInput,
  plan: GcPlan,
  store: TaskStore
): Promise<GcResult> {
  if (plan.mode === "report") {
    return Object.freeze({
      planned: plan,
      applied: Object.freeze([]),
      failed: Object.freeze([]),
      restored: Object.freeze([]),
      purged: Object.freeze([])
    });
  }

  const home = resolve(input.home);
  if (resolve(store.rootDirectory()) !== home || resolve(plan.home) !== home) {
    throw new Error("GC plan, ownership Store and resource Home must match.");
  }
  const now = input.now;
  const applied: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];
  const restored: ResourceRecord[] = [];

  const fresh = await planResourceGc({ ...input, ...readResourceGcState(store) });
  const freshById = new Map(fresh.records.map(record => [record.id, record]));
  const retained = new Map(fresh.retained.map(record => [record.id, record]));
  const retain = (record: ResourceRecord, reason: string) => retained.set(record.id, {
    ...record, disposition: "retained-unproven", blocker: reason, updatedAt: now.toISOString()
  });
  const inspectedRegistry = withResourceRegistry(home, input.registryStore, registry => registry.load());
  const movedRoots: string[] = [];

  // Restore quarantined records whose owner is no longer terminal or that
  // gained a live reference. This is the apply-time counterpart of the old
  // planning-time restore: planning is read-only, so restore happens here.
  for (const record of Object.values(inspectedRegistry.records)) {
    if (record.disposition !== "quarantined" || record.quarantine === undefined) continue;
    withResourceRegistry(home, input.registryStore, registry => registry.transaction(() => {
      const before = registry.load();
      if (!isDeepStrictEqual(before.records[record.id], record)) throw new Error("Quarantine ownership changed; inspect and retry.");
      const refs = [...(fresh.scan.refsByPath.get(record.quarantine!.originalPath) ?? []),
        ...currentDurableRefs(record, readResourceGcState(store)).filter(ref => ref !== "owner-unproven")];
      if (refs.length === 0) return;
      const result = restoreQuarantinedRecord(record, refs, now);
      registry.save(upsertResourceRecord(before, result), before);
      (result.disposition === "active" ? restored : failed).push(result);
    }));
  }

  // A physical parent owns one move. Its unreferenced runtime descendants are
  // redundant registry receipts, not separately movable resources.
  for (const planned of [...plan.records].sort((a, b) => a.path.length - b.path.length)) {
    if (!isReleasable(planned)) continue;
    if (movedRoots.some(root => within(planned.path, root))) continue;
    const candidate = freshById.get(planned.id);
    if (!candidate || !isReleasable(candidate)) continue;
    const descendants = fresh.records.filter(record => record.id !== candidate.id
      && within(record.path, candidate.path) && existsSync(record.path));
    // Do not move a directory around independent Git worktrees or retained
    // descendants. Their own owner must release them first.
    if (descendants.some(record => record.kind !== "runtime-artifact" || !isReleasable(record))) {
      retain(candidate, "Directory contains independently owned or retained resources.");
      continue;
    }
    const scan = await scanLiveReferences({
      home, paths: [candidate.path, ...descendants.map(record => record.path)],
      environment: input.environment, tmuxServerName: input.tmuxServerName,
      ports: input.liveReferencePorts
    });
    if (scan.diagnostics.some(d => d.severity === "error")
      || [...scan.refsByPath.values()].some(refs => refs.length > 0)) {
      retain(candidate, "Current physical references prevent this subtree move.");
      continue;
    }
    withResourceRegistry(home, input.registryStore, registry => registry.transaction(() => {
      const before = registry.load();
      const subtree = Object.values(before.records).filter(record => within(record.path, candidate.path)
        && existsSync(record.path));
      for (const record of [candidate, ...subtree]) {
        if (!isDeepStrictEqual(before.records[record.id], inspectedRegistry.records[record.id])) {
          throw new Error(`Resource registry ownership changed: ${record.id}; inspect and retry.`);
        }
      }
      const state = readResourceGcState(store);
      if ([candidate, ...subtree].some(record => currentDurableRefs(record, state).length > 0)) {
        retain(candidate, "Current Task or workspace ownership prevents this subtree move.");
        return;
      }
      if (!existsSync(candidate.path)) return;
      const result = quarantineResource(home, candidate, now);
      let next = upsertResourceRecord(before, result.record);
      if (result.ok) {
        for (const record of subtree) {
          if (record.id !== candidate.id) next = removeResourceRecord(next, record.id);
        }
        movedRoots.push(candidate.path);
        applied.push(result.record);
      } else failed.push(result.record);
      registry.save(next, before);
    }));
  }
  return Object.freeze({
    planned: {
      ...fresh,
      records: fresh.records.map(record => retained.get(record.id) ?? record),
      retained: [...retained.values()],
      releasable: fresh.releasable.filter(record => !retained.has(record.id))
    },
    applied: Object.freeze(applied),
    failed: Object.freeze(failed),
    restored: Object.freeze(restored),
    purged: Object.freeze([])
  });
}

function quarantineResource(
  home: string,
  record: ResourceRecord,
  now: Date
): { ok: boolean; record: ResourceRecord } {
  const quarantineRoot = resourceQuarantineRoot(home);
  const quarantinePath = join(quarantineRoot, record.id);
  const receiptPath = `${quarantinePath}.receipt.json`;
  try {
    if (isGitWorktreePath(record.path)) {
      // Move the linked worktree, including its exact checkout and Git
      // metadata, into the Home-local quarantine. Restore is the inverse
      // move, so the recorded HEAD cannot drift with a branch.
      mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
      // Keep the existing SQLite writer fence through this bounded move, so a
      // Task reopen or new durable owner cannot commit between check and move.
      execFileSync(
        "git",
        ["-C", record.path, "worktree", "move", "--", record.path, quarantinePath],
        { timeout: 30_000 }
      );
      writeQuarantineReceipt(home, record, now, "move", receiptPath);
      return {
        ok: true,
        record: {
          ...record,
          disposition: "quarantined",
          quarantine: {
            path: quarantinePath,
            originalPath: record.path,
            movedAt: now.toISOString(),
            method: "move",
            ...(record.git === undefined ? {} : {
              gitRestore: {
                repositoryPath: record.git.repositoryPath,
                ...(record.git.branch === undefined ? {} : { branch: record.git.branch }),
                ...(record.git.head === undefined ? {} : { head: record.git.head })
              }
            })
          },
          updatedAt: now.toISOString()
        }
      };
    }
    // Non-Git artifact: move into the Home-local quarantine.
    mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
    renameSync(record.path, quarantinePath);
    writeQuarantineReceipt(home, record, now, "move", receiptPath);
    return {
      ok: true,
      record: {
        ...record,
        disposition: "quarantined",
        quarantine: {
          path: quarantinePath,
          originalPath: record.path,
          movedAt: now.toISOString(),
          method: "move"
        },
        updatedAt: now.toISOString()
      }
    };
  } catch (error) {
    return {
      ok: false,
      record: {
        ...record,
        disposition: "cleanup-failed",
        blocker: `Quarantine failed: ${error instanceof Error ? error.message : "unknown error"}`,
        updatedAt: now.toISOString()
      }
    };
  }
}

function writeQuarantineReceipt(
  _home: string,
  record: ResourceRecord,
  now: Date,
  method: "move",
  receiptPath: string
): void {
  try {
    mkdirSync(dirname(receiptPath), { recursive: true, mode: 0o700 });
    writeFileSync(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      id: record.id,
      kind: record.kind,
      originalPath: record.path,
      owner: record.owner,
      method,
      ...(record.git === undefined ? {} : { git: record.git }),
      movedAt: now.toISOString()
    }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A missing receipt does not block quarantine; the registry is authoritative.
  }
}

function isGitWorktreePath(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Restore a quarantined resource to its original path. Move-based Git
 * quarantine is reversed with `git worktree move`, preserving the exact
 * checkout. A different recorded method remains audit evidence and requires
 * separate recovery; it is never reinterpreted as a move or a fresh checkout.
 */
function restoreQuarantinedRecord(
  record: ResourceRecord,
  liveRefs: readonly string[],
  now: Date
): ResourceRecord {
  const quarantine = record.quarantine;
  if (quarantine === undefined) return record;
  try {
    if (quarantine.method !== "move" || !["worktree", "runtime-artifact"].includes(record.kind)) {
      throw new Error(`Unsupported quarantine provenance: ${record.kind}/${quarantine.method}; preserve its evidence for explicit recovery.`);
    }
    if (!existsSync(quarantine.path)) {
      return {
        ...record,
        disposition: "cleanup-failed",
        blocker: `Restore failed: quarantine path missing: ${quarantine.path}`,
        updatedAt: now.toISOString()
      };
    }
    if (existsSync(quarantine.originalPath)) {
      return {
        ...record,
        disposition: "cleanup-failed",
        blocker: `Restore failed: original path already exists: ${quarantine.originalPath}`,
        updatedAt: now.toISOString()
      };
    }
    mkdirSync(dirname(quarantine.originalPath), { recursive: true });
    if (isGitWorktreePath(quarantine.path)) {
      execFileSync(
        "git",
        ["-C", quarantine.path, "worktree", "move", "--", quarantine.path, quarantine.originalPath],
        { timeout: 30_000 }
      );
    } else {
      renameSync(quarantine.path, quarantine.originalPath);
    }
  } catch (error) {
    return {
      ...record,
      disposition: "cleanup-failed",
      blocker: `Restore failed: ${error instanceof Error ? error.message : "unknown error"}`,
      updatedAt: now.toISOString()
    };
  }
  return {
    ...record,
    disposition: "active",
    activeRefs: Object.freeze([...liveRefs]),
    quarantine: undefined,
    blocker: "Restored from quarantine.",
    updatedAt: now.toISOString()
  };
}

/**
 * Permanently delete quarantined resources whose observation window has
 * elapsed. A resource with a new live reference — on either the original or
 * the quarantine path — is restored instead.
 */
export async function purgeResourceQuarantine(
  home: string,
  options: {
    now: Date;
    ttlHours?: number;
    environment?: NodeJS.ProcessEnv;
    tmuxServerName?: string;
    managedWorkspaces?: readonly import("../worktree/managedWorkspace.js").ManagedWorkspace[];
    /** Test seam for live-reference sources; production callers omit it. */
    liveReferencePorts?: LiveReferencePorts;
  },
  store: TaskStore
): Promise<GcResult> {
  const resolvedHome = resolve(home);
  if (resolve(store.rootDirectory()) !== resolvedHome) throw new Error("GC ownership Store belongs to another Home.");
  const ttlHours = options.ttlHours ?? DEFAULT_QUARANTINE_TTL_HOURS;
  const ttlMs = ttlHours * 3_600_000;
  const registry = withResourceRegistry(resolvedHome, undefined, store => store.load());
  const quarantined = Object.values(registry.records)
    .filter((record) => record.quarantine !== undefined
      && (record.disposition === "quarantined" || record.disposition === "cleanup-failed"));

  // Re-scan live references for both original AND quarantine paths before
  // purging. A file held open inside quarantine must block deletion.
  const paths: string[] = [];
  for (const record of quarantined) {
    if (record.quarantine === undefined) continue;
    paths.push(record.quarantine.originalPath);
    paths.push(record.quarantine.path);
  }
  const scan = await scanLiveReferences({
    home: resolvedHome,
    paths,
    environment: options.environment,
    tmuxServerName: options.tmuxServerName,
    ports: {
      ...options.liveReferencePorts,
      managedWorkspaces: () => options.managedWorkspaces ?? [],
      activeWorkspaceOwners: () => []
    }
  });

  const purged: ResourceRecord[] = [];
  const restored: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];
  const scanUntrusted = scan.diagnostics.some((diagnostic) => diagnostic.severity === "error");

  for (const record of quarantined) {
    const quarantine = record.quarantine;
    if (quarantine === undefined) continue;
    const ageMs = options.now.getTime() - Date.parse(quarantine.movedAt);
    if (!Number.isFinite(ageMs) || ageMs < ttlMs) continue;
    // A live-reference source that cannot be trusted fails closed: keep the
    // resource quarantined instead of permanently deleting it.
    if (scanUntrusted) continue;

    withResourceRegistry(resolvedHome, undefined, registryStore => registryStore.transaction(() => {
      const before = registryStore.load();
      if (!isDeepStrictEqual(before.records[record.id], record)) throw new Error("Quarantine ownership changed; inspect and retry.");
      const save = (next: ResourceRecord) => registryStore.save(upsertResourceRecord(before, next), before);
      if (quarantine.method !== "move" || !["worktree", "runtime-artifact"].includes(record.kind)) {
        const retained = { ...record, disposition: "cleanup-failed" as const,
          blocker: `Unsupported quarantine provenance: ${record.kind}/${quarantine.method}; preserve its evidence for explicit recovery.`,
          updatedAt: options.now.toISOString() };
        save(retained);
        failed.push(retained);
        return;
      }
      const state = readResourceGcState(store);
      if (record.owner.taskId === undefined || !state.taskStatusById.has(record.owner.taskId)) {
        save({ ...record, blocker: "Current Task ownership cannot be proven; quarantine retained.", updatedAt: options.now.toISOString() });
        return;
      }
      const allRefs = [
        ...(scan.refsByPath.get(quarantine.originalPath) ?? []),
        ...(scan.refsByPath.get(quarantine.path) ?? []),
        ...currentDurableRefs(record, state)
      ];
      if (allRefs.length > 0) {
        const result = restoreQuarantinedRecord(record, allRefs, options.now);
        save(result);
        (result.disposition === "active" ? restored : failed).push(result);
        return;
      }
      try {
        if (existsSync(quarantine.path)) {
          if (isGitWorktreePath(quarantine.path)) {
            execFileSync(
              "git",
              ["-C", quarantine.path, "worktree", "remove", "--force", "--", quarantine.path],
              { timeout: 30_000 }
            );
          }
          rmSync(quarantine.path, { recursive: true, force: true });
        }
        const receiptPath = `${quarantine.path}.receipt.json`;
        if (existsSync(receiptPath)) rmSync(receiptPath, { force: true });
        const deleted: ResourceRecord = {
          ...record, disposition: "deleted", quarantine: undefined,
          cleanupReceipt: { removedAt: options.now.toISOString(), method: "quarantine-purge" },
          updatedAt: options.now.toISOString()
        };
        save(deleted);
        purged.push(deleted);
      } catch (error) {
        const failedRecord: ResourceRecord = {
          ...record, disposition: "cleanup-failed",
          blocker: `Purge failed: ${error instanceof Error ? error.message : "unknown error"}`,
          updatedAt: options.now.toISOString()
        };
        save(failedRecord);
        failed.push(failedRecord);
      }
    }));
  }

  return Object.freeze({
    planned: Object.freeze({
      home: resolvedHome,
      mode: "quarantine",
      generatedAt: options.now.toISOString(),
      records: Object.freeze([]),
      releasable: Object.freeze([]),
      retained: Object.freeze([]),
      quarantined: Object.freeze(quarantined),
      deleted: Object.freeze([]),
      scan
    }),
    applied: Object.freeze([]),
    failed: Object.freeze(failed),
    restored: Object.freeze(restored),
    purged: Object.freeze(purged)
  });
}

/**
 * Explicitly restore every quarantined resource to its original path. This is
 * the rollback entry point: it does not require live references and does not
 * depend on the GC mode.
 */
export async function restoreAllResourceGc(
  home: string,
  options: { now: Date }
): Promise<GcResult> {
  const resolvedHome = resolve(home);
  const registry = withResourceRegistry(resolvedHome, undefined, store => store.load());
  const quarantined = Object.values(registry.records)
    .filter((record) => record.quarantine !== undefined
      && (record.disposition === "quarantined" || record.disposition === "cleanup-failed"));

  let state = registry;
  const restored: ResourceRecord[] = [];
  const failed: ResourceRecord[] = [];

  for (const record of quarantined) {
    const restoredRecord = restoreQuarantinedRecord(record, [], options.now);
    state = upsertResourceRecord(state, restoredRecord);
    if (restoredRecord.disposition === "active") {
      restored.push(restoredRecord);
    } else {
      failed.push(restoredRecord);
    }
  }

  withResourceRegistry(resolvedHome, undefined, store => store.save(state, registry));
  return Object.freeze({
    planned: Object.freeze({
      home: resolvedHome,
      mode: "quarantine",
      generatedAt: options.now.toISOString(),
      records: Object.freeze([]),
      releasable: Object.freeze([]),
      retained: Object.freeze([]),
      quarantined: Object.freeze(quarantined),
      deleted: Object.freeze([]),
      scan: Object.freeze({
        refsByPath: new Map(),
        protectedPaths: Object.freeze([]),
        diagnostics: Object.freeze([])
      })
    }),
    applied: Object.freeze([]),
    failed: Object.freeze(failed),
    restored: Object.freeze(restored),
    purged: Object.freeze([])
  });
}
