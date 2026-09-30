import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import Database from "better-sqlite3";
import { inspectPty } from "./ptyProbe.js";

import {
  configuredAgentToDefinition,
  resolveAgentEnvironment,
  type ConfiguredAgent
} from "../agent/agent.js";
import { operationalAgentEnvironment } from "../agent/launchEnvironment.js";
import { resolveTmuxBin } from "../config/yuiConfig.js";
import { compileRoleSessionContext } from "../context/roleSessionContext.js";
import { callController, ControllerClientError } from "../core/controllerClient.js";
import {
  EPHEMERAL_DOMAIN_GRACE_MS,
  readEphemeralDomainIdentity,
  readLinuxProcessStartIdentity
} from "../controller/domainIdentity.js";
import { usageError } from "../errors/cliError.js";
import {
  inspectAgentCapabilities,
  resolveAgentAdapter,
  type AgentProbeResult,
  type CapabilitySnapshot
} from "../executor/agentAdapter.js";
import {
  assertCodexLaunchOverridesAvailable,
  inspectCodexLaunchConfig
} from "../executor/codexConfigConflict.js";
import { resolveEffectiveLaunch } from "../executor/effectiveLaunch.js";
import {
  nativeAdditionalDirectories,
  nativeAgentWorkspace,
  withNativeProjectDirectories
} from "../executor/fileRoleLaunchPlanner.js";
import { defaultTableWidth, renderTable } from "../output/table.js";
import {
  codexAppNeedsRestart,
  codexAppProcessIds,
  codexAppWebSocketUrl,
  codexSharedSocketPath,
  findMacCodexAppExecutable,
  isCodexInspectionPermissionError
} from "../runtime/codexSharedDaemon.js";
import { codexAgentsInUse } from "../runtime/localStartup.js";
import type { ReviewConfig } from "../review/reviewConfig.js";
import type { GlobalRole } from "../role/role.js";
import type { StorageVersion } from "../storage/storageVersions.js";
import {
  CURRENT_DATABASE_FILENAME,
  openCurrentTaskStore
} from "../storage/currentTaskStore.js";
import {
  inspectStorageSchema,
  type StorageSchemaState
} from "../storage/storageSchema.js";
import { resolveStoreWorkerEnabledForHome } from "../storage/storeRpc.js";
import { resolveYuiHome } from "../storage/taskStore.js";
import {
  CommandExecutionError,
  type CommandExecutor
} from "../tmux/commandExecutor.js";

export type DoctorStatus = "ok" | "missing" | "unsupported" | "invalid";

export type DoctorCheck = Readonly<{
  name: string;
  status: DoctorStatus;
  detail: string;
}>;

export type DoctorReviewStatus = "ready" | "disabled" | "misconfigured";

/** Static Review configuration health. Provider-native acceptance is never inferred here. */
export type DoctorReviewReport = Readonly<{
  status: DoctorReviewStatus;
  policy?: ReviewConfig;
  roleName?: string;
  activeAgentId?: string;
  adapterId?: string;
  command?: string;
  /** Always unverified: doctor never creates a Reviewer Session or calls a model. */
  providerNative: "unverified";
  detail: string;
}>;

/**
 * The storage-relevant doctor checks, in the order they are produced. Post-update
 * verification (P1-3) keys off exactly these: a green `yui doctor` for the update
 * flow means every one of these is `ok`. Tool/agent checks are diagnostic only
 * and never block an update.
 */
export const STORAGE_DOCTOR_CHECK_NAMES = Object.freeze([
  "storage schema",
  "storage compatibility",
  "storage state"
] as const);

/** A machine-readable summary of storage health, embedded in `--json doctor`. */
export type StorageHealthSummary = Readonly<{
  /** True iff every storage check is `ok`. */
  healthy: boolean;
  /** The storage checks that are not `ok` (empty when healthy). */
  blocking: readonly DoctorCheck[];
  /** Physical-backend facts for the Home (Issue 01 observability). */
  details?: StorageDetails;
}>;

/**
 * The physical-backend facts `doctor --json` reports so an operator can prove
 * which backend is authoritative without inferring it from filesystem
 * leftovers (Issue 01). Every field is read-only evidence; `null` means "not
 * applicable or unreadable", never a guess.
 */
export type StorageDetails = Readonly<{
  /** The authoritative SQLite migration head (null when unreadable). */
  storageVersion: StorageVersion | null;
  /** Oldest version for which this CLI carries a complete migration chain. */
  minimumSupportedVersion: StorageVersion;
  /** The backend ordinary startup opens for this Home. */
  authoritativeBackend: "sqlite";
  /** The absolute `yui.db` path when it exists, else null. */
  databasePath: string | null;
  /** The SQLite journal mode (null for the file store or an unreadable DB). */
  journalMode: string | null;
  /** Whether the persistence worker is enabled for this Home. */
  workerEnabled: boolean;
  /** The last committed SQLite revision. */
  lastCommittedRevision: number | null;
}>;

/** The full machine-readable doctor result surfaced by `yui --json doctor`. */
export type DoctorReport = Readonly<{
  checks: readonly DoctorCheck[];
  storage: StorageHealthSummary;
  review: DoctorReviewReport;
}>;

/**
 * Classify the storage checks into a machine-readable health verdict. This is the
 * canonical, parseable signal the update post-verify consumes (P1-3): storage is
 * healthy only when schema, compatibility, and state are all `ok`. Any
 * `unsupported` (version mismatch / needs-new-version), `invalid` (corrupted /
 * unreadable), or `missing` (uninitialized) storage check is blocking — even
 * and the machine-readable command exits non-zero.
 */
