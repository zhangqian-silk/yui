import { resolve } from "node:path";

import { acquireHomeLifecycleLock } from "../core/controllerServer.js";
import { cleanControllerResource } from "./resourceCleanupLinux.js";
import type {
  ControllerResourceInventory,
  RuntimeResource
} from "./resourceInventory.js";
import { scanControllerResourceInventory } from "./resourceInventoryLinux.js";

const MAX_RECONCILIATION_PASSES = 4;

export type UpdateControllerReconciliationResult = Readonly<{
  home: string;
  cleaned: readonly string[];
  attempts: readonly Readonly<{
    resource: RuntimeResource;
    outcome: "cleaned" | "absent" | "unknown";
    error?: string;
  }>[];
  /** Last observed inventory, not a claim that unobserved resources stopped. */
  remaining: readonly RuntimeResource[];
  observedAt?: string;
  observationError?: string;
  lockReleaseError?: string;
}>;

export class UpdateControllerReconciliationError extends Error {
  constructor(message: string, readonly result: UpdateControllerReconciliationResult, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpdateControllerReconciliationError";
  }
}

/** The same bounded operation with disposable inventory/effect ports in tests. */
export type UpdateControllerReconciliationPorts = Readonly<{
  scan: typeof scanControllerResourceInventory;
  clean: typeof cleanControllerResource;
  acquireLock: typeof acquireHomeLifecycleLock;
}>;

/**
 * Reconcile only Controller-owned resources for the Home being updated.
 *
 * A current Controller is preserved for the update orchestrator's exact
 * capture/stop handoff. Superseded/orphaned Controller processes and stale
 * discovery/socket artifacts are cleaned using their existing process-start
 * and inode fingerprints. Agent, tmux, app, and foreign-Home resources are
 * deliberately outside this operation.
 */
