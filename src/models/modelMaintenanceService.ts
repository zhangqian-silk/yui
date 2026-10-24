import { createJobDefinitionControl, listJobRuns } from "../controller/jobDefinitionControl.js";
import type { DurableJobCaller } from "../controller/jobControl.js";
import type { JsonValue } from "../core/protocol.js";
import type { BuiltinJobConfiguration } from "../job/jobDefinition.js";
import type { TaskStore } from "../storage/taskStore.js";
import { WebRequestRejected } from "../web/webMutation.js";
import { ConnectionConfigError, planConnectionConfig, type ConnectionConfigInput } from "./connectionConfig.js";
import { modelFields, modelObject } from "./modelManagementConfig.js";
import { modelDigest } from "./modelManagementFiles.js";
import { validateMaintenanceInput } from "./modelMaintenance.js";
import { createModelRegistry } from "./modelRegistry.js";

/** Existing Job definitions hold explicit per-instance maintenance delegations.
 * Native component configuration stays native. No new persistent record format. */
export function createModelMaintenanceService(store: TaskStore) {
  const registry = createModelRegistry(store);
  const control = createJobDefinitionControl(store, store.rootDirectory());
  function requireCaller(caller: DurableJobCaller) {
    if (caller.scope !== "user" && !(caller.scope === "global" && caller.role === "operator")) {
      throw new WebRequestRejected("Component maintenance requires local user or Operator authority.");
    }
  }
  function submit(id: string, configuration: BuiltinJobConfiguration, requestId: unknown, caller: DurableJobCaller, beforeNew?: () => void) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) throw new WebRequestRejected("Stable maintenance requestId required.");
    // Both ingresses must retain their authenticated caller; Task Roles cannot
    // gain global maintenance by invoking a model capability.
    requireCaller(caller);
    return store.transaction(tx => {
      const scope = { kind: "global" } as const;
      const existing = tx.getJobDefinition(scope, id);
      if (existing) {
        control({ op: "show", scope, caller, id } as unknown as JsonValue, new Date());
        if (existing.configuration.kind !== "builtin" || existing.configuration.action !== configuration.action) {
          throw new WebRequestRejected("Maintenance Job identity is occupied by another definition.");
        }
        const runs = listJobRuns(tx, existing);
        const replay = runs.find(r => r.trigger.key === requestId && r.trigger.source === "manual");
        if (replay && !("taskId" in replay)) {
          if (modelDigest(replay.actionInput) !== modelDigest(configuration.input)) throw new WebRequestRejected("requestId already names different maintenance parameters.");
          return { run: replay, created: false };
        }
        if (runs.some(r => ["queued", "running", "unknown-needs-attention"].includes(r.status))) {
          throw new WebRequestRejected("Maintenance is active or unknown; inspect its exact Job before another operation.");
        }
      }
      beforeNew?.();
      // Use the normal Job boundary for authentication, executable validation,
      // overlap/replay fencing and supervisor process custody.
      control({ op: existing ? "update" : "define", scope, caller, id,
        title: id, configuration, ...(existing ? { expectedRevision: existing.revision } : {}) } as unknown as JsonValue, new Date());
      return control({ op: "run", scope, caller, id,
        trigger: { source: "manual", key: requestId } } as unknown as JsonValue, new Date());
    });
  }
  function read(moduleId: string) {
    if (!registry.read().modules.some(m => m.id === moduleId)) throw new WebRequestRejected("Module not found.");
    const definition = store.getJobDefinition({ kind: "global" }, `model-maintenance-${moduleId}`);
    return { moduleRevision: modelDigest(registry.read().modules.find(m => m.id === moduleId)),
      definition, runs: definition ? listJobRuns(store, definition).slice(-20) : [],
      notice: "Cached Job evidence only; no upstream or service probe. Maintenance is separate from configuration ownership." };
  }
  function maintain(input: unknown, caller: DurableJobCaller) {
    requireCaller(caller);
    const body = modelObject(input);
    modelFields(body, ["revision", "requestId", "maintenance"]);
    if (body.revision !== registry.revision()) throw new WebRequestRejected("Registry changed; reread before maintenance.");
    let maintenance: ReturnType<typeof validateMaintenanceInput>;
    try { maintenance = validateMaintenanceInput(body.maintenance); }
    catch (error) { throw new WebRequestRejected(error instanceof Error ? error.message : "Invalid maintenance request."); }
    const module = registry.read().modules.find(m => m.id === maintenance.moduleId);
    if (!module || modelDigest(module) !== maintenance.moduleRevision) throw new WebRequestRejected("Module changed; inspect the exact instance.");
    if (maintenance.operation === "update" && module.configFile && !maintenance.spec.configFiles.includes(module.configFile)) {
      throw new WebRequestRejected("Backup inventory must include the registered native configuration.");
    }
    if (maintenance.operation === "update") {
      const definition = store.getJobDefinition({ kind: "global" }, `model-maintenance-${module.id}`);
      const checked = definition && listJobRuns(store, definition).some(run => {
        const data = run.businessResult?.data as Record<string, unknown> | undefined;
        return run.businessResult?.outcome === "succeeded" && data?.operation === "check-update"
          && data.source === maintenance.spec.repository && data.ref === maintenance.spec.ref && data.commit === maintenance.commit;
      });
      if (!checked) throw new WebRequestRejected("Run a remote update check for this exact repository/ref and select its confirmed commit first.");
    }
    return submit(`model-maintenance-${module.id}`, { kind: "builtin", action: "models.maintenance",
      input: maintenance as unknown as JsonValue }, body.requestId, caller);
  }
  function connectionPreview(input: unknown) {
    const body = modelObject(input);
    modelFields(body, ["input"]);
    let plan: ReturnType<typeof planConnectionConfig>;
    try { plan = planConnectionConfig(body.input as ConnectionConfigInput, {}); }
    catch (error) { throw new WebRequestRejected(error instanceof ConnectionConfigError ? error.code : "Invalid native connection request."); }
    return { plan, planDigest: modelDigest(plan),
      notice: "Native file preview only. Adding a Provider, selecting a default, service restart, catalog refresh and Session application are separate effects." };
  }
  function connectionApply(input: unknown, caller: DurableJobCaller) {
    requireCaller(caller);
    const body = modelObject(input);
    modelFields(body, ["input", "planDigest", "requestId", "exclusiveWriter"]);
    if (body.exclusiveWriter !== true) throw new WebRequestRejected("Exclusive native configuration ownership required.");
    if (!/^[a-f0-9]{64}$/.test(String(body.planDigest))) throw new WebRequestRejected("Exact preview digest required.");
    return submit("model-connection", { kind: "builtin", action: "models.connection",
      input: { input: body.input, planDigest: body.planDigest, exclusiveWriter: true } as JsonValue }, body.requestId, caller, () => {
      // Recover an authenticated identical request before checking files its
      // original Job may have changed. Only a new admission needs a fresh plan.
      // Client JSON is never a private ConnectionConfigPlan handle.
      const { planDigest } = connectionPreview({ input: body.input });
      if (planDigest !== body.planDigest) throw new WebRequestRejected("Native files or request changed; preview again.");
    });
  }
  return { read, maintain, connectionPreview, connectionApply };
}