export function summarizeStorageHealth(
  checks: readonly DoctorCheck[]
): StorageHealthSummary {
  const names = new Set<string>(STORAGE_DOCTOR_CHECK_NAMES);
  const blocking = checks.filter(
    (check) => names.has(check.name) && check.status !== "ok"
  );
  return { healthy: blocking.length === 0, blocking };
}

/** Build the full machine-readable doctor report (checks + storage health). */
export async function buildDoctorReport(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): Promise<DoctorReport> {
  const inspection = await inspectDoctor(env, executor);
  const home = resolveYuiHome(env);
  return {
    checks: inspection.checks,
    storage: {
      ...summarizeStorageHealth(inspection.checks),
      details: inspectStorageDetails(home, env)
    },
    review: inspection.review
  };
}

/**
 * Read the physical-backend facts for a Home (Issue 01 observability). Every
 * field is best-effort read-only evidence: an unreadable database yields
 * `null` for that field, and the `storage state` check reports the structural
 * problem separately.
 */
function inspectStorageDetails(
  home: string,
  env: NodeJS.ProcessEnv
): StorageDetails {
  const schema = inspectStorageSchema(home);
  const storageVersion = schema.status === "current"
    || schema.status === "upgradeable"
    || schema.status === "unsupported"
    ? schema.currentVersion
    : null;
  const authoritativeBackend = "sqlite" as const;
  const dbPath = join(home, CURRENT_DATABASE_FILENAME);
  const databasePath = existsSync(dbPath) ? dbPath : null;
  let journalMode: string | null = null;
  let lastCommittedRevision: number | null = null;
  if (databasePath !== null) {
    try {
      const db = new Database(databasePath, { readonly: true });
      try {
        const mode = db.pragma("journal_mode", { simple: true });
        journalMode = typeof mode === "string" ? mode : String(mode);
        const row = db.prepare("SELECT revision FROM home_meta WHERE id = 1").get() as
          | { revision?: number }
          | undefined;
        lastCommittedRevision = typeof row?.revision === "number" ? row.revision : null;
      } finally {
        db.close();
      }
    } catch {
      // Leave both null; the storage state check surfaces the corruption.
    }
  }
  return {
    storageVersion,
    minimumSupportedVersion: schema.minimumSupportedVersion,
    authoritativeBackend,
    databasePath,
    journalMode,
    workerEnabled: resolveStoreWorkerEnabledForHome(home, env),
    lastCommittedRevision
  };
}

type StorageInspection = Readonly<{
  check: DoctorCheck;
  agents: readonly ConfiguredAgent[];
  activeCodexAgentIds: ReadonlySet<string>;
  review: ReviewSource;
}>;

type ReviewSource = Readonly<{
  storageReady: boolean;
  storageDetail: string;
  home?: string;
  policy?: ReviewConfig;
  role?: GlobalRole | null;
  agent?: ConfiguredAgent | null;
}>;

type SchemaInspection = StorageSchemaState | Readonly<{
  status: "read-error";
  detail: string;
}>;

type StorageCompatibilityStatus = "current" | "upgradeable" | "unsupported";

type CompatibilityInspection = Readonly<{
  check: DoctorCheck;
  storageStatus?: StorageCompatibilityStatus;
}>;

/** Runs the read-only current-storage diagnostics used by `yui doctor`. */
export async function runDoctorCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): Promise<string> {
  if (args.length !== 0) throw usageError("Doctor usage: yui doctor");
  const inspection = await inspectDoctor(env, executor);
  return renderDoctor(inspection.checks, inspection.review);
}

export async function getDoctorChecks(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): Promise<DoctorCheck[]> {
  return (await inspectDoctor(env, executor)).checks;
}

type DoctorInspection = Readonly<{
  checks: DoctorCheck[];
  review: DoctorReviewReport;
}>;

async function inspectDoctor(
  env: NodeJS.ProcessEnv,
  executor: CommandExecutor
): Promise<DoctorInspection> {
  const home = resolveYuiHome(env);
  const homeCheck = checkHome(home);
  const schema = readSchema(home);
  const compatibility = inspectCompatibility(home, homeCheck, schema);
  const schemaCheck = checkSchema(schema);
  const storage = inspectState(
    home,
    homeCheck,
    schema,
    compatibility
  );
  const controller = await checkController(home);
  const domain = checkEphemeralDomain(home);
  const durableConfig = readDurableConfigSafely(home);
  const toolChecks = [
    checkExecutable("git", durableConfig.gitBin, ["--version"], executor),
    checkExecutable("tmux", durableConfig.tmuxBin, ["-V"], executor)
  ];
  const agentChecks = storage.agents.flatMap((agent) => checkAgent(
    agent, executor, env, home, storage.activeCodexAgentIds.has(agent.id)
  ));
  const review = inspectReview({ ...storage.review, home }, agentChecks, env);
  return {
    checks: [
      homeCheck,
      schemaCheck,
      compatibility.check,
      storage.check,
      controller,
      ...(domain === undefined ? [] : [domain]),
      ...toolChecks,
      ...inspectPty(),
      ...agentChecks,
      ...review.checks
    ],
    review: review.report
  };
}

