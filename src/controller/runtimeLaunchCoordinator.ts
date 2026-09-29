import type { RuntimeRoleOwner } from "../runtime/lifecycleReservation.js";
import {
  createRuntimeBinding,
  type RuntimeBinding,
  type RuntimeLaunchPreStart,
  type RuntimeLaunchPreparationPort,
  type RuntimeLaunchPreparationRequest,
  type SessionHostPort
} from "../runtime/index.js";
import { sameEffectiveLaunch, validateEffectiveLaunchSnapshot } from "../executor/effectiveLaunch.js";
import type { TaskRuntimeIsolationPort } from "../runtime/taskRuntimeIsolation.js";

export type CoordinatedRuntimeLaunchRequest = RuntimeLaunchPreparationRequest;
export type RuntimeLaunchSessionPort = Readonly<{
  recordLaunchedRuntimeNativeSession(input: Readonly<{
    owner: RuntimeRoleOwner;
    agentId: string;
    adapterId: string;
    nativeSessionId: string;
    effective: import("../executor/effectiveLaunch.js").EffectiveLaunchSnapshot;
  }>, assertCurrent: () => void, now?: Date): void;
}>;
export type RuntimeLaunchCoordinatorOptions = Readonly<{
  now?: () => Date;
  assertCurrent?: (request: CoordinatedRuntimeLaunchRequest) => void;
  runtimeIsolation?: TaskRuntimeIsolationPort;
}>;

/** Serialize local Role launches; failures preserve resources for explicit recovery. */
export class RuntimeLaunchCoordinator implements RuntimeLaunchPreparationPort {
  readonly #launchTails = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: RuntimeLaunchSessionPort,
    private readonly host: SessionHostPort,
    private readonly options: RuntimeLaunchCoordinatorOptions = {}
  ) {}

  async prepare(
    request: CoordinatedRuntimeLaunchRequest,
    assertCurrent?: () => void,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    const key = request.owner.scope === "task"
      ? `task\0${request.owner.taskId}\0${request.owner.roleName}`
      : `global\0${request.owner.roleName}`;
    const previous = this.#launchTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.#launchTails.set(key, tail);
    await previous;
    try {
      return await this.#launch(request, assertCurrent, beforeHostStart);
    } finally {
      release();
      if (this.#launchTails.get(key) === tail) this.#launchTails.delete(key);
    }
  }

  async #launch(
    request: CoordinatedRuntimeLaunchRequest,
    assertCurrent?: () => void,
    beforeHostStart?: RuntimeLaunchPreStart
  ): Promise<RuntimeBinding> {
    const effective = validateEffectiveLaunchSnapshot(request.effective);
    if (effective.agentId !== request.agentId
      || effective.adapterId !== request.adapterId
      || effective.workspace.root !== request.workspace) {
      throw new TypeError("Runtime launch does not match its effective configuration.");
    }
    if (request.owner.scope === "global" && request.managedWorkspace !== undefined) {
      throw new Error("A global runtime cannot use a Task ManagedWorkspace.");
    }
    const assertLaunchCurrent = () => {
      this.options.assertCurrent?.(request);
      assertCurrent?.();
    };
    assertLaunchCurrent();
    let isolation;
    if (request.owner.scope === "task" && this.options.runtimeIsolation !== undefined) {
      const workspace = request.managedWorkspace;
      // Draft planning has no delivery workspace to isolate. Active Task
      // launches require the exact authoritative ManagedWorkspace below.
      if (request.workspaceFree === true) {
        if (workspace !== undefined) {
          throw new Error("A workspace-free Task launch cannot carry a ManagedWorkspace.");
        }
      } else if (workspace === undefined || workspace.owner.taskId !== request.owner.taskId
        || workspace.root !== request.workspace) {
        throw new Error("Task launch requires its authoritative ManagedWorkspace.");
      } else {
        isolation = this.options.runtimeIsolation.preflight({
          workspace,
          ...(request.runtimePolicy === undefined ? {} : { policy: request.runtimePolicy }),
          allowExactActive: true
        });
        this.options.runtimeIsolation.activate(isolation);
      }
    }
    let preflightObserved = beforeHostStart === undefined;
    const observePreflight: RuntimeLaunchPreStart = (preflight) => {
      if (preflightObserved || !sameOwner(preflight.owner, request.owner)
        || preflight.runId !== request.runId
        || preflight.agentId !== request.agentId
        || preflight.adapterId !== request.adapterId
        || !sameEffectiveLaunch(preflight.effective, request.effective)
        || (request.mode === "resume" && preflight.nativeSessionId !== request.nativeSessionId)) {
        throw new Error("Session host pre-start facts do not match the requested launch.");
      }
      assertLaunchCurrent();
      preflightObserved = true;
      beforeHostStart?.(preflight);
    };
    const shared = {
      owner: request.owner,
      agentId: request.agentId,
      adapterId: request.adapterId,
      effective,
      workspace: request.workspace,
      ...(isolation === undefined ? {} : { runtimeIsolation: isolation.descriptor }),
      ...(request.runId === undefined ? {} : { runId: request.runId }),
      ...(request.environment === undefined ? {} : { environment: request.environment })
    };
    const callback = beforeHostStart === undefined ? undefined : observePreflight;
    if (request.mode === "resume" && !request.nativeSessionId) {
      throw new Error("Restoring a Session requires its native session id.");
    }
    const binding = createRuntimeBinding(request.mode === "new"
      ? await this.host.start({ ...shared, mode: "new" }, callback)
      : await this.host.restore({
          ...shared, mode: "resume", nativeSessionId: request.nativeSessionId!
        }, callback));
    if (!preflightObserved || !sameOwner(binding.owner, request.owner)
      || binding.agentId !== request.agentId || binding.adapterId !== request.adapterId
      || (request.mode === "resume" && binding.nativeSessionId !== request.nativeSessionId)) {
      throw new Error("Session host returned facts inconsistent with the requested launch.");
    }
    if (binding.nativeSessionId !== undefined) {
      this.sessions.recordLaunchedRuntimeNativeSession({
        owner: request.owner,
        agentId: request.agentId,
        adapterId: request.adapterId,
        nativeSessionId: binding.nativeSessionId,
        effective
      }, assertLaunchCurrent, this.options.now?.() ?? new Date());
    }
    return binding;
  }
}

function sameOwner(a: RuntimeRoleOwner, b: RuntimeRoleOwner): boolean {
  return a.scope === b.scope && a.roleName === b.roleName
    && (a.scope === "global" || (b.scope === "task" && a.taskId === b.taskId));
}
