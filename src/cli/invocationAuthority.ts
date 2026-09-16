import { usageError } from "../errors/cliError.js";
import { requireManagedGlobalCaller, type ManagedGlobalCallerStore } from "../runtime/managedCaller.js";
import { routeInvocation } from "./invocationRouter.js";
import { findInteractionPolicy } from "./interactionPolicy.js";
import { TASK_RECORD_ID_PREFIXES } from "../task/taskRecordReference.js";
import { taskDiagnosticTarget } from "./managedDiagnostics.js";

/** Configuration reads remain available; every Home configuration mutation
 * has one owner, irrespective of which config subcommand parses its flags. */
export function assertConfigurationAuthority(
  args: readonly string[], store: ManagedGlobalCallerStore, env: NodeJS.ProcessEnv
): void {
  const configurationWrite = args[0] === "config"
    && !["show", "describe"].includes(args[1] ?? "")
    && !["show", "list", "capabilities", "status", "candidates"].includes(args[2] ?? "");
  const resourceWrite = args[0] === "resources" && args.some(arg => ["--apply", "--purge", "--restore"].includes(arg));
  if (!configurationWrite && !resourceWrite) return;
  if (env.YUI_SESSION_SCOPE === "global" && env.YUI_ROLE === "operator") {
    requireManagedGlobalCaller(store, env);
    return;
  }
  if (env.YUI_SESSION_SCOPE !== undefined || env.YUI_ROLE !== undefined
    || env.YUI_AGENT_ID !== undefined || env.YUI_NATIVE_SESSION_ID !== undefined) {
    throw usageError("Home configuration and resource mutations require the user or current Operator, not a Task Assignment.");
  }
}

/** The parsed command path identifies the first target argument, never a
 * string found in a body/flag value. Record-local references retain their
 * normal command-specific parser; an explicit foreign Task cannot pass it. */
export function assertTaskInvocationScope(args: readonly string[], env: NodeJS.ProcessEnv): void {
  if (env.YUI_SESSION_SCOPE !== "task") return;
  if (args[0] === "jobs" || (args[0] === "task" && ["create", "overlap"].includes(args[1] ?? ""))) {
    throw usageError("This global operation is outside the caller's Task; use its scoped Context.");
  }
  if (args[0] !== "task" || args[1] === "list") return;
  const diagnostic = taskDiagnosticTarget(args);
  if (diagnostic !== undefined) {
    if (diagnostic !== env.YUI_TASK_ID) throw usageError("Command target is outside the caller's Task.");
    return;
  }
  const invocation = routeInvocation([...args]);
  if (invocation.kind !== "execute") return;
  let targetIndex = invocation.node.path.length - 1;
  const optionSyntax = findInteractionPolicy(invocation.node)?.trailingOptions;
  while (args[targetIndex]?.startsWith("--")) {
    // Reuse known option arity, not any picker/confirmation authority. An
    // unclassified prefix cannot turn a missing target into permission.
    const kind = optionSyntax?.[args[targetIndex]!];
    if (kind === undefined) throw usageError("Place this command's Task target before its options so its scope is explicit.");
    targetIndex += kind === "flag" ? 1 : 2;
  }
  const target = args[targetIndex];
  if (target === undefined) return; // The domain parser still requires its target.
  const taskId = target.split("/")[0];
  const local = !target.includes("/") && Object.values(TASK_RECORD_ID_PREFIXES)
    .some(prefix => target.startsWith(`${prefix}-`));
  if (!local && taskId !== env.YUI_TASK_ID) {
    throw usageError("Command target is outside the caller's Task.");
  }
}