/** Query the authenticated Controller endpoint without starting it. */
export async function checkController(
  home: string,
  probe: typeof callController = callController
): Promise<DoctorCheck> {
  try {
    const result = await probe(home, "controller.status", {}, { timeoutMs: 1_000 });
    if (result !== null && typeof result === "object" && !Array.isArray(result)) {
      const status = result as Record<string, unknown>;
      if (status.running === true && Number.isSafeInteger(status.pid) && Number(status.pid) > 0) {
        return { name: "controller", status: "ok", detail: `Controller is running pid=${status.pid}.` };
      }
    }
    return {
      name: "controller", status: "invalid",
      detail: "Controller returned an invalid status; inspect yui controller status --verbose."
    };
  } catch (error) {
    if (error instanceof ControllerClientError && error.code === "CONTROLLER_NOT_RUNNING") {
      return { name: "controller", status: "missing", detail: `${error.message} Run yui start.` };
    }
    if (error instanceof ControllerClientError && error.code === "CONTROLLER_UNAVAILABLE") {
      return {
        name: "controller",
        status: "invalid",
        detail: `Controller is not reachable: ${error.message} Run yui start. Its process state is unverified.`
      };
    }
    return {
      name: "controller",
      status: "invalid",
      detail: `Controller status could not be verified: ${error instanceof Error ? error.message : String(error)}. Inspect yui controller status --verbose.`
    };
  }
}

function checkEphemeralDomain(home: string): DoctorCheck | undefined {
  const identity = readEphemeralDomainIdentity(home);
  if (identity.status === "absent") return undefined;
  if (identity.status === "invalid" || identity.identity === undefined) {
    return {
      name: "ephemeral domain",
      status: "invalid",
      detail: "runtime/domain.json is invalid; recreate the isolated test domain."
    };
  }
  const host = readLinuxProcessStartIdentity(identity.identity.hostPid);
  if (host === identity.identity.hostProcessStartIdentity) {
    return {
      name: "ephemeral domain",
      status: "ok",
      detail: `active host=${identity.identity.hostPid}:${host} token=${identity.identity.token.slice(0, 12)}`
    };
  }
  if (host === undefined && existsSync(`/proc/${identity.identity.hostPid}`)) {
    return {
      name: "ephemeral domain",
      status: "invalid",
      detail: "host process is present but its start identity is unreadable; keep the domain protected and retry."
    };
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(identity.identity.createdAt));
  return {
    name: "ephemeral domain",
    status: ageMs >= EPHEMERAL_DOMAIN_GRACE_MS ? "missing" : "invalid",
    detail: ageMs >= EPHEMERAL_DOMAIN_GRACE_MS
      ? "host is expired; run yui controller cleanup --all or wait for Controller recovery."
      : "host identity is unavailable; bounded grace is still in progress."
  };
}

export function renderDoctor(
  checks: readonly DoctorCheck[],
  review?: DoctorReviewReport
): string {
  const reviewLine = review === undefined
    ? ""
    : `Reviewer: ${review.status} (${review.detail})\n`;
  return `Yui doctor\n${reviewLine}${renderTable(
    "Checks",
    [
      { header: "Check", minWidth: 8, maxWidth: 28 },
      { header: "Status", minWidth: 7, maxWidth: 11 },
      { header: "Detail", minWidth: 12, maxWidth: 88 }
    ],
    checks.map((check) => [check.name, check.status, check.detail]),
    defaultTableWidth()
  )}\n`;
}

function checkHome(home: string): DoctorCheck {
  try {
    const metadata = lstatSync(home);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        name: "yui home",
        status: "invalid",
        detail: "YUI_HOME must be a real directory."
      };
    }
    accessSync(home, constants.R_OK);
    return { name: "yui home", status: "ok", detail: home };
  } catch (error) {
    if (systemCode(error) === "ENOENT") {
      return { name: "yui home", status: "missing", detail: "run yui setup" };
    }
    return { name: "yui home", status: "invalid", detail: errorMessage(error) };
  }
}

function readSchema(home: string): SchemaInspection {
  try {
    return inspectStorageSchema(home);
  } catch (error) {
    return { status: "read-error", detail: errorMessage(error) };
  }
}

function checkSchema(
  state: SchemaInspection
): DoctorCheck {
  switch (state.status) {
    case "uninitialized":
      return { name: "storage schema", status: "missing", detail: "run yui setup" };
    case "current":
      return {
        name: "storage schema",
        status: "ok",
        detail:
          `current=${state.currentVersion} latest=${state.latestVersion} `
          + `minimum=${state.minimumSupportedVersion}`
      };
    case "upgradeable":
      return {
        name: "storage schema",
        status: "unsupported",
        detail:
          `current=${state.currentVersion} latest=${state.latestVersion} `
          + `minimum=${state.minimumSupportedVersion} migration=available`
      };
    case "unsupported":
      return {
        name: "storage schema",
        status: "unsupported",
        detail:
          `current=${state.currentVersion} latest=${state.latestVersion} `
          + `minimum=${state.minimumSupportedVersion} direction=${state.direction}`
      };
    case "invalid":
      return { name: "storage schema", status: "invalid", detail: state.detail };
    case "read-error":
      return { name: "storage schema", status: "invalid", detail: state.detail };
  }
}

