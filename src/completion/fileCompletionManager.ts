import type {
  CompletionInstallRequest,
  CompletionOverview,
  CompletionPort,
  CompletionPortState
} from "./completionPort.js";
import { installCompletion, type CompletionStore } from "./completionInstaller.js";
import {
  COMPLETION_SHELLS,
  completionActivationIsCurrent,
  completionScriptIsCurrent,
  currentCompletionShell,
  suggestedCompletionInstallation,
  type CompletionAction,
  type CompletionStatus
} from "./completionState.js";

/** Durable completion port used by the interactive CLI wizard. */
export class FileCompletionManager implements CompletionPort {
  readonly #store: CompletionStore;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    store: CompletionStore,
    env: NodeJS.ProcessEnv
  ) {
    this.#store = store;
    this.#env = { ...env };
  }

  inspect(): CompletionOverview {
    const config = this.#store.getConfig();
    const currentShell = currentCompletionShell(this.#env);
    const states = COMPLETION_SHELLS.map((shell): CompletionPortState => {
      const suggested = suggestedCompletionInstallation(shell, this.#env);
      const stored = config.completionInstallations?.[shell];
      const installation = stored ?? suggested;
      const scriptCurrent = completionScriptIsCurrent(shell, installation);
      const activationCurrent = completionActivationIsCurrent(
        shell,
        installation,
        this.#env
      );
      const status: CompletionStatus = scriptCurrent && activationCurrent
        ? "Installed"
        : stored === undefined ? "Not installed" : "Needs repair";
      const action: CompletionAction = status === "Installed"
        ? "Refresh"
        : status === "Needs repair" ? "Repair" : "Install";
      return Object.freeze({
        shell,
        status,
        action,
        current: shell === currentShell,
        configured: stored !== undefined,
        activationCurrent,
        installation,
        suggested
      });
    });
    return Object.freeze({
      identity: "yui",
      ...(currentShell === undefined ? {} : { currentShell }),
      states: Object.freeze(states)
    });
  }

  install(request: CompletionInstallRequest): void {
    installCompletion(
      this.#store,
      request.shell,
      request.installation,
      this.#env,
      request.activate
    );
  }
}
