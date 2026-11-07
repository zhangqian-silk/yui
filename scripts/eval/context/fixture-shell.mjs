import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./common.mjs";

// Evaluator-only launch configuration, not a global Codex setting or an OS
// security boundary. The Provider process retains its normal authentication;
// Subject shell commands get a disposable HOME and a minimal executable path.
export const fixtureShellPolicy = {
  version: 2, allowLoginShell: false, inheritedEnvironment: "none",
  home: "fixture/user", path: "fixture/bin:/usr/bin:/bin",
  stdoutCapture: "sandbox-owned-regular-file-terminal-replay",
  nestedShellStartup: "fixture-owned", isolation: "command-binding-only"
};
export function fixtureShellEnvironment(root) {
  const user = join(root, "user");
  return { HOME: user, PATH: `${join(root, "bin")}:/usr/bin:/bin`,
    ZDOTDIR: user, BASH_ENV: join(user, ".fixture-env"), ENV: join(user, ".fixture-env") };
}
export function prepareFixtureShell(root) {
  const environment = fixtureShellEnvironment(root);
  mkdirSync(environment.HOME, { recursive: true });
  const body = Object.entries(environment).map(([name, value]) => `export ${name}=${shellQuote(value)}`).join("\n") + "\n";
  for (const file of [".fixture-env", ".profile", ".bash_profile", ".bashrc", ".zshenv", ".zprofile", ".zshrc"]) {
    writeFileSync(join(environment.HOME, file), body, { flag: "wx", mode: 0o600 });
  }
  return environment;
}
export function fixtureThreadParameters(params, root, controllerBridge) {
  const config = params.config ?? {}, shell = config.shell_environment_policy ?? {};
  if (controllerBridge && (controllerBridge.home !== join(root, "state")
    || controllerBridge.directory !== join(root, ".controller-bridge"))) throw Error("Foreign fixture Controller bridge");
  return { ...params,
    ...(controllerBridge ? { runtimeWorkspaceRoots: [...new Set([...params.runtimeWorkspaceRoots,
      controllerBridge.home, controllerBridge.directory])] } : {}),
    config: { ...config,
      ...(controllerBridge ? { sandbox_workspace_write: { ...config.sandbox_workspace_write, network_access: false } } : {}),
      allow_login_shell: false,
    shell_environment_policy: { ...shell, inherit: "none",
      set: { ...(shell.set ?? {}), ...fixtureShellEnvironment(root) } } } };
}