/** Diagnose admission to the exact current storage contract without repair. */
function inspectCompatibility(
  _home: string,
  homeCheck: DoctorCheck,
  schema: SchemaInspection
): CompatibilityInspection {
  const name = "storage compatibility";
  if (homeCheck.status !== "ok") {
    return { check: { name, status: homeCheck.status, detail: homeCheck.detail } };
  }
  if (schema.status === "uninitialized") {
    return { check: { name, status: "missing", detail: "run yui setup" } };
  }
  if (schema.status === "read-error") {
    return { check: { name, status: "invalid", detail: schema.detail } };
  }
  if (schema.status === "invalid") {
    return { check: { name, status: "invalid", detail: schema.detail } };
  }
  if (schema.status === "unsupported") {
    return {
      storageStatus: "unsupported",
      check: {
        name,
        status: "unsupported",
        detail:
          `storage version is ${schema.direction} `
          + `(current=${schema.currentVersion}, supported=`
          + `${schema.minimumSupportedVersion}..${schema.latestVersion}).`
      }
    };
  }
  if (schema.status === "upgradeable") {
    return {
      storageStatus: "upgradeable",
      check: {
        name,
        status: "unsupported",
        detail:
          `migration available from ${schema.currentVersion} to ${schema.latestVersion}; `
          + "run `yui upgrade` or `yui update`."
      }
    };
  }
  return {
    storageStatus: "current",
    check: {
      name,
      status: "ok",
      detail:
        `current=${schema.currentVersion}/${schema.latestVersion} `
        + `minimum=${schema.minimumSupportedVersion}`
    }
  };
}

function inspectState(
  home: string,
  homeCheck: DoctorCheck,
  schema: SchemaInspection,
  compatibility: CompatibilityInspection
): StorageInspection {
  if (homeCheck.status !== "ok") {
    return blockedStorage(homeCheck.status, homeCheck.detail);
  }
  if (schema.status === "uninitialized") {
    return blockedStorage("missing", "run yui setup");
  }
  if (schema.status === "invalid") return blockedStorage("invalid", schema.detail);
  if (schema.status === "read-error") return blockedStorage("invalid", schema.detail);
  if (compatibility.check.status !== "ok") {
    return blockedStorage(
      compatibility.check.status,
      storageBlockerDetail(compatibility.check)
    );
  }
  if (compatibility.storageStatus !== "current") {
    return blockedStorage("unsupported", compatibility.check.detail);
  }
  const databasePath = join(home, CURRENT_DATABASE_FILENAME);
  if (!existsSync(databasePath)) {
    return blockedStorage("invalid", "Current storage is incomplete: yui.db is missing.");
  }
  let ownedStore: ReturnType<typeof openCurrentTaskStore> | undefined;
  try {
    const store = ownedStore = openCurrentTaskStore(home);
    store.validateCurrentRecords();
    const config = store.getConfig();
    const agents = store.listConfiguredAgents();
    const tasks = store.listTasks();
    const globalRoles = store.listGlobalRoles();
    const roleCount = tasks.reduce(
      (count, task) => count + store.listRoles(task.id).length,
      0
    );
    return {
      check: {
        name: "storage state",
        status: "ok",
        detail: `yui.db readable agents=${agents.length} tasks=${tasks.length} roles=${roleCount} globalRoles=${globalRoles.length} defaultAgent=${config.defaultAgent ?? "none"}`
      },
      agents,
      activeCodexAgentIds: new Set(codexAgentsInUse(store).map((agent) => agent.id)),
      review: {
        storageReady: true,
        storageDetail: "yui.db is readable",
        ...(config.review === undefined ? {} : { policy: config.review }),
        ...(config.review === undefined
          ? {}
          : {
              role: store.getGlobalRole(config.review.roleName),
              agent: (() => {
                const role = store.getGlobalRole(config.review.roleName);
                return role === null
                  ? null
                  : store.getConfiguredAgent(role.activeAgentId);
              })()
            })
      }
    };
  } catch (error) {
    return blockedStorage("invalid", errorMessage(error));
  } finally {
    ownedStore?.close();
  }
}

function storageBlockerDetail(check: DoctorCheck): string {
  const corruptionPrefix = "unsupported (CORRUPTED): ";
  return check.status === "invalid" && check.detail.startsWith(corruptionPrefix)
    ? `Invalid storage: ${check.detail.slice(corruptionPrefix.length)}`
    : check.detail;
}

function blockedStorage(status: Exclude<DoctorStatus, "ok">, detail: string): StorageInspection {
  return {
    check: { name: "storage state", status, detail },
    agents: [],
    activeCodexAgentIds: new Set(),
    review: {
      storageReady: false,
      storageDetail: detail
    }
  };
}

type ReviewInspection = Readonly<{
  report: DoctorReviewReport;
  checks: readonly DoctorCheck[];
}>;

