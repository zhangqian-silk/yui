import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { renderCompletion } from "../cli/completion.js";
import { dataError } from "../errors/cliError.js";
import { defaultTableWidth, renderTable } from "../output/table.js";

export const COMPLETION_SHELLS = Object.freeze(["bash", "zsh", "fish"] as const);

export type CompletionShell = typeof COMPLETION_SHELLS[number];
export type CompletionStatus = "Installed" | "Not installed" | "Needs repair";
export type CompletionAction = "Refresh" | "Install" | "Repair";

export type CompletionInstallation = Readonly<{
  scriptPath: string;
  activationPath: string;
}>;

export type CompletionConfig = Readonly<{
  schemaVersion?: number;
  defaultAgent?: string;
  defaultWorkspace?: string;
  timeZone?: string;
  completionInstallations?: Partial<Record<CompletionShell, CompletionInstallation>>;
}>;

export type CompletionState = Readonly<{
  shell: CompletionShell;
  status: CompletionStatus;
  action: CompletionAction;
  current: boolean;
  installation?: CompletionInstallation;
}>;

export function currentCompletionShell(env: NodeJS.ProcessEnv): CompletionShell | undefined {
  const value = basename(env.SHELL ?? "").toLowerCase();
  return COMPLETION_SHELLS.includes(value as CompletionShell)
    ? value as CompletionShell
    : undefined;
}

export function suggestedCompletionInstallation(
  shell: CompletionShell,
  env: NodeJS.ProcessEnv
): CompletionInstallation {
  const home = absoluteEnvRoot("HOME", env.HOME);
  if (shell === "bash") {
    const data = env.XDG_DATA_HOME === undefined
      ? join(home, ".local", "share")
      : absoluteEnvRoot("XDG_DATA_HOME", env.XDG_DATA_HOME);
    return {
      scriptPath: join(data, "bash-completion", "completions", "yui"),
      activationPath: join(home, ".bashrc")
    };
  }
  if (shell === "zsh") {
    const zshRoot = env.ZDOTDIR === undefined
      ? home
      : absoluteEnvRoot("ZDOTDIR", env.ZDOTDIR);
    return {
      scriptPath: join(zshRoot, ".zfunc", "_yui"),
      activationPath: join(zshRoot, ".zshrc")
    };
  }
  const config = env.XDG_CONFIG_HOME === undefined
    ? join(home, ".config")
    : absoluteEnvRoot("XDG_CONFIG_HOME", env.XDG_CONFIG_HOME);
  return {
    scriptPath: join(config, "fish", "completions", "yui.fish"),
    activationPath: join(config, "fish", "config.fish")
  };
}

export function inspectCompletionStates(
  config: CompletionConfig,
  env: NodeJS.ProcessEnv
): CompletionState[] {
  const current = currentCompletionShell(env);
  return COMPLETION_SHELLS.map((shell) => {
    const installation = config.completionInstallations?.[shell];
    if (installation === undefined) {
      return {
        shell,
        status: "Not installed",
        action: "Install",
        current: shell === current
      };
    }
    const installed = completionScriptIsCurrent(shell, installation)
      && completionActivationIsCurrent(shell, installation, env);
    return {
      shell,
      status: installed ? "Installed" : "Needs repair",
      action: installed ? "Refresh" : "Repair",
      current: shell === current,
      installation
    };
  });
}

export function renderCompletionStateTable(
  states: readonly CompletionState[],
  width = defaultTableWidth()
): string {
  return renderTable(
    "Completion installation",
    [
      { header: "#", minWidth: 1, maxWidth: 3 },
      { header: "Shell", minWidth: 4, maxWidth: 6 },
      { header: "Status", minWidth: 12, maxWidth: 13 },
      { header: "Action", minWidth: 7, maxWidth: 7 },
      { header: "Current", minWidth: 7, maxWidth: 7 },
      { header: "Script", minWidth: 8, maxWidth: 88 }
    ],
    states.map((state, index) => [
      String(index + 1),
      shellLabel(state.shell),
      state.status,
      state.action,
      state.current ? "yes" : "",
      state.installation?.scriptPath ?? ""
    ]),
    width
  );
}

export function managedCompletionScript(shell: CompletionShell): string {
  return `${completionMarker(shell)}\n${renderCompletion(shell)}`;
}

export function completionMarker(shell: CompletionShell): string {
  return `# yui-completion: managed shell=${shell} identity=yui format=1`;
}

export function activationBlock(
  shell: CompletionShell,
  installation: CompletionInstallation
): string {
  const start = activationStart(shell);
  const end = activationEnd(shell);
  const source = `source ${shellQuote(installation.scriptPath)}`;
  const functionName = basename(installation.scriptPath);
  const body = shell === "zsh"
    ? `fpath=(${shellQuote(dirname(installation.scriptPath))} $fpath)\nautoload -Uz compinit\n(( $+functions[compdef] )) || compinit\nautoload -Uz -- ${shellQuote(functionName)}\ncompdef ${shellQuote(functionName)} 'yui'`
    : source;
  return `${start}\n${body}\n${end}`;
}

export function activationStart(shell: CompletionShell): string {
  return `# >>> yui completion shell=${shell} identity=yui >>>`;
}

export function activationEnd(shell: CompletionShell): string {
  return `# <<< yui completion shell=${shell} identity=yui <<<`;
}

export function activationIsAutomatic(
  shell: CompletionShell,
  installation: CompletionInstallation,
  env: NodeJS.ProcessEnv
): boolean {
  return shell === "fish"
    && installation.scriptPath === suggestedCompletionInstallation(shell, env).scriptPath;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function completionScriptIsCurrent(
  shell: CompletionShell,
  installation: CompletionInstallation
): boolean {
  return safeRegularFile(installation.scriptPath)
    && readFileSync(installation.scriptPath, "utf8") === managedCompletionScript(shell);
}

export function completionActivationIsCurrent(
  shell: CompletionShell,
  installation: CompletionInstallation,
  env: NodeJS.ProcessEnv
): boolean {
  if (activationIsAutomatic(shell, installation, env)) return true;
  if (!safeRegularFile(installation.activationPath)) return false;
  const contents = readFileSync(installation.activationPath, "utf8");
  const block = activationBlock(shell, installation);
  return contents.split(block).length === 2;
}

function safeRegularFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = lstatSync(path);
  return stat.isFile() && !stat.isSymbolicLink();
}

function absoluteEnvRoot(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0 || !isAbsolute(value)) {
    throw dataError(`${name} must be an absolute path for completion installation.`);
  }
  return resolve(value);
}

function shellLabel(shell: CompletionShell): string {
  return `${shell[0]?.toUpperCase() ?? ""}${shell.slice(1)}`;
}
