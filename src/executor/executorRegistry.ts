import { createHash } from "node:crypto";
import type {
  PreparedRoleDelivery,
  ReadyRoleDelivery,
  RoleDeliveryReport,
  RoleSessionLaunchMode,
  SchedulerRoleResourceInput,
  SchedulerRoleResourceEntry,
  SchedulerRoleSession,
  TmuxDeliveryPort
} from "../scheduler/ports.js";
import type {
  TmuxDeliveryOutcome,
  TmuxLaunchPlan,
  TmuxPaneState,
  TmuxReadinessProbe,
  TmuxRole,
  TmuxRolePaneState
} from "../tmux/tmuxManager.js";
import {
  createPromptEnvelope,
  createSessionLaunchRequest,
  type ActivePromptPushPort,
  type PromptPushOutcome,
  type RuntimeBinding,
  type RuntimeLaunchPreStart,
  type RuntimeLaunchPreparationPort,
  type SessionHostPort
} from "../runtime/index.js";
import { builtinAgentDriverRegistry } from "../runtime/builtinAgentDrivers.js";
import type { EffectiveLaunchSnapshot } from "./effectiveLaunch.js";
import type { ManagedWorkspace } from "../worktree/managedWorkspace.js";
import type {
  TaskRuntimeIsolationDescriptor,
  TaskRuntimeLaunchPolicy
} from "../runtime/taskRuntimeIsolation.js";
import { formatRunReceiptId } from "../task/taskRecordReference.js";

export type PlannedRoleSession = Readonly<{
  role: TmuxRole;
  launch: TmuxLaunchPlan;
  session: SchedulerRoleSession | null;
  sessionTitle?: string;
}>;

export interface RoleLaunchPlanner {
  plan(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective?: EffectiveLaunchSnapshot;
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
    runtimeIsolation?: TaskRuntimeIsolationDescriptor;
  }>): PlannedRoleSession;
}

export type ExecutorTmuxPort = Readonly<{
  ensureRoleWindow(taskId: string, role: TmuxRole, launch?: TmuxLaunchPlan): boolean;
  waitUntilReady(
    taskId: string,
    roleName: string,
    readinessProbe: TmuxReadinessProbe
  ): TmuxPaneState;
  sendRoleInputOnce(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: TmuxReadinessProbe
  ): TmuxDeliveryOutcome;
  sendRoleInputOnceIfReady(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: TmuxReadinessProbe
  ): TmuxDeliveryOutcome | "not-ready" | "unavailable";
  sendRoleInputOnceIfReadyAsync?(
    taskId: string,
    roleName: string,
    receiptId: string,
    input: string,
    readinessProbe: TmuxReadinessProbe
  ): Promise<TmuxDeliveryOutcome | "not-ready" | "unavailable">;
  probeRoleStatus(taskId: string, roleName: string): "running" | "exited";
  probeRoleStatusAsync?(
    taskId: string,
    roleName: string
  ): Promise<"running" | "exited">;
  killRole(taskId: string, roleName: string): void;
  killRoleAsync?(taskId: string, roleName: string): Promise<void>;
  inspectRolePaneInventory?(): TmuxRolePaneState[];
  inspectRolePaneInventoryAsync?(): Promise<TmuxRolePaneState[]>;
  inspectPane?(taskId: string, roleName: string): TmuxPaneState;
  inspectPaneAsync?(taskId: string, roleName: string): Promise<TmuxPaneState>;
}>;

export type AgentReadinessResolver = (
  adapterId: string,
  surface?: "role" | "operator"
) => TmuxReadinessProbe;

export type ExecutorRuntimePorts = Readonly<{
  sessionHost: SessionHostPort;
  promptPush: ActivePromptPushPort;
  launchCoordinator?: RuntimeLaunchPreparationPort;
  notifyOperatorInputOnce?: NonNullable<TmuxDeliveryPort["notifyOperatorInputOnce"]>;
  /** One advisory resource sample produced alongside the full Role inventory. */
  roleResourceInventory?: (
    panes: readonly TmuxRolePaneState[],
    inputs: readonly SchedulerRoleResourceInput[]
  ) => Promise<readonly SchedulerRoleResourceEntry[]>;
}>;

