import type { JsonObject } from "./jsonLineChannel.js";
import { isDeepStrictEqual } from "node:util";

export type CodexNativeRequest = Readonly<{
  id: string | number;
  method: string;
  threadId: string;
  turnId: string | null;
  params: JsonObject;
}>;

export interface CodexNativeAccess {
  readonly attached: boolean;
  readonly initialized: JsonObject;
  readonly requests: readonly CodexNativeRequest[];
  read(method: string, params: JsonObject): Promise<JsonObject>;
  validateTurn(params: JsonObject): void;
  respond(id: string | number, threadId: string, turnId: string | null, result: JsonObject): Promise<void>;
  events(listener: (message: JsonObject) => void): () => void;
}

const READS = new Set([
  "config/read", "configRequirements/read", "model/list", "collaborationMode/list",
  "experimentalFeature/list", "skills/list", "hooks/list", "mcpServerStatus/list", "account/read",
  "account/rateLimits/read", "modelProvider/capabilities/read", "permissionProfile/list",
  "thread/read", "thread/turns/list", "thread/items/list", "thread/goal/get"
]);
const REQUESTS = new Set([
  "item/commandExecution/requestApproval", "item/fileChange/requestApproval",
  "item/tool/requestUserInput", "item/permissions/requestApproval", "mcpServer/elicitation/request"
]);

/** A view of one existing connection, never another Thread or durable input queue.
 * Both the native TUI and Web answer the original server request on this transport. */
export function createCodexNativeAccess(
  threadId: string, initialized: JsonObject,
  channel: {
    request(method: string, params: JsonObject): Promise<JsonObject>;
    send(message: JsonObject): Promise<void>;
    onMessage(listener: (message: JsonObject) => void): () => void;
  },
  openingMessages: readonly JsonObject[] = []
): CodexNativeAccess {
  const pending = new Map<string | number, CodexNativeRequest>();
  const listeners = new Set<(message: JsonObject) => void>();
  let configuration: JsonObject | undefined;
  const observe = (message: JsonObject): void => {
    const params = message.params as JsonObject | undefined;
    if (params?.threadId !== threadId) return;
    if ((typeof message.id === "string" || typeof message.id === "number")
      && typeof message.method === "string" && REQUESTS.has(message.method)
      && (typeof params.turnId === "string"
        || (message.method === "mcpServer/elicitation/request" && params.turnId == null))) {
      pending.set(message.id, { id: message.id, method: message.method,
        threadId, turnId: typeof params.turnId === "string" ? params.turnId : null, params });
    }
    if (message.method === "serverRequest/resolved") pending.delete(params.requestId as string | number);
    if (message.method === "turn/completed") {
      const turn = params.turn as JsonObject | undefined;
      for (const [id, request] of pending) if (request.turnId === turn?.id) pending.delete(id);
    }
    for (const listener of listeners) listener(message);
  };
  for (const message of openingMessages) observe(message);
  channel.onMessage(observe);
  return {
    initialized,
    get attached() { return listeners.size > 0; },
    get requests() { return [...pending.values()]; },
    async read(method, params) {
      // TUI startup attaches to the already opened Thread without resuming it
      // with new options or changing the Host's configured execution boundary.
      if (method === "thread/resume") {
        if (params.threadId !== threadId) throw new Error("Select the existing Session; new/forked Threads are not supported here.");
        const page = params.initialTurnsPage as JsonObject | undefined;
        configuration = await channel.request("thread/resume", { threadId,
          ...(typeof params.excludeTurns === "boolean" ? { excludeTurns: params.excludeTurns } : {}),
          ...(page ? { initialTurnsPage: { ...page, limit: Math.min(40, typeof page.limit === "number" && page.limit > 0 ? page.limit : 40) } } : {}) });
        return configuration;
      }
      if (!READS.has(method)) throw new Error(`Native operation is not available in managed access: ${method}.`);
      if (method.startsWith("thread/") && params.threadId !== threadId) {
        throw new Error("Native read targets a different Thread.");
      }
      // Native TUI owns its hydration protocol (legacy TUI can explicitly ask
      // for full turns). Web history remains independently bounded/paginated.
      return channel.request(method, method === "thread/turns/list" || method === "thread/items/list"
          ? { ...params, limit: Math.min(40, typeof params.limit === "number" && params.limit > 0 ? params.limit : 40) }
          : params);
    },
    validateTurn(params) {
      if (!configuration) throw new Error("Native TUI has not attached to the existing Thread.");
      for (const [key, source] of Object.entries({
        model: "model", cwd: "cwd", runtimeWorkspaceRoots: "runtimeWorkspaceRoots",
        approvalPolicy: "approvalPolicy", approvalsReviewer: "approvalsReviewer",
        effort: "reasoningEffort", collaborationMode: "collaborationMode"
      })) {
        if (params[key] != null && !isDeepStrictEqual(params[key], configuration[source])) {
          throw new Error(`Native ${key} differs from the managed Session; change it through Yui configuration.`);
        }
      }
      for (const key of ["sandboxPolicy", "permissions", "environments", "toolOutput", "additionalContext", "outputSchema", "disabledPluginIds", "serviceTierForTurn", "summary", "personality", "cyberAccessProgram"]) {
        if (params[key] != null) throw new Error(`Native ${key} overrides are not supported in managed access.`);
      }
      if (params.serviceTier != null && params.serviceTier !== (configuration.serviceTier ?? "default")) {
        throw new Error("Native service tier differs from the managed Session.");
      }
    },
    async respond(id, expectedThread, turnId, result) {
      const request = pending.get(id);
      if (!request || request.threadId !== expectedThread || request.turnId !== turnId) {
        throw new Error("Native request is no longer pending for this exact Thread and Turn.");
      }
      validateNativeResponse(request, result);
      // Claim before awaiting transport. A lost send acknowledgement is unknown,
      // not permission for another entry to repeat a possibly applied answer.
      pending.delete(id);
      await channel.send({ id, result });
    },
    events(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}

function validateNativeResponse(request: CodexNativeRequest, result: JsonObject): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Missing native response.");
  if (request.method === "mcpServer/elicitation/request") {
    if (!["accept", "decline", "cancel"].includes(String(result.action))
      || (result.action !== "accept" && result.content != null)) {
      throw new Error("Invalid native MCP elicitation response.");
    }
  } else if (request.method === "item/tool/requestUserInput") {
    const answers = result.answers;
    const questions = request.params.questions;
    if (!answers || typeof answers !== "object" || Array.isArray(answers) || !Array.isArray(questions)) {
      throw new Error("Native question requires answers keyed by question id.");
    }
    const ids = questions.map(q => (q as JsonObject).id);
    if (Object.keys(answers).some(id => !ids.includes(id))
      || ids.some(id => {
        if (typeof id !== "string") return true;
        const answer = (answers as JsonObject)[id] as JsonObject | undefined;
        return !Array.isArray(answer?.answers) || answer.answers.some(value => typeof value !== "string");
      })) {
      throw new Error("Native answers do not match the original questions.");
    }
  } else if (request.method === "item/permissions/requestApproval") {
    // Web currently exposes decline only; richer native grants remain the TUI's
    // protocol responsibility. Never infer broad grants from an accept button.
    if (!result.permissions || typeof result.permissions !== "object") throw new Error("Missing native permissions response.");
  } else if (!["accept", "acceptForSession", "decline", "cancel"].includes(String(result.decision))) {
    throw new Error("Invalid native approval decision.");
  }
}