function inspectReview(
  source: ReviewSource,
  agentChecks: readonly DoctorCheck[],
  environment: NodeJS.ProcessEnv
): ReviewInspection {
  if (!source.storageReady) {
    return {
      report: {
        status: "misconfigured",
        providerNative: "unverified",
        detail: `Review configuration unavailable: ${source.storageDetail}`
      },
      checks: [{
        name: "review policy",
        status: "invalid",
        detail: `unavailable: ${source.storageDetail}`
      }]
    };
  }

  const policy = source.policy;
  if (policy === undefined) {
    return {
      report: {
        status: "disabled",
        providerNative: "unverified",
        detail: "Review policy is disabled; no Reviewer dispatch is scheduled."
      },
      checks: [{
        name: "review policy",
        status: "ok",
        detail: "disabled"
      }]
    };
  }

  const checks: DoctorCheck[] = [{
    name: "review policy",
    status: "ok",
    detail: `role=${policy.roleName} trigger=${policy.trigger}`
  }];
  const role = source.role ?? null;
  if (role === null) {
    checks.push({
      name: "reviewer role",
      status: "missing",
      detail: `Global Role not found: ${policy.roleName}.`
    });
    return reviewMisconfigured(policy, checks, `Reviewer Role is missing: ${policy.roleName}.`);
  }
  checks.push({
    name: "reviewer role",
    status: "ok",
    detail: `name=${role.name} activeAgent=${role.activeAgentId}`
  });

  const binding = role.agentBindings[role.activeAgentId];
  if (binding === undefined) {
    checks.push({
      name: "reviewer binding",
      status: "missing",
      detail: `active Agent binding is missing: ${role.activeAgentId}.`
    });
    return reviewMisconfigured(policy, checks, "Reviewer active Agent binding is missing.", role);
  }
  checks.push({
    name: "reviewer binding",
    status: "ok",
    detail: `agent=${binding.agentId} component=${binding.component} adapter=${binding.adapterId}`
  });

  const agent = source.agent ?? null;
  if (agent === null) {
    checks.push({
      name: "reviewer agent",
      status: "missing",
      detail: `Configured Agent not found: ${binding.agentId}.`
    });
    return reviewMisconfigured(policy, checks, `Reviewer Agent is missing: ${binding.agentId}.`, role, binding.agentId, binding.adapterId);
  }
  checks.push({
    name: "reviewer agent",
    status: "ok",
    detail: `id=${agent.id} component=${agent.component} adapter=${agent.adapterId} command=${agent.command}`
  });

  // Two products can share one connection plan, so a matching adapter is not
  // enough: a binding naming the SDK against an Agent recorded as the CLI is a
  // real mismatch, and launching either one would contradict the other record.
  if (agent.component !== binding.component) {
    checks.push({
      name: "reviewer component",
      status: "invalid",
      detail: `binding component=${binding.component} does not match Agent component=${agent.component}.`
    });
    return reviewMisconfigured(
      policy,
      checks,
      "Reviewer execution component does not match its Agent binding.",
      role,
      agent.id,
      agent.adapterId,
      agent.command
    );
  }

  if (agent.adapterId !== binding.adapterId) {
    checks.push({
      name: "reviewer adapter",
      status: "invalid",
      detail: `binding adapter=${binding.adapterId} does not match Agent adapter=${agent.adapterId}.`
    });
    return reviewMisconfigured(policy, checks, "Reviewer adapter identity does not match its Agent binding.", role, agent.id, agent.adapterId, agent.command);
  }
  let adapter;
  try {
    adapter = resolveAgentAdapter(agent.adapterId);
    checks.push({
      name: "reviewer adapter",
      status: "ok",
      detail: `adapter=${adapter.id} nativeSession=${adapter.capabilities.nativeSessionDiscovery}`
    });
  } catch (error) {
    checks.push({
      name: "reviewer adapter",
      status: "unsupported",
      detail: errorMessage(error)
    });
    return reviewMisconfigured(policy, checks, `Reviewer adapter is unavailable: ${errorMessage(error)}`,
      role, agent.id, agent.adapterId, agent.command);
  }

  const commandCheck = agentChecks.find((check) => check.name === `agent:${agent.id}:command`);
  const capabilityCheck = agentChecks.find((check) => check.name === `agent:${agent.id}:capability`);
  checks.push({
    name: "reviewer command",
    status: commandCheck?.status ?? "invalid",
    detail: commandCheck === undefined
      ? `No command inspection was recorded for ${agent.id}.`
      : commandCheck.detail
  });
  checks.push({
    name: "reviewer capability",
    status: capabilityCheck?.status ?? "invalid",
    detail: capabilityCheck === undefined
      ? `No capability inspection was recorded for ${agent.id}.`
      : capabilityCheck.detail
  });

  const launch = checkReviewerLaunch(
    agent,
    role,
    binding,
    adapter,
    environment,
    source.home
  );
  checks.push(launch);
  const dispatch = checkReviewerDispatch(policy, role, binding, agent, launch, commandCheck, capabilityCheck);
  checks.push(dispatch);
  const failedCheck = checks.find((check) => check.status !== "ok");
  if (failedCheck !== undefined) {
    return reviewMisconfigured(
      policy,
      checks,
      `${failedCheck.name}: ${failedCheck.detail}`,
      role,
      agent.id,
      agent.adapterId,
      agent.command
    );
  }
  return {
    report: {
      status: "ready",
      policy,
      roleName: role.name,
      activeAgentId: agent.id,
      adapterId: agent.adapterId,
      command: agent.command,
      providerNative: "unverified",
      detail: "Static Reviewer configuration and exact dispatch prerequisites are ready; provider-native acceptance is unverified."
    },
    checks
  };
}

function reviewMisconfigured(
  policy: ReviewConfig,
  checks: readonly DoctorCheck[],
  detail: string,
  role?: GlobalRole,
  activeAgentId?: string,
  adapterId?: string,
  command?: string
): ReviewInspection {
  return {
    report: {
      status: "misconfigured",
      policy,
      roleName: role?.name ?? policy.roleName,
      ...(activeAgentId === undefined ? {} : { activeAgentId }),
      ...(adapterId === undefined ? {} : { adapterId }),
      ...(command === undefined ? {} : { command }),
      providerNative: "unverified",
      detail
    },
    checks
  };
}