type PreparedRuntime = Readonly<{
  delivery: PreparedRoleDelivery;
  session: SchedulerRoleSession | null;
  workspace: string;
  planned?: PlannedRoleSession;
  binding?: RuntimeBinding;
}>;

/**
 * rr13/test: Test-only liveness seam. Integration tests that spawn a real
 * Controller subprocess cannot inject a fake TmuxDeliveryPort, and a saved
 * active Leader AgentRun would be reaped by the startup liveness pass without a
 * real tmux role. When this env var is "1", every role reads "present"
 * without probing tmux. The Controller subprocess inherits it from the
 * test's CLI env. Never set in production.
 */
const TEST_ROLE_LIVENESS_PRESENT = process.env.YUI_TEST_ROLE_LIVENESS_PRESENT === "1";

/**
 * Scheduler-to-tmux adapter. It retains only in-process prepared launch data;
 * durable session identity remains owned by TaskStore.
 */
export class ExecutorRegistry implements TmuxDeliveryPort {
  readonly #prepared = new Map<string, PreparedRuntime>();

  constructor(
    private readonly planner: RoleLaunchPlanner,
    private readonly tmux: ExecutorTmuxPort,
    private readonly readiness: AgentReadinessResolver = agentProcessReadinessProbe,
    private readonly runtimePorts?: ExecutorRuntimePorts
  ) {}