export async function reconcileControllerResourcesForUpdate(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  tmuxBin?: string,
  ports: UpdateControllerReconciliationPorts = {
    scan: scanControllerResourceInventory,
    clean: cleanControllerResource,
    acquireLock: acquireHomeLifecycleLock
  }
): Promise<UpdateControllerReconciliationResult> {
  const resolvedHome = resolve(home);
  const cleaned = new Set<string>();
  const attempts: UpdateControllerReconciliationResult["attempts"][number][] = [];
  let remaining: RuntimeResource[] = [];
  let observedAt: string | undefined;
  let observationError: string | undefined;
  let lockReleaseError: string | undefined;
  const result = (): UpdateControllerReconciliationResult => ({
    home: resolvedHome, cleaned: [...cleaned], attempts: [...attempts], remaining: [...remaining],
    ...(observedAt === undefined ? {} : { observedAt }),
    ...(observationError === undefined ? {} : { observationError }),
    ...(lockReleaseError === undefined ? {} : { lockReleaseError })
  });
  const scan = async (): Promise<ControllerResourceInventory> => {
    try {
      const snapshot = await ports.scan({
        currentHome: resolvedHome, scope: "current", environment,
        ...(tmuxBin === undefined ? {} : { tmuxBin })
      });
      if (snapshot.scope === "current" && resolve(snapshot.currentHome) === resolvedHome) {
        remaining = controllerResources(snapshot, resolvedHome);
        observedAt = snapshot.observedAt;
      }
      assertCertainSnapshot(snapshot, resolvedHome);
      observationError = undefined;
      return snapshot;
    } catch (error) {
      observationError = messageOf(error);
      throw error;
    }
  };
  let releaseLock: (() => Promise<void>) | undefined;
  let failure: unknown;
  try {
    releaseLock = await ports.acquireLock(resolvedHome, { removeStaleOwner: true });
    for (let pass = 0; pass < MAX_RECONCILIATION_PASSES; pass += 1) {
      const snapshot = await scan();

      const resources = controllerResources(snapshot, resolvedHome);
      const controllers = resources.filter(({ kind }) => kind === "controller");
      const current = controllers.filter(({ state }) => state === "current");
      if (current.length > 1) {
        throw reconciliationBlocked(
          `multiple current Controllers were reported (${resourceLabels(current)})`
        );
      }

      const historical = controllers.filter(({ state }) => state !== "current");
      const historicalCleanup = historical.filter(isCleanupEligible);
      const unsafeHistorical = historical.filter((resource) => !isCleanupEligible(resource));
      if (unsafeHistorical.length > 0) {
        throw reconciliationBlocked(
          `historical Controller ownership is not safely cleanable (${resourceLabels(unsafeHistorical)})`
        );
      }

      const artifacts = resources.filter(isControllerArtifact);
      const staleArtifactCleanup = artifacts.filter((resource) => (
        resource.state === "stale" && isCleanupEligible(resource)
      ));
      const unresolvedArtifacts = artifacts.filter((resource) => (
        !staleArtifactCleanup.includes(resource)
      ));

      // A corrupt discovery is conservatively marked active while an orphan
      // Controller still exists. Remove the exactly fenced historical process
      // first; the next scan can then reclassify and remove the stale artifact.
      if (unresolvedArtifacts.length > 0 && historicalCleanup.length === 0) {
        throw reconciliationBlocked(
          `a Controller artifact is active or ownership is unknown (${resourceLabels(unresolvedArtifacts)})`
        );
      }

      const candidates = [...historicalCleanup, ...staleArtifactCleanup];
      if (candidates.length === 0) {
        break;
      }

      for (const candidate of candidates) {
        try {
          await ports.clean(candidate, { environment, ...(tmuxBin === undefined ? {} : { tmuxBin }) });
          cleaned.add(candidate.id);
          attempts.push({ resource: candidate, outcome: "cleaned" });
          remaining = remaining.filter(({ id }) => id !== candidate.id);
        } catch (error) {
          // A concurrent exact cleanup that already reached the desired state
          // is harmless. Anything still present or reclassified is a real
          // ownership change and must remain a user-visible blocker.
          const attempt = { resource: candidate, outcome: "unknown" as const, error: messageOf(error) };
          attempts.push(attempt);
          // If this observation also fails, keep BOTH failures and the exact
          // attempted identity. Failure to observe absence is never success.
          const afterFailure = await scan();
          if (!controllerResources(afterFailure, resolvedHome).some(({ id }) => id === candidate.id)) {
            cleaned.add(candidate.id);
            attempts[attempts.length - 1] = { ...attempt, outcome: "absent" };
            continue;
          }
          throw reconciliationBlocked(
            `resource ${candidate.id} changed or could not be cleaned: ${messageOf(error)}`
          );
        }
      }
      if (pass === MAX_RECONCILIATION_PASSES - 1) {
        throw reconciliationBlocked("Controller resources did not converge after bounded cleanup");
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    try { await releaseLock?.(); }
    catch (error) {
      lockReleaseError = messageOf(error);
      failure ??= error;
    }
  }
  if (failure !== undefined) throw new UpdateControllerReconciliationError(
    messageOf(failure), result(), { cause: failure }
  );
  return result();
}

function assertCertainSnapshot(
  snapshot: ControllerResourceInventory,
  resolvedHome: string
): void {
  if (
    snapshot.scope !== "current"
    || resolve(snapshot.currentHome) !== resolvedHome
  ) {
    throw reconciliationBlocked("the Controller inventory returned a mismatched Home or scope");
  }
  if (snapshot.warnings.length > 0) {
    throw reconciliationBlocked(`the Controller inventory is uncertain: ${snapshot.warnings.join("; ")}`);
  }
}

function controllerResources(
  snapshot: ControllerResourceInventory,
  resolvedHome: string
): RuntimeResource[] {
  return snapshot.resources.filter((resource) => (
    resource.yuiHome === resolvedHome
    && (resource.kind === "controller" || isControllerArtifact(resource))
  ));
}

function isControllerArtifact(resource: RuntimeResource): boolean {
  return resource.kind === "artifact"
    && (resource.artifact?.artifactKind === "controller-discovery"
      || resource.artifact?.artifactKind === "controller-socket");
}

function isCleanupEligible(resource: RuntimeResource): boolean {
  return resource.disposition === "safe" || resource.disposition === "review";
}

function resourceLabels(resources: readonly RuntimeResource[]): string {
  return resources.map((resource) => `${resource.id}:${resource.reasonCode}`).join(", ");
}

function reconciliationBlocked(reason: string): Error {
  return new Error(
    `Automatic Controller reconciliation is blocked because ${reason}. `
      + "Run `yui controller status --verbose` and resolve only the reported current-Home resource before retrying."
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