function checkReviewerLaunch(
  agent: ConfiguredAgent,
  role: GlobalRole,
  binding: GlobalRole["agentBindings"][string],
  adapter: ReturnType<typeof resolveAgentAdapter>,
  environment: NodeJS.ProcessEnv,
  home: string | undefined
): DoctorCheck {
  try {
    const workspace = role.workspace;
    if (!isAbsolute(workspace)) {
      return {
        name: "reviewer launch",
        status: "invalid",
        detail: "Reviewer Role workspace must be absolute."
      };
    }
    const metadata = lstatSync(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      return {
        name: "reviewer launch",
        status: "invalid",
        detail: "Reviewer Role workspace must be an existing real directory."
      };
    }
    const definition = configuredAgentToDefinition(agent);
    const launchEnvironment = resolveDoctorAgentEnvironment(definition, environment);
    const effective = resolveEffectiveLaunch({ role, purpose: "execution" });
    const agentWorkspace = nativeAgentWorkspace(effective.workspace);
    const launchConfig = withNativeProjectDirectories(
      binding.config,
      nativeAdditionalDirectories(effective.workspace, agentWorkspace)
    );
    const codexConfig = adapter.id === "codex"
      ? inspectCodexLaunchConfig({
          environment: launchEnvironment,
          workspace: agentWorkspace,
          profile: binding.config.adapterId === "codex" ? binding.config.profile : undefined,
          trustWorkspace: true
        })
      : undefined;
    if (codexConfig !== undefined) {
      assertCodexLaunchOverridesAvailable(
        codexConfig,
        ["developerInstructions", "notify"]
      );
    }
    const reviewerContext = adapter.id === "codex"
      ? compileRoleSessionContext(home, role, { scope: "global" }, { purpose: "review" })
      : undefined;
    const compiled = adapter.compileNew({
      agent: definition,
      config: launchConfig,
      workspace: agentWorkspace,
      sessionTitle: "reviewer",
      ...(reviewerContext === undefined
        ? {}
        : {
            developerInstructions: reviewerContext.developerInstructions,
            skills: reviewerContext.skills
          })
    });
    if (compiled.argv.length === 0) throw new Error("compiled launch argv is empty");
    return {
      name: "reviewer launch",
      status: "ok",
      detail: [
        `adapter=${adapter.id}`,
        `strategy=${compiled.sessionStrategy}`,
        `command=${agent.command}`,
        `addDirs=${launchConfig.additionalDirectories?.length ?? 0}`,
        ...(codexConfig?.developerInstructions.status === "configured"
          ? [`override=developer_instructions@${codexConfig.developerInstructions.source}`]
          : []),
        ...(codexConfig?.notify.status === "configured"
          ? [`override=notify@${codexConfig.notify.source}`]
          : [])
      ].join(" ")
    };
  } catch (error) {
    return {
      name: "reviewer launch",
      status: "invalid",
      detail: errorMessage(error)
    };
  }
}

function checkReviewerDispatch(
  _policy: ReviewConfig,
  role: GlobalRole,
  binding: GlobalRole["agentBindings"][string],
  agent: ConfiguredAgent,
  launch: DoctorCheck,
  command: DoctorCheck | undefined,
  capability: DoctorCheck | undefined
): DoctorCheck {
  if (role.defaultAccess !== "write") {
    return {
      name: "reviewer dispatch",
      status: "invalid",
      detail: "Reviewer Role must retain write access for an isolated ReviewRound workspace."
    };
  }
  if (binding.agentId !== agent.id) {
    return {
      name: "reviewer dispatch",
      status: "invalid",
      detail: `active binding Agent id does not match configured Agent: ${binding.agentId}/${agent.id}.`
    };
  }
  if (launch.status !== "ok" || command?.status !== "ok" || capability?.status !== "ok") {
    return {
      name: "reviewer dispatch",
      status: "invalid",
      detail: "Reviewer exact dispatch is blocked until command, capability, and launch checks are ok."
    };
  }
  return {
    name: "reviewer dispatch",
    status: "ok",
    detail: "static exact dispatch prerequisites confirmed; no Session or model was launched."
  };
}

function checkExecutable(
  name: "git" | "tmux",
  command: string,
  args: string[],
  executor: CommandExecutor
): DoctorCheck {
  try {
    const output = firstLine(executor.run(command, args));
    return {
      name,
      status: "ok",
      detail: output.length === 0 ? command : `${command}: ${output}`
    };
  } catch (error) {
    return {
      name,
      status: isMissingCommand(error) ? "missing" : "invalid",
      detail: `${command}: ${commandFailure(error)}`
    };
  }
}