  async prepareRoleSession(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    workspace: string;
    managedWorkspace?: ManagedWorkspace;
    workspaceFree?: true;
    runtimePolicy?: TaskRuntimeLaunchPolicy;
    mode: RoleSessionLaunchMode;
    runId?: string;
    nativeSessionId?: string;
    beforeHostStart?: RuntimeLaunchPreStart;
  }>): Promise<PreparedRoleDelivery> {
    if (input.mode === "resume" && !hasText(input.nativeSessionId)) {
      throw new Error("Role session resume requires a native session id.");
    }
    let sessionStarted = false;
    const deliveryBase = {
      deliveryId: preparedDeliveryId(input),
      taskId: input.taskId,
      roleName: input.roleName,
      agentId: input.agentId,
      adapterId: input.adapterId,
      mode: input.mode,
      ...(input.runId === undefined ? {} : { runId: input.runId })
    };
    const cached = this.#prepared.get(deliveryBase.deliveryId);
    if (cached !== undefined) return cached.delivery;
    let binding: RuntimeBinding | undefined;
    let planned: PlannedRoleSession | undefined;
    let session: SchedulerRoleSession | null;
    if (this.runtimePorts === undefined) {
      planned = this.planner.plan(input);
      sessionStarted = this.tmux.ensureRoleWindow(
        input.taskId,
        planned.role,
        planned.launch
      );
      session = planned.session;
    } else {
      const common = {
        owner: { scope: "task", taskId: input.taskId, roleName: input.roleName },
        agentId: input.agentId,
        adapterId: input.adapterId,
        effective: input.effective,
        workspace: input.workspace,
        ...(input.managedWorkspace === undefined
          ? {}
          : { managedWorkspace: input.managedWorkspace }),
        ...(input.workspaceFree === true ? { workspaceFree: true as const } : {}),
        ...(input.runtimePolicy === undefined
          ? {}
          : { runtimePolicy: input.runtimePolicy }),
        ...(input.runId === undefined ? {} : { runId: input.runId })
      } as const;
      if (this.runtimePorts.launchCoordinator !== undefined) {
        binding = await this.runtimePorts.launchCoordinator.prepare(
          input.mode === "new"
            ? { ...common, mode: "new" }
            : {
                ...common,
                mode: "resume",
                nativeSessionId: input.nativeSessionId!,
              },
          undefined,
          input.beforeHostStart
        );
      } else {
        const request = input.mode === "new"
          ? createSessionLaunchRequest({
              ...common,
              mode: "new"
            })
          : createSessionLaunchRequest({
              ...common,
              mode: "resume",
              nativeSessionId: input.nativeSessionId!
            });
        binding = request.mode === "new"
          ? await this.runtimePorts.sessionHost.start(request, input.beforeHostStart)
          : await this.runtimePorts.sessionHost.restore(request, input.beforeHostStart);
      }
      sessionStarted = binding.hostCreated === true;
      session = binding.nativeSessionId === undefined
        ? null
        : {
            agentId: binding.agentId,
            adapterId: binding.adapterId,
            nativeSessionId: binding.nativeSessionId,
            status: "active",
            effective: input.effective
          };
    }
    const delivery: PreparedRoleDelivery = {
      ...deliveryBase,
      sessionStarted,
      session,
    };
    this.#prepared.set(delivery.deliveryId, {
      delivery,
      session,
      workspace: input.workspace,
      ...(planned === undefined ? {} : { planned }),
      ...(binding === undefined ? {} : { binding })
    });
    return delivery;
  }

  async waitUntilReady(delivery: PreparedRoleDelivery): Promise<ReadyRoleDelivery> {
    const prepared = this.requirePrepared(delivery);
    if (prepared.binding === undefined) {
      this.tmux.waitUntilReady(
        delivery.taskId,
        delivery.roleName,
        this.readiness(delivery.adapterId)
      );
    }
    return { prepared: delivery, session: prepared.session };
  }

  async sendOnce(input: Readonly<{
    delivery: ReadyRoleDelivery;
    receiptId: string;
    text: string;
    notificationId?: string;
  }>): Promise<RoleDeliveryReport> {
    const prepared = this.requirePrepared(input.delivery.prepared);
    if (prepared.binding !== undefined && this.runtimePorts !== undefined) {
      const runId = input.delivery.prepared.runId;
      if (runId === undefined && input.notificationId === undefined) {
        throw new Error("Runtime prompt delivery requires a Task-local AgentRun id.");
      }
      const outcome = await this.runtimePorts.promptPush.tryPush({
        binding: prepared.binding,
        envelope: createPromptEnvelope({
          id: input.receiptId,
          source: input.notificationId !== undefined ? {
            kind: "notification", taskId: input.delivery.prepared.taskId, localId: input.notificationId
          } : {
            kind: input.receiptId === formatRunReceiptId(
              input.delivery.prepared.taskId,
              runId!
            ) || input.receiptId.startsWith(`${formatRunReceiptId(
              input.delivery.prepared.taskId, runId!
            )}/attempt/`) ? "run" : "turn-input",
            taskId: input.delivery.prepared.taskId,
            localId: runId!
          },
          text: input.text,
          createdAt: new Date()
        })
      });
      if (outcome.result === "delivered") {
        this.#prepared.delete(input.delivery.prepared.deliveryId);
      }
      return deliveryReport(outcome);
    }
    const outcome = this.tmux.sendRoleInputOnce(
      input.delivery.prepared.taskId,
      input.delivery.prepared.roleName,
      input.receiptId,
      input.text,
      this.readiness(input.delivery.prepared.adapterId)
    );
    if (outcome === "sent" || outcome === "already-sent") {
      this.#prepared.delete(input.delivery.prepared.deliveryId);
    }
    return { status: outcome };
  }

  async steerOnce(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    nativeTurnId: string;
    authority: import("../runtime/providerAuthorityFence.js").ProviderAuthorityFence;
    receiptId: string;
    text: string;
  }>): Promise<RoleDeliveryReport> {
    if (this.runtimePorts === undefined) return { status: "unavailable" };
    const outcome = await this.runtimePorts.promptPush.trySteer({
      owner: { scope: "task", taskId: input.taskId, roleName: input.roleName },
      agentId: input.agentId,
      adapterId: input.adapterId,
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId,
      providerAuthority: input.authority,
      envelope: createPromptEnvelope({
        id: input.receiptId,
        source: { kind: "turn-input", taskId: input.taskId, localId: activeRunId(input.receiptId) },
        text: input.text,
        createdAt: new Date()
      })
    });
    return deliveryReport(outcome);
  }

  async notifyOperatorInputOnce(input: Readonly<{
    roleName: "operator";
    adapterId: string;
    receiptId: string;
    text: string;
  }>): Promise<"sent" | "already-sent" | "unavailable" | "not-ready"> {
    if (this.runtimePorts?.notifyOperatorInputOnce !== undefined) {
      return this.runtimePorts.notifyOperatorInputOnce(input);
    }
    const probe = this.readiness(input.adapterId, "operator");
    return this.tmux.sendRoleInputOnceIfReadyAsync === undefined
      ? this.tmux.sendRoleInputOnceIfReady(
          "operator", input.roleName, input.receiptId, input.text, probe
        )
      : this.tmux.sendRoleInputOnceIfReadyAsync(
          "operator", input.roleName, input.receiptId, input.text, probe
        );
  }

  forgetPrepared(input: Readonly<{
    taskId: string;
    roleName: string;
    runId?: string;
  }>): void {
    for (const [deliveryId, prepared] of this.#prepared) {
      const delivery = prepared.delivery;
      if (
        delivery.taskId !== input.taskId || delivery.roleName !== input.roleName || (input.runId !== undefined && delivery.runId !== input.runId)
      ) {
        continue;
      }
      this.#prepared.delete(deliveryId);
    }
  }

  async inspectRole(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"present" | "absent"> {
    if (TEST_ROLE_LIVENESS_PRESENT) return "present";
    const status = this.tmux.probeRoleStatusAsync === undefined
      ? this.tmux.probeRoleStatus(input.taskId, input.roleName)
      : await this.tmux.probeRoleStatusAsync(input.taskId, input.roleName);
    return status === "running"
      ? "present"
      : "absent";
  }

  async inspectRoleReadiness(input: Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
  }>): Promise<"ready" | "busy" | "absent"> {
    const status = await this.inspectRole(input);
    if (status === "absent") return "absent";
    try {
      const pane = this.tmux.inspectPaneAsync === undefined
        ? this.tmux.inspectPane?.(input.taskId, input.roleName)
        : await this.tmux.inspectPaneAsync(input.taskId, input.roleName);
      if (pane === undefined) return "busy";
      return this.readiness(input.adapterId)(pane) ? "ready" : "busy";
    } catch {
      // A pane can disappear between inventory and the targeted process snapshot; the
      // ordinary liveness pass will classify it on the next reconciliation.
      return "busy";
    }
  }

  async inspectRoles(inputs: readonly Readonly<{
    taskId: string;
    roleName: string;
    agentId: string;
    adapterId: string;
    nativeSessionId?: string;
    runId?: string;
    progressAt?: string;
  }>[], resourceInputs?: readonly SchedulerRoleResourceInput[]): Promise<readonly Readonly<{
    taskId: string;
    roleName: string;
    status: "present" | "absent";
    resource?: SchedulerRoleResourceEntry["resource"];
    hostExit?: Readonly<{ deadStatus?: number }>;
  }>[]> {
    if (TEST_ROLE_LIVENESS_PRESENT) {
      return inputs.map((input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: "present" as const
      }));
    }
    if (
      this.tmux.inspectRolePaneInventory === undefined
      && this.tmux.inspectRolePaneInventoryAsync === undefined
    ) {
      return Promise.all(inputs.map(async (input) => ({
        taskId: input.taskId,
        roleName: input.roleName,
        status: await this.inspectRole(input)
      })));
    }
    const inventory = this.tmux.inspectRolePaneInventoryAsync === undefined
      ? this.tmux.inspectRolePaneInventory!()
      : await this.tmux.inspectRolePaneInventoryAsync();
    let resources = new Map<string, SchedulerRoleResourceEntry["resource"]>();
    const requested = resourceInputs ?? inputs.map((input) => ({
      taskId: input.taskId,
      roleName: input.roleName,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      agentId: input.agentId,
      adapterId: input.adapterId,
      ...(input.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: input.nativeSessionId }),
      ...(input.progressAt === undefined ? {} : { progressAt: input.progressAt })
    }));
    if (
      this.runtimePorts?.roleResourceInventory !== undefined
      && requested.length > 0
    ) {
      try {
        for (const entry of await this.runtimePorts.roleResourceInventory(inventory, requested)) {
          const key = `${entry.taskId}\0${entry.roleName}`;
          if (!resources.has(key)) resources.set(key, entry.resource);
        }
      } catch {
        // Resource evidence is advisory. A failed process snapshot must not
        // turn the authoritative pane inventory into an absent observation.
      }
    }
    const present = new Set(
      inventory
        .filter((pane) => !pane.dead)
        .map((pane) => `${pane.taskId}\0${pane.roleName}`)
    );
    return inputs.map((input) => {
      const key = `${input.taskId}\0${input.roleName}`;
      const resource = resources.get(key);
      const deadPane = inventory.find((pane) => (
        pane.taskId === input.taskId && pane.roleName === input.roleName && pane.dead
      ));
      return {
        taskId: input.taskId,
        roleName: input.roleName,
        status: present.has(key) ? "present" : "absent",
        ...(resource === undefined ? {} : { resource }),
        ...(deadPane === undefined
          ? {}
          : { hostExit: {
              ...(deadPane.deadStatus === undefined ? {} : { deadStatus: deadPane.deadStatus })
            } })
      };
    });
  }

  async stopRole(taskId: string, roleName: string): Promise<boolean> {
    const status = this.tmux.probeRoleStatusAsync === undefined
      ? this.tmux.probeRoleStatus(taskId, roleName)
      : await this.tmux.probeRoleStatusAsync(taskId, roleName);
    if (status !== "running") {
      this.forgetPrepared({ taskId, roleName });
      return false;
    }
    if (this.tmux.killRoleAsync === undefined) {
      this.tmux.killRole(taskId, roleName);
    } else {
      await this.tmux.killRoleAsync(taskId, roleName);
    }
    this.forgetPrepared({ taskId, roleName });
    return true;
  }

  private requirePrepared(delivery: PreparedRoleDelivery): PreparedRuntime {
    const planned = this.#prepared.get(delivery.deliveryId);
    if (planned === undefined) {
      throw new Error(`Role delivery is not prepared: ${delivery.deliveryId}.`);
    }
    return planned;
  }
}

