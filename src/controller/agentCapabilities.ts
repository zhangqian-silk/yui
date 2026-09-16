import type { JsonValue } from "../core/protocol.js";
import { usageError } from "../errors/cliError.js";
import { resolveTaskAgentCapabilities, type TaskAgentCapabilityResult } from "../executor/taskAgentCapabilities.js";
import type { AgentConfigurationCatalogService } from "../executor/agentConfigurationCatalog.js";
import { requireManagedGlobalCaller } from "../runtime/managedCaller.js";
import type { TaskStore } from "../storage/taskStore.js";

const READER_FIELDS = [
  "YUI_SESSION_SCOPE", "YUI_TASK_ID", "YUI_ROLE", "YUI_NATIVE_SESSION_ID",
  "YUI_AGENT_ID", "YUI_ADAPTER_ID", "YUI_WORKSPACE", "CODEX_THREAD_ID"
] as const;

/** Transport only the existing reader identity, never the caller's credentials. */
export function capabilityReaderIdentity(environment: NodeJS.ProcessEnv): Record<string, string> {
  if (environment.YUI_SESSION_SCOPE === undefined) {
    if (["YUI_ROLE", "YUI_AGENT_ID", "YUI_NATIVE_SESSION_ID"].some(key => environment[key] !== undefined)) {
      throw usageError("Managed reader identity is incomplete.");
    }
    return {};
  }
  return Object.fromEntries(READER_FIELDS.flatMap(key =>
    environment[key] === undefined ? [] : [[key, environment[key]!]]));
}

/** Metadata discovery uses the Controller's launch environment. No start,
 * retry, credential forwarding or Role mutation belongs to this read port. */
export async function readTaskAgentCapabilities(
  store: TaskStore, catalogs: AgentConfigurationCatalogService, params: JsonValue
): Promise<JsonValue> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw usageError("Task capability query parameters are invalid.");
  }
  const input = params as { readonly [key: string]: JsonValue };
  if (Object.keys(input).some(key => !["taskId", "roleName", "errorId", "refresh", "reader"].includes(key))
    || typeof input.taskId !== "string" || input.taskId.length === 0
    || typeof input.roleName !== "string" || input.roleName.length === 0
    || (input.errorId !== undefined && (typeof input.errorId !== "string" || input.errorId.length === 0))
    || (input.refresh !== undefined && typeof input.refresh !== "boolean")
    || !input.reader || typeof input.reader !== "object" || Array.isArray(input.reader)) {
    throw usageError("Task capability query parameters are invalid.");
  }
  const reader: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.reader)) {
    if (!(READER_FIELDS as readonly string[]).includes(key) || typeof value !== "string") {
      throw usageError("Task capability reader contains unsupported fields.");
    }
    reader[key] = value;
  }
  if (Object.keys(reader).length > 0 && reader.YUI_SESSION_SCOPE !== "task"
    && reader.YUI_SESSION_SCOPE !== "global") throw usageError("Managed reader scope is invalid.");
  if (reader.YUI_SESSION_SCOPE === "global") {
    const caller = requireManagedGlobalCaller(store, reader);
    if (caller.roleName !== "operator") throw usageError("Only the Operator may query another Role's native configuration.");
  }
  const request = resolveTaskAgentCapabilities({
    taskId: input.taskId, roleName: input.roleName,
    ...(input.errorId === undefined ? {} : { errorId: input.errorId as string }),
    refresh: input.refresh === true,
  }, store, reader);
  const resolved = await catalogs.resolve(request.input);
  const result: TaskAgentCapabilityResult = {
    ...resolved, context: { ...request.context, environmentSource: "controller" }
  };
  return result as unknown as JsonValue;
}