function checkAgent(
  agent: ConfiguredAgent,
  executor: CommandExecutor,
  environment: NodeJS.ProcessEnv,
  home: string,
  activeCodex: boolean
): DoctorCheck[] {
  let snapshot: CapabilitySnapshot;
  let baseArgs: readonly string[];
  let launchEnvironment: Record<string, string>;
  try {
    const definition = configuredAgentToDefinition(agent);
    baseArgs = definition.baseArgs;
    launchEnvironment = resolveDoctorAgentEnvironment(definition, environment);
    snapshot = inspectAgentCapabilities(definition, {
      run: (command, args) => runAgentProbe(executor, command, args, launchEnvironment)
    });
  } catch (error) {
    return [{
      name: `agent:${agent.id}`,
      status: "invalid",
      detail: `${agent.command}: ${errorMessage(error)}`
    }];
  }

  const installation = snapshot.installation;
  const status: DoctorStatus = installation.status === "installed"
    ? "ok"
    : installation.status === "missing"
      ? "missing"
      : installation.status === "unsupported-version" ? "unsupported" : "invalid";
  const commandDetail = [
    `command=${installation.command}`,
    `adapter=${snapshot.adapterId}`,
    ...(installation.version === undefined ? [] : [`version=${installation.version}`]),
    ...(installation.reason === undefined ? [] : [`reason=${installation.reason}`])
  ].join(" ");
  const available = snapshot.fields.filter((field) => field.status === "available").length;
  const degraded = snapshot.fields.filter((field) => field.status === "degraded").length;
  const unavailable = snapshot.fields.filter((field) => field.status === "unavailable").length;
  const daemon = activeCodex && status === "ok"
    ? checkCodexSharedDaemon(agent.command, baseArgs, launchEnvironment, executor, agent.id)
    : undefined;
  return [
    { name: `agent:${agent.id}:command`, status, detail: commandDetail },
    {
      name: `agent:${agent.id}:capability`,
      status,
      detail: [
        `start resume interrupt nativeSession=${snapshot.lifecycle.nativeSessionDiscovery}`,
        `preInputReady=${snapshot.lifecycle.preInputReadiness.status}`,
        `fields(help-observed/static-or-unverified/unavailable)=${available}/${degraded}/${unavailable}`,
        "installation/help inspection only; no model or account capability query",
        ...snapshot.warnings.map((warning) => `warning=${warning}`)
      ].join(" ")
    },
    ...(daemon === undefined ? [] : [daemon]),
    ...(daemon !== undefined && process.platform === "darwin"
      ? checkMacCodexApp(agent.id, launchEnvironment, home, daemon, executor)
      : [])
  ];
}

export function checkMacCodexApp(
  agentId: string,
  environment: NodeJS.ProcessEnv,
  home: string,
  daemon: DoctorCheck,
  executor: CommandExecutor,
  appExecutable = findMacCodexAppExecutable(environment)
): DoctorCheck[] {
  if (appExecutable === undefined) return [{
    name: `agent:${agentId}:mac-app`, status: "ok",
    detail: "Codex App was not detected; App sharing is not configured on this Mac."
  }];
  const expectedUrl = codexAppWebSocketUrl(environment, home);
  let appPids: string[];
  try {
    appPids = codexAppProcessIds(executor.run("/bin/ps", ["-axo", "pid=,args="], {
      timeoutMs: 5_000
    }), appExecutable);
  } catch (error) {
    return [{
      name: `agent:${agentId}:mac-app`, status: "invalid",
      detail: `Cannot inspect Codex App processes: ${commandFailure(error)}`
    }];
  }
  const processCheck: DoctorCheck = {
    name: `agent:${agentId}:mac-app`,
    status: appPids.length > 0 ? "ok" : "missing",
    detail: appPids.length > 0
      ? `Codex App is running pid=${appPids.join(",")}.`
      : "Codex App is installed but not running."
  };
  let launchCheck: DoctorCheck;
  try {
    const launchUrl = executor.run("/bin/launchctl", ["getenv", "CODEX_APP_SERVER_WS_URL"], {
      timeoutMs: 5_000
    }).trim();
    launchCheck = launchUrl === expectedUrl
      ? {
          name: `agent:${agentId}:mac-app-launch`, status: "ok",
          detail: "Future Codex App launches are configured for this shared app-server."
        }
      : {
          name: `agent:${agentId}:mac-app-launch`, status: "missing",
          detail: "This login is not prepared for App sharing. Run yui start before opening or restarting App."
        };
  } catch (error) {
    launchCheck = {
      name: `agent:${agentId}:mac-app-launch`, status: "invalid",
      detail: `Cannot inspect the App launch environment: ${commandFailure(error)}`
    };
  }
  const connectionName = `agent:${agentId}:mac-app-connection`;
  if (appPids.length === 0) {
    return [processCheck, launchCheck, {
      name: connectionName, status: "missing", detail: "No detected App process; connection is not verified."
    }];
  }
  if (daemon.status !== "ok") {
    return [processCheck, launchCheck, {
      name: connectionName, status: daemon.status,
      detail: "Shared daemon is unavailable or unverified; App connection to it cannot be confirmed."
    }];
  }
  let configuredCount = 0;
  for (const pid of appPids) {
    try {
      const command = executor.run("/bin/ps", ["eww", "-p", pid, "-o", "command="], {
        timeoutMs: 5_000
      });
      if (!codexAppNeedsRestart(command, expectedUrl, false)) configuredCount += 1;
    } catch (error) {
      return [processCheck, launchCheck, {
        name: connectionName, status: "invalid",
        detail: `Cannot inspect running Codex App: ${commandFailure(error)}`
      }];
    }
  }
  try {
    const socketTarget = realpathSync(codexSharedSocketPath(environment, home));
    const sockets = parseMacUnixSockets(executor.run("/usr/sbin/lsof", ["-nP", "-U", "-F", "pfdn"], {
      timeoutMs: 5_000
    }));
    const daemonSockets = sockets.filter((socket) => socket.name === socketTarget);
    if (daemonSockets.length === 0) {
      return [processCheck, launchCheck, {
        name: connectionName, status: "invalid",
        detail: "Daemon reports running, but its Unix socket endpoint was not observable."
      }];
    }
    const peer = sockets.find((socket) => appPids.includes(socket.pid)
      && daemonSockets.some((daemonSocket) => socket.name === `->${daemonSocket.device}`));
    return [processCheck, launchCheck, peer === undefined
      ? {
          name: connectionName, status: "missing",
          detail: configuredCount > 0
            ? "App has the shared URL, but no live socket peer to this daemon was observed."
            : "No live App socket peer to this daemon was observed; reopen App after Yui prepares sharing."
        }
      : {
          name: connectionName, status: "ok",
          detail: `App pid=${peer.pid} has a live Unix socket peer on shared daemon pid=${daemonSockets[0].pid}.`
        }];
  } catch (error) {
    return [processCheck, launchCheck, {
      name: connectionName, status: "invalid",
      detail: `Cannot verify the live App-to-daemon socket: ${commandFailure(error)}`
    }];
  }
}