function activeRunId(receiptId: string): string {
  const match = /^turn-input:[^/]+\/([^/]+)\/[1-9]\d*$/u.exec(receiptId);
  if (match === null) throw new Error("AgentRun steer receipt is invalid.");
  return decodeURIComponent(match[1]!);
}

/**
 * Maps a runtime push outcome onto the Scheduler's delivery vocabulary while
 * keeping the Host's structured cause attached. Only the word for success
 * differs between the two layers; the failure record is forwarded unchanged.
 */
function deliveryReport(outcome: PromptPushOutcome): RoleDeliveryReport {
  return {
    status: outcome.result === "delivered" ? "sent" : outcome.result,
    ...(outcome.failure === undefined ? {} : { failure: outcome.failure })
  };
}

export function agentProcessReadinessProbe(
  adapterId: string,
  _surface: "role" | "operator" = "role"
): TmuxReadinessProbe {
  // A tmux pane probe is only meaningful for an Agent that actually has an
  // interactive CLI surface. Asking a protocol-only Agent whether its pane
  // looks alive would answer a question about the wrong thing, so the refusal
  // is derived from the declared surface rather than from an adapter name.
  const driver = builtinAgentDriverRegistry().findByAdapterId(adapterId);
  if (driver === null || !driver.capabilities.surfaces.includes("interactive-cli")) {
    throw new Error(`No tmux readiness probe is registered for Agent adapter: ${adapterId}.`);
  }
  // AgentRun state and receipt fences decide whether delivery is allowed. Provider
  // terminal contents are display-only evidence and never lifecycle input.
  return livePane;
}

function livePane(pane: TmuxPaneState): boolean {
  return !pane.dead && pane.pid !== undefined && pane.currentCommand.trim().length > 0;
}

function preparedDeliveryId(input: Readonly<{
  taskId: string;
  roleName: string;
    agentId: string;
    adapterId: string;
    effective: EffectiveLaunchSnapshot;
    mode: RoleSessionLaunchMode;
  runId?: string;
  nativeSessionId?: string;
}>): string {
  return createHash("sha256").update(JSON.stringify([
    input.taskId,
    input.roleName,
    input.agentId,
    input.adapterId,
    input.effective,
    input.mode,
    input.runId ?? null,
    input.nativeSessionId ?? null
  ])).digest("hex");
}

function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