type MacUnixSocket = Readonly<{ pid: string; device: string; name: string }>;

function parseMacUnixSockets(output: string): MacUnixSocket[] {
  const sockets: MacUnixSocket[] = [];
  let pid = "";
  let device = "";
  let name = "";
  const finish = () => {
    if (pid !== "" && /^0x[0-9a-f]+$/iu.test(device) && name !== "") {
      sockets.push({ pid, device, name });
    }
    device = "";
    name = "";
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) { finish(); pid = line.slice(1); }
    else if (line.startsWith("f")) finish();
    else if (line.startsWith("d")) device = line.slice(1);
    else if (line.startsWith("n")) name = line.slice(1);
  }
  finish();
  return sockets;
}

export function checkCodexSharedDaemon(
  command: string,
  baseArgs: readonly string[],
  environment: Readonly<Record<string, string>>,
  executor: CommandExecutor,
  agentId: string
): DoctorCheck {
  const name = `agent:${agentId}:daemon`;
  const probe = runAgentProbe(executor, command,
    [...baseArgs, "app-server", "daemon", "version"], environment);
  if (probe.status !== 0) {
    const detail = probe.stderr.trim() || probe.error?.message || "The Codex daemon could not be inspected.";
    if (isCodexInspectionPermissionError(detail)) return {
      name,
      status: "invalid",
      detail: `Shared Codex app-server state is unverified: this process was denied access during the daemon probe (${detail}). Run Doctor from a local terminal with access to the Codex socket.`
    };
    return {
      name,
      status: /No such file or directory|Connection refused/iu.test(detail) ? "missing" : "invalid",
      detail: `Shared Codex app-server probe failed: ${detail}`
    };
  }
  try {
    const version: unknown = JSON.parse(probe.stdout);
    if (version === null || typeof version !== "object" || Array.isArray(version)) throw new Error();
    const state = version as Record<string, unknown>;
    if (state.status !== "running") throw new Error();
    return {
      name, status: "ok",
      detail: `Shared Codex app-server running version=${String(state.appServerVersion ?? "unknown")}`
    };
  } catch {
    return { name, status: "invalid", detail: "Codex daemon version did not confirm a running app-server." };
  }
}

function runAgentProbe(
  executor: CommandExecutor,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>
): AgentProbeResult {
  try {
    return {
      status: 0,
      stdout: executor.run(command, [...args], { environment }),
      stderr: ""
    };
  } catch (error) {
    const missing = isMissingCommand(error);
    const probeError = Object.assign(new Error(errorMessage(error)), {
      ...(missing ? { code: "ENOENT" } : {})
    });
    return {
      status: error instanceof CommandExecutionError ? error.exitStatus ?? null : null,
      stdout: "",
      stderr: error instanceof CommandExecutionError ? error.stderr : "",
      error: probeError
    };
  }
}

/**
 * Resolve the complete environment used by FileRoleLaunchPlanner for an Agent.
 * Doctor probes must inspect the same command resolution context as a native
 * launch; inheriting the Doctor process PATH would allow a shell-installed
 * command to mask a missing configured binding.
 */
function resolveDoctorAgentEnvironment(
  agent: Pick<ConfiguredAgent, "adapterId" | "environment">,
  environment: NodeJS.ProcessEnv
): Record<string, string> {
  return {
    ...operationalAgentEnvironment(agent.adapterId, environment),
    ...resolveAgentEnvironment(agent, environment)
  };
}

function isMissingCommand(error: unknown): boolean {
  return error instanceof CommandExecutionError
    ? error.code === "COMMAND_NOT_FOUND"
    : systemCode(error) === "ENOENT";
}

function commandFailure(error: unknown): string {
  if (error instanceof CommandExecutionError) {
    return error.stderr.trim() || error.message;
  }
  return errorMessage(error);
}

function firstLine(output: string): string {
  return output.trim().split(/\r?\n/, 1)[0] ?? "";
}

function systemCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the durable config for executable paths. Falls back to defaults when
 * the Home store cannot be opened (the doctor must still run on broken Homes).
 */
function readDurableConfigSafely(home: string): { tmuxBin: string; gitBin: string } {
  let ownedStore: ReturnType<typeof openCurrentTaskStore> | undefined;
  try {
    const store = ownedStore = openCurrentTaskStore(home);
    const config = store.getConfig();
    return {
      tmuxBin: resolveTmuxBin(config.tmuxBin),
      gitBin: "git"
    };
  } catch {
    return { tmuxBin: "tmux", gitBin: "git" };
  } finally {
    ownedStore?.close();
  }
}
