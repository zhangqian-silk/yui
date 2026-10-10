import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";

import { CliError, usageError } from "../errors/cliError.js";
import { parseTaskCatalogOptions } from "../context/taskCatalog.js";
import { parseTaskSearchOptions, searchTaskBodies } from "../context/taskSearch.js";
import { readTaskUsage } from "../runtime/taskUsageQuery.js";
import type { WebTaskSurface, WebControlInput } from "./webTaskSurface.js";
import { WebRequestRejected } from "./webMutation.js";
import type { createTaskPreviews } from "./taskPreviews.js";
import type { createWebConversationSurface } from "./webConversation.js";
import type { RoleSessionOwner } from "../executor/agentExecutor.js";
import type { WebSettings } from "./webSettings.js";
import { SETTINGS_HTML } from "./assets/shell/settings.js";
import { TASK_SUBMISSION_INTENTS, type TaskSubmissionIntent } from "../message/message.js";
import type { SurfaceContributionRef, SurfacePanelContribution } from "../surface/surfaceContributions.js";
import type { CapabilityResult } from "../kernel/capabilityRegistry.js";
import { DASHBOARD_HTML, findWebAsset, type WebAsset } from "./assets/assetManifest.js";
import {
  buildWebTaskCatalog,
  buildWebPageSessions,
  buildWebTaskDetail,
  type WebDashboardStore
} from "./webSnapshot.js";

const MAX_JSON_BODY_BYTES = 16 * 1024;
const MAX_TERMINAL_MESSAGE_BYTES = 64 * 1024;
const MAX_TERMINAL_BUFFERED_BYTES = 1024 * 1024;

export type WebServerOptions = Readonly<{ host: string; port: number }>;
export type YuiWebServer = Server & Readonly<{ closeTerminals(): void }>;

export type WebInputAnswer =
  | Readonly<{ choiceKey: string }>
  | Readonly<{ text: string }>;

export type WebTerminalRequest =
  | Readonly<{
      scope: "global";
      roleName: string;
      columns: number;
      rows: number;
      nativeSessionId?: string;
    }>
  | Readonly<{
      scope: "task";
      taskId: string;
      roleName: string;
      columns: number;
      rows: number;
      nativeSessionId?: string;
    }>;

export type WebTerminalConnection = Readonly<{
  readOnly: boolean;
  history?: Readonly<{ limit: number; target: number }>;
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: Readonly<{ exitCode: number; signal?: number }>) => void): () => void;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  close(): void;
}>;

export type WebServerDependencies = Readonly<{
  previews?: () => ReturnType<typeof createTaskPreviews>;
  conversation?: ReturnType<typeof createWebConversationSurface>;
  settings?: WebSettings;
  panels?: Readonly<{
    list(taskId: string): readonly SurfacePanelContribution[];
    read(taskId: string, ref: SurfaceContributionRef, input: unknown): Promise<CapabilityResult>;
  }>;
  surface?: WebTaskSurface;
  now?: () => Date;
  token?: string;
  answerInput?: (input: Readonly<{
    taskId: string;
    inputId: string;
    answer: WebInputAnswer;
  }>) => Promise<unknown>;
  terminal?: Readonly<{
    open(request: WebTerminalRequest): Promise<WebTerminalConnection>;
  }>;
}>;

export function parseWebCommandOptions(args: readonly string[]): WebServerOptions {
  let host = "127.0.0.1";
  let port = 4173;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--host" && value !== undefined) {
      host = value;
      index += 1;
    } else if (option === "--port" && value !== undefined) {
      port = Number(value);
      index += 1;
    } else {
      throw webUsageError();
    }
  }
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) {
    throw usageError("Web host must be a loopback address (127.0.0.1, ::1, or localhost).", webUsage());
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw usageError("Web port must be an integer between 1 and 65535.", webUsage());
  }
  return { host, port };
}

export function createYuiWebServer(
  store: WebDashboardStore,
  dependencies: WebServerDependencies = {}
): YuiWebServer {
  const now = dependencies.now ?? (() => new Date());
  const token = dependencies.token ?? randomBytes(24).toString("base64url");
  const httpDependencies = { ...dependencies, previews: dependencies.previews?.() };
  const webSocketServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_TERMINAL_MESSAGE_BYTES
  });
  const server = createServer((request, response) => {
    void handleHttpRequest(
      request,
      response,
      store,
      httpDependencies,
      token,
      now
    ).catch(() => {
      if (!response.headersSent) setSecurityHeaders(response);
      if (!response.writableEnded) {
        sendJson(response, 500, { error: "Unable to process Yui web request." }, false);
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void handleTerminalUpgrade(
      request,
      socket,
      head,
      webSocketServer,
      dependencies.terminal,
      token
    );
  });
  let terminalsClosed = false;
  const closeTerminals = () => {
    if (terminalsClosed) return;
    terminalsClosed = true;
    for (const socket of webSocketServer.clients) socket.terminate();
    webSocketServer.close();
  };
  server.on("close", closeTerminals);
  return Object.assign(server, { closeTerminals });
}

export async function startYuiWebServer(
  store: WebDashboardStore,
  options: WebServerOptions,
  dependencies: WebServerDependencies = {}
): Promise<YuiWebServer> {
  const server = createYuiWebServer(store, dependencies);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: WebDashboardStore,
  dependencies: Omit<WebServerDependencies, "previews"> & Readonly<{
    previews?: ReturnType<typeof createTaskPreviews>;
  }>,
  token: string,
  now: () => Date
): Promise<void> {
  setSecurityHeaders(response);
  const method = request.method ?? "GET";
  if (!isLoopbackHost(headerValue(request, "host"))) {
    sendJson(response, 403, { error: "Invalid Host.", disposition: "not-submitted" }, method === "HEAD");
    return;
  }
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    sendJson(response, 400, { error: "Invalid URL.", disposition: "not-submitted" }, method === "HEAD");
    return;
  }

  // The loopback page token is the actual user ingress. A request body cannot
  // select Operator/Leader authority; all API reads use this boundary too.
  if (pathname.startsWith("/api/") && !tokenMatches(headerValue(request, "x-yui-web-token"), token)) {
    sendJson(response, 403, { error: "Invalid Yui web token.", disposition: "not-submitted" }, method === "HEAD");
    return;
  }
  if (pathname.startsWith("/preview/") && dependencies.previews) {
    await dependencies.previews.serve(request, response);
    return;
  }
  const previewMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/previews(?:\/([A-Za-z0-9_-]+)\/stop)?$/.exec(pathname);
  if (previewMatch && dependencies.previews) {
    try {
      if (method === "GET" && !previewMatch[2]) {
        sendJson(response, 200, await dependencies.previews.list(previewMatch[1]!), false);
      } else if (method === "POST" && previewMatch[2]) {
        const body = await readMutationBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
          throw new WebRequestRejected("Stop accepts an empty object; the URL selects the exact service.");
        }
        sendJson(response, 200, dependencies.previews.stop(previewMatch[1]!, previewMatch[2]), false);
      } else sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
    } catch (error) {
      sendJson(response, error instanceof WebRequestRejected ? 409 : 500, {
        error: error instanceof Error ? error.message : "Preview request failed.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown"
      }, false);
    }
    return;
  }
  if ((pathname === "/api/tasks" || pathname === "/api/projects") && dependencies.surface) {
    try {
      if (pathname === "/api/projects" && method === "GET") {
        const query = new URL(request.url!, "http://localhost").searchParams;
        if ([...query.keys()].some(key => key !== "after") || query.getAll("after").length > 1) {
          throw new WebRequestRejected("Project listing accepts only one after cursor.");
        }
        sendJson(response, 200, dependencies.surface.projects(query.get("after") ?? undefined), false);
      } else if (pathname === "/api/tasks" && method === "POST") {
        const body = await readMutationBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(key => !["title", "requirements", "projectIds", "plan", "requestId"].includes(key))
          || !("title" in body) || typeof body.title !== "string" || !body.title.trim() || body.title.length > 200
          || !("requirements" in body) || typeof body.requirements !== "string" || !body.requirements.trim()
          || !("projectIds" in body) || !Array.isArray(body.projectIds) || body.projectIds.length > 32
          || body.projectIds.some(id => typeof id !== "string" || !/^project-[a-zA-Z0-9_-]+$/.test(id))
          || !("plan" in body) || typeof body.plan !== "boolean"
          || !("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()) {
          throw new WebRequestRejected("Expected title, requirements, projectIds, plan and requestId only.");
        }
        sendJson(response, 200, { ...dependencies.surface.create(body as {
          title: string; requirements: string; projectIds: string[]; plan: boolean; requestId: string
        }), requestId: body.requestId }, false);
      } else sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Creation unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }
  if (pathname === "/api/settings" || pathname === "/api/settings/group" || pathname === "/api/settings/capabilities") {
    try {
      if (!dependencies.settings) throw new WebRequestRejected("Settings service unavailable.");
      const query = new URL(request.url!, "http://localhost").searchParams;
      if ([...query.keys()].some(k => !["id", "refresh", "q", "cursor"].includes(k))) throw new WebRequestRejected("Unknown settings query.");
      let value: unknown;
      if (method === "GET" && pathname === "/api/settings") value = dependencies.settings.index(query.get("q") ?? "", query.get("cursor") ?? "0");
      else if (method === "GET" && pathname === "/api/settings/group") value = dependencies.settings.read(query.get("id") ?? "");
      else if (method === "GET" && pathname === "/api/settings/capabilities") value = await dependencies.settings.capabilities(query.get("id") ?? "", query.get("refresh") === "true");
      else if (method === "POST" && pathname === "/api/settings/group") value = await dependencies.settings.save(await readMutationBody(request));
      else {
        sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
        return;
      }
      sendJson(response, 200, value, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Settings unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }
  const artifactTarget = /^\/api\/tasks\/([^/]+)\/(artifacts|evidence)$/.exec(pathname);
  if (["/api/conversation", "/api/conversation/material", "/api/conversation/model"].includes(pathname) && dependencies.conversation) {
    try {
      const q = new URL(request.url!, "http://localhost").searchParams;
      if ([...q.keys()].some(k => !["scope", "task", "role", "session", "cursor", "offset", "requestId"].includes(k))) {
        throw new WebRequestRejected("Unknown conversation parameter.");
      }
      const roleName = safeIdentity(q.get("role"), "Role");
      const owner: RoleSessionOwner = q.get("scope") === "task"
        ? { scope: "task", taskId: safeIdentity(q.get("task"), "Task"), roleName }
        : q.get("scope") === "global" && !q.has("task") ? { scope: "global", roleName }
          : (() => { throw new WebRequestRejected("Invalid conversation scope."); })();
      let result: unknown;
      if (pathname.endsWith("/model")) {
        const id = safeIdentity(q.get("session"), "Session");
        if (method === "GET") result = await dependencies.conversation.models(owner, id);
        else if (method === "POST") {
          const body = await readMutationBody(request);
          if (!body || typeof body !== "object" || Array.isArray(body)
            || Object.keys(body).some(k => k !== "model")
            || typeof (body as Record<string, unknown>).model !== "string") {
            throw new WebRequestRejected("Expected one native model selection.");
          }
          result = await dependencies.conversation.setModel(owner, id, (body as { model: string }).model);
        } else throw new WebRequestRejected("Model access requires GET or POST.");
      } else if (pathname.endsWith("/material")) {
        if (method !== "POST") throw new WebRequestRejected("Material upload requires POST.");
        const body = await readMutationBody(request, 2 * 1024 * 1024);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(k => !["requestId", "name", "content"].includes(k))) {
          throw new WebRequestRejected("Expected material requestId, name and UTF-8 content only.");
        }
        const value = body as Record<string, unknown>;
        if (typeof value.requestId !== "string" || typeof value.name !== "string" || typeof value.content !== "string") {
          throw new WebRequestRejected("Invalid material fields.");
        }
        result = await dependencies.conversation.material(owner, safeIdentity(q.get("session"), "Session"),
          value as { requestId: string; name: string; content: string });
      } else if (method === "GET" && q.has("requestId")) {
        result = dependencies.conversation.receipt(owner, safeIdentity(q.get("requestId"), "Request"));
      } else if (method === "GET" && q.has("session")) {
        const cursor = q.get("cursor");
        if (cursor !== null && cursor.length > 16000) throw new WebRequestRejected("Cursor too large.");
        result = await dependencies.conversation.history(owner, safeIdentity(q.get("session"), "Session"), cursor ?? undefined);
      } else if (method === "GET") {
        const offset = q.get("offset") ?? "0";
        if (!/^\d{1,6}$/.test(offset)) throw new WebRequestRejected("Invalid session offset.");
        result = dependencies.conversation.state(owner, Number(offset));
      } else if (method === "POST") {
        const body = await readMutationBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(k => !["action", "requestId", "body", "expectedTarget", "materials", "nativeRequestId", "result"].includes(k))) {
          throw new WebRequestRejected("Invalid conversation input.");
        }
        const value = body as Record<string, unknown>;
        if (value.action === "native-respond") {
          if ((typeof value.nativeRequestId !== "string" && typeof value.nativeRequestId !== "number")
            || (typeof value.expectedTarget !== "string" && value.expectedTarget !== null)
            || !value.result || typeof value.result !== "object" || Array.isArray(value.result)) {
            throw new WebRequestRejected("Expected exact native request and Turn response.");
          }
          result = await dependencies.conversation.respond(owner, safeIdentity(q.get("session"), "Session"),
            value.nativeRequestId, value.expectedTarget, value.result as Record<string, unknown>);
          sendJson(response, 200, result, false);
          return;
        }
        if (!["queue", "steer", "interrupt"].includes(String(value.action))
          || typeof value.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
          || value.body !== undefined && typeof value.body !== "string"
          || value.expectedTarget !== undefined && typeof value.expectedTarget !== "string"
          || value.materials !== undefined && (!Array.isArray(value.materials) || value.materials.length > 8)) {
          throw new WebRequestRejected("Expected action, requestId, input and exact Turn.");
        }
        result = await dependencies.conversation.control(owner, safeIdentity(q.get("session"), "Session"),
          value as { action: "queue" | "steer" | "interrupt"; requestId: string; body?: string; expectedTarget?: string });
      } else {
        sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false); return;
      }
      sendJson(response, 200, result, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Conversation unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }
  if (artifactTarget && dependencies.surface) {
    if (method !== "GET") {
      sendJson(response, 405, { error: "Artifacts are read-only." }, false);
      return;
    }
    try {
      const taskId = decodeURIComponent(artifactTarget[1]!);
      const query = new URL(request.url!, "http://localhost").searchParams;
      if (artifactTarget[2] === "evidence") {
        if ([...query.keys()].length) throw new WebRequestRejected("Evidence read takes no additional parameters.");
        sendJson(response, 200, dependencies.surface.evidence(taskId), false);
        return;
      }
      if ([...query.keys()].some(key => !["path", "commit", "before", "offset"].includes(key) || query.getAll(key).length !== 1)) {
        throw new WebRequestRejected("Artifact read accepts path, fixed commits and offset only.");
      }
      const path = query.get("path");
      const commit = query.get("commit");
      const before = query.get("before");
      const offset = query.get("offset") ?? "0";
      if (!/^\d{1,9}$/u.test(offset)) throw new WebRequestRejected("Invalid artifact offset.");
      if (path !== null && commit === null || before !== null && path === null
        || Number(offset) > 0 && commit === null) throw new WebRequestRejected("Select a fixed commit for this read.");
      const result = path === null ? await dependencies.surface.artifacts(taskId, commit ?? undefined, Number(offset))
        : before === null ? await dependencies.surface.artifact(taskId, path, commit!, Number(offset))
        : await dependencies.surface.artifactDiff(taskId, path, commit!, before, Number(offset));
      sendJson(response, 200, result, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Artifact unavailable." }, false);
    }
    return;
  }
  const globalControl = /^\/api\/roles\/([^/]+)\/control$/.exec(pathname);
  if (globalControl && dependencies.surface) {
    try {
      const roleName = decodeURIComponent(globalControl[1]!);
      if (!/^[A-Za-z0-9_-]+$/.test(roleName)) throw new WebRequestRejected("Invalid Global Role.");
      if (method === "GET") {
        sendJson(response, 200, dependencies.surface.globalState(roleName), false);
      } else if (method === "POST") {
        const body = await readMutationBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some(key =>
            !["action", "requestId", "body", "expectedTarget", "thenMessage"].includes(key))) {
          throw new WebRequestRejected("Global input accepts only action, input and exact target fields.");
        }
        const input = body as Record<string, unknown>;
        const parsed = parseWebControlInput({ ...input,
          ...(input.action === "interrupt" ? { role: roleName }
            : input.action === "steer" ? { to: roleName } : {}) });
        sendJson(response, 200, {
          ...await dependencies.surface.globalControl(roleName, parsed), requestId: parsed.requestId
        }, false);
      } else sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Global input unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }
  const panelTarget = /^\/api\/tasks\/([^/]+)\/panels$/.exec(pathname);
  if (panelTarget && dependencies.panels) {
    try {
      const taskId = decodeURIComponent(panelTarget[1]);
      if (method === "GET") {
        sendJson(response, 200, { panels: dependencies.panels.list(taskId), observedAt: now().toISOString() }, false);
      } else if (method === "POST") {
        const body = await readMutationBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some((key) => !["ref","input"].includes(key))
          || !("ref" in body) || !("input" in body)) throw new WebRequestRejected("Expected panel ref and input.");
        const ref = body.ref as SurfaceContributionRef;
        if (!ref || typeof ref !== "object" || typeof ref.capability !== "string"
          || typeof ref.contractVersion !== "string" || !ref.provider
          || typeof ref.provider.id !== "string" || typeof ref.provider.generation !== "string") {
          throw new WebRequestRejected("Invalid panel reference.");
        }
        const result = await dependencies.panels.read(taskId, ref, body.input);
        sendJson(response, 200, { result, observedAt: now().toISOString() }, false);
      } else sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Panel unavailable.",
        disposition: "not-submitted" }, false);
    }
    return;
  }
  const surfaceTarget = /^\/api\/tasks\/([^/]+)\/(workbench|context|delta|inspect|list|metadata|messages|control|activate|archive)$/.exec(pathname);
  if (surfaceTarget && dependencies.surface) {
    try {
      let taskId: string;
      try { taskId = decodeURIComponent(surfaceTarget[1]); }
      catch { throw new WebRequestRejected("Invalid Task URL encoding."); }
      const action = surfaceTarget[2];
      const query = new URL(request.url!, "http://localhost").searchParams;
      let value: unknown;
      if (method === "POST" && (action === "activate" || action === "archive")) {
        const body = await readMutationBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(key => key !== "requestId")
          || !("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()) {
          throw new WebRequestRejected("Expected requestId only.");
        }
        value = { requestId: body.requestId, result: action === "activate"
          ? dependencies.surface.activate(taskId, body.requestId)
          : await dependencies.surface.archive(taskId) };
      } else if (method === "GET" && action === "workbench") {
        value = dependencies.surface.workbench(taskId);
      } else if (method === "GET" && action === "context") {
        value = await dependencies.surface.read(taskId);
      } else if (method === "GET" && action === "delta") {
        value = dependencies.surface.delta(taskId, {
          after: query.get("after") ?? "",
          ...(query.has("continuation") ? { continuation: query.get("continuation")! } : {})
        });
      } else if (method === "GET" && action === "inspect") {
        value = dependencies.surface.inspect(taskId, {
          store: query.get("store") ?? "", refId: query.get("ref") ?? "",
          ...(query.has("digest") ? { digest: query.get("digest")! } : {}),
          ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {})
        });
      } else if (method === "GET" && action === "list") {
        const limit = query.get("limit");
        if (limit !== null && !/^\d{1,3}$/u.test(limit)) throw new WebRequestRejected("Invalid list limit.");
        value = dependencies.surface.list(taskId, {
          store: query.get("store") ?? "",
          ...(query.has("status") ? { status: query.get("status")! } : {}),
          ...(query.has("cursor") ? { cursor: query.get("cursor")! } : {}),
          ...(limit === null ? {} : { limit: Number(limit) })
        });
      } else if (method === "POST" && action === "messages") {
        const body = await readMutationBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !["body", "requestId", "intent"].includes(key))
          || !("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()
          || !("body" in body) || typeof body.body !== "string") throw new WebRequestRejected("Expected body, requestId and optional intent.");
        const intent = webSubmissionIntent(body);
        // requestId is threaded as the submission key (§2.3) and echoed back on the receipt.
        value = { ...dependencies.surface.message(taskId, body.body, intent, body.requestId), requestId: body.requestId };
      } else if (method === "POST" && action === "control") {
        const body = await readMutationBody(request);
        value = { ...await dependencies.surface.control(taskId, parseWebControlInput(body)), requestId: parseWebControlRequestId(body) };
      } else if (method === "POST" && action === "metadata") {
        const body = await readMutationBody(request);
        if (typeof body !== "object" || body === null || Array.isArray(body)
          || Object.keys(body).some((key) => !["patch", "requestId"].includes(key))
          || !("requestId" in body) || typeof body.requestId !== "string" || !body.requestId.trim()
          || !("patch" in body)) throw new WebRequestRejected("Expected patch and requestId only.");
        value = { ...dependencies.surface.update(taskId, body.patch), requestId: body.requestId };
      } else {
        sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, false);
        return;
      }
      sendJson(response, 200, value, false);
    } catch (error) {
      sendJson(response, 409, { error: error instanceof Error ? error.message : "Surface unavailable.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown" }, false);
    }
    return;
  }

  if (method === "GET" || method === "HEAD") {
    try {
      const asset = findWebAsset(pathname);
      if (pathname === "/" || pathname === "/index.html" || pathname === "/settings") {
        sendText(
          response,
          200,
          "text/html; charset=utf-8",
          pathname === "/settings" ? SETTINGS_HTML.replace("__YUI_WEB_TOKEN__", token) : dashboardHtml(token),
          method === "HEAD"
        );
      } else if (asset !== null) {
        sendAsset(response, asset, method === "HEAD");
      } else if (pathname === "/api/search") {
        const query = new URL(request.url!, "http://localhost").searchParams;
        if (query.getAll("query").length !== 1) throw usageError("Search requires one query.");
        const options = parseTaskSearchOptions([query.get("query")!,
          ...[...query].filter(([key]) => key !== "query").flatMap(([key, value]) => [`--${key}`, value])]);
        sendJson(response, 200, store.transaction(reader => searchTaskBodies(reader, options)), method === "HEAD");
      } else if (pathname === "/api/dashboard" || pathname === "/api/dashboard/sessions") {
        const query = new URL(request.url!, "http://localhost").searchParams;
        const options = parseTaskCatalogOptions(
          [...query].flatMap(([key, value]) => key === "all"
            ? (value === "true" ? ["--all"] : ["--invalid-all"])
            : [`--${key}`, value]));
        const snapshot = pathname.endsWith("/sessions")
          ? buildWebPageSessions(store, options, now())
          : buildWebTaskCatalog(store, options);
        sendJson(response, 200, snapshot, method === "HEAD");
      } else if (/^\/api\/tasks\/[^/]+\/usage$/u.test(pathname)) {
        const taskId = decodeURIComponent(pathname.split("/")[3]!);
        const query = new URL(request.url!, "http://localhost").searchParams;
        const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit") ?? 0);
        if ([...query.keys()].some(key => key !== "offset" && key !== "limit")
          || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > 50) {
          throw usageError("Usage requires offset >= 0 and limit 0..50.");
        }
        const value = store.readTransaction(reader => readTaskUsage(reader, taskId, { offset, limit, now: now() }));
        sendJson(response, value === null ? 404 : 200, value ?? { error: "Task not found." }, method === "HEAD");
      } else if (pathname.startsWith("/api/tasks/")) {
        const taskId = decodeURIComponent(pathname.slice("/api/tasks/".length));
        const detail = taskId.length === 0 || taskId.includes("/")
          ? null
          : buildWebTaskDetail(store, taskId, now(), new URL(request.url!, "http://localhost").searchParams.get("compact") === "true");
        sendJson(
          response,
          detail === null ? 404 : 200,
          detail ?? { error: "Task not found." },
          method === "HEAD"
        );
      } else {
        sendJson(response, 404, { error: "Not found." }, method === "HEAD");
      }
    } catch (error) {
      if (error instanceof CliError) {
        sendJson(response, 400, { error: error.message }, method === "HEAD");
        return;
      }
      if (error instanceof URIError) {
        sendJson(response, 400, { error: "Invalid URL encoding." }, method === "HEAD");
        return;
      }
      sendJson(response, 500, { error: "Unable to read Yui state." }, method === "HEAD");
    }
    return;
  }

  const answerTarget = parseAnswerPath(pathname);
  if (method === "POST" && answerTarget !== null && dependencies.answerInput !== undefined) {
    if (!tokenMatches(headerValue(request, "x-yui-web-token"), token)) {
      sendJson(response, 403, { error: "Invalid Yui web token." }, false);
      return;
    }
    let answer: WebInputAnswer;
    try {
      answer = parseWebInputAnswer(await readJsonBody(request));
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Invalid input answer.", disposition: "not-submitted"
      }, false);
      return;
    }
    try {
      const answered = await dependencies.answerInput({
        ...answerTarget,
        answer
      });
      sendJson(response, 200, { request: answered }, false);
    } catch (error) {
      sendJson(response, 409, {
        error: error instanceof Error ? error.message : "Unable to answer input request.",
        disposition: error instanceof WebRequestRejected ? "not-submitted" : "unknown"
      }, false);
    }
    return;
  }

  response.setHeader("allow", "GET, HEAD");
  sendJson(response, 405, { error: "Method not allowed.", disposition: "not-submitted" }, method === "HEAD");
}

async function handleTerminalUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  webSocketServer: WebSocketServer,
  terminalPort: WebServerDependencies["terminal"],
  token: string
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isLoopbackHost(headerValue(request, "host"))) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (url.pathname !== "/api/terminal" || terminalPort === undefined) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!tokenMatches(url.searchParams.get("token") ?? undefined, token)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const origin = headerValue(request, "origin");
    const host = headerValue(request, "host");
    if (origin === undefined || host === undefined || origin !== `http://${host}`) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const terminalRequest = parseTerminalRequest(url.searchParams);
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      void connectTerminal(webSocket, terminalPort, terminalRequest);
    });
  } catch {
    rejectUpgrade(socket, 400, "Bad Request");
  }
}

async function connectTerminal(
  webSocket: WebSocket,
  terminalPort: NonNullable<WebServerDependencies["terminal"]>,
  request: WebTerminalRequest
): Promise<void> {
  let disconnected = false;
  const markDisconnected = () => {
    disconnected = true;
  };
  webSocket.once("close", markDisconnected);
  webSocket.once("error", markDisconnected);

  let connection: WebTerminalConnection;
  try {
    connection = await terminalPort.open(request);
  } catch (error) {
    if (!disconnected) {
      sendWebSocket(webSocket, {
        type: "error",
        message: error instanceof Error ? error.message : "Unable to open terminal."
      });
      webSocket.close(1011, "Unable to open terminal");
    }
    return;
  }
  webSocket.off("close", markDisconnected);
  webSocket.off("error", markDisconnected);
  if (disconnected || webSocket.readyState !== WebSocket.OPEN) {
    connection.close();
    return;
  }

  let closed = false;
  let stopData = () => {};
  let stopExit = () => {};
  const close = () => {
    if (closed) return;
    closed = true;
    stopData();
    stopExit();
    connection.close();
  };
  webSocket.once("close", close);
  webSocket.once("error", close);
  stopData = connection.onData((data) => {
    if (webSocket.bufferedAmount > MAX_TERMINAL_BUFFERED_BYTES) {
      webSocket.close(1013, "Terminal client is too slow");
      return;
    }
    sendWebSocket(webSocket, { type: "data", data });
  });
  if (closed) {
    stopData();
    return;
  }
  stopExit = connection.onExit((exit) => {
    sendWebSocket(webSocket, { type: "exit", ...exit });
    webSocket.close(1000, "Terminal detached");
    close();
  });
  if (closed) {
    stopExit();
    return;
  }
  webSocket.on("message", (payload, binary) => {
    if (binary) {
      webSocket.close(1003, "Invalid terminal message");
      return;
    }
    try {
      const message = parseTerminalClientMessage(String(payload));
      if (message.type === "resize") {
        connection.resize(message.columns, message.rows);
      } else if (!connection.readOnly) {
        connection.write(message.data);
      }
    } catch {
      webSocket.close(1003, "Invalid terminal message");
    }
  });
  sendWebSocket(webSocket, {
    type: "ready",
    readOnly: connection.readOnly,
    ...(connection.history === undefined ? {} : { history: connection.history })
  });
}

function parseTerminalRequest(parameters: URLSearchParams): WebTerminalRequest {
  const scope = parameters.get("scope");
  const roleName = safeIdentity(parameters.get("role"), "Role");
  const columns = boundedInteger(parameters.get("cols"), 20, 400, "Terminal columns");
  const rows = boundedInteger(parameters.get("rows"), 5, 200, "Terminal rows");
  const selection = parameters.has("session")
    ? { nativeSessionId: safeIdentity(parameters.get("session"), "Session") } : {};
  if (scope === "global") {
    if (parameters.has("task")) throw new Error("Global terminal cannot include a Task.");
    return { scope, roleName, columns, rows, ...selection };
  }
  if (scope === "task") {
    return {
      scope,
      taskId: safeIdentity(parameters.get("task"), "Task"),
      roleName,
      columns,
      rows,
      ...selection
    };
  }
  throw new Error("Terminal scope is invalid.");
}

type TerminalClientMessage =
  | Readonly<{ type: "input"; data: string }>
  | Readonly<{ type: "resize"; columns: number; rows: number }>;

function parseTerminalClientMessage(value: string): TerminalClientMessage {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Terminal message must be an object.");
  }
  const message = parsed as Record<string, unknown>;
  if (message.type === "input"
    && Object.keys(message).length === 2
    && typeof message.data === "string"
    && Buffer.byteLength(message.data) <= MAX_TERMINAL_MESSAGE_BYTES) {
    return { type: "input", data: message.data };
  }
  if (message.type === "resize"
    && Object.keys(message).length === 3
    && Number.isInteger(message.columns)
    && Number.isInteger(message.rows)) {
    return {
      type: "resize",
      columns: boundedInteger(String(message.columns), 20, 400, "Terminal columns"),
      rows: boundedInteger(String(message.rows), 5, 200, "Terminal rows")
    };
  }
  throw new Error("Terminal message is invalid.");
}

function parseAnswerPath(pathname: string): Readonly<{
  taskId: string;
  inputId: string;
}> | null {
  const match = /^\/api\/tasks\/([^/]+)\/inputs\/([^/]+)\/answer$/u.exec(pathname);
  if (match === null) return null;
  try {
    return {
      taskId: safeIdentity(decodeURIComponent(match[1]), "Task"),
      inputId: safeIdentity(decodeURIComponent(match[2]), "Input request")
    };
  } catch {
    return null;
  }
}

/** The three-action control body is validated to the exact CLI-equivalent
 * shape before it reaches the surface, so an unknown or malformed field is a
 * visible not-submitted rejection rather than a silent default. `requestId` is
 * the caller-supplied idempotency key common to all three actions. */
function parseWebControlRequestId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebRequestRejected("Control input must be an object.");
  }
  const requestId = (value as Record<string, unknown>).requestId;
  if (typeof requestId !== "string" || !requestId.trim()) {
    throw new WebRequestRejected("A non-empty requestId is required.");
  }
  return requestId;
}

function requiredControlString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WebRequestRejected(`${key} is required.`);
  }
  return value;
}

function optionalControlString(input: Record<string, unknown>, key: string): string | undefined {
  if (!(key in input) || input[key] === undefined) return undefined;
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new WebRequestRejected(`${key} must be a non-empty string when provided.`);
  }
  return value;
}

function parseWebControlInput(value: unknown): WebControlInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WebRequestRejected("Control input must be an object.");
  }
  const input = value as Record<string, unknown>;
  const action = input.action;
  if (action === "queue") {
    for (const key of Object.keys(input)) {
      if (!["action", "body", "requestId", "to", "workItem", "reviewRound"].includes(key)) {
        throw new WebRequestRejected(`Unexpected field for queue: ${key}.`);
      }
    }
    if (input.workItem !== undefined && input.reviewRound !== undefined) {
      throw new WebRequestRejected("A queue takes at most one of workItem or reviewRound.");
    }
    return { action: "queue", body: requiredControlString(input, "body"),
      requestId: requiredControlString(input, "requestId"),
      ...(optionalControlString(input, "to") === undefined ? {} : { to: optionalControlString(input, "to") }),
      ...(optionalControlString(input, "workItem") === undefined ? {} : { workItem: optionalControlString(input, "workItem") }),
      ...(optionalControlString(input, "reviewRound") === undefined ? {} : { reviewRound: optionalControlString(input, "reviewRound") }) };
  }
  if (action === "steer") {
    for (const key of Object.keys(input)) {
      if (!["action", "body", "requestId", "expectedTarget", "to", "workItem", "reviewRound"].includes(key)) {
        throw new WebRequestRejected(`Unexpected field for steer: ${key}.`);
      }
    }
    if (input.workItem !== undefined && input.reviewRound !== undefined) {
      throw new WebRequestRejected("A steer takes at most one of workItem or reviewRound.");
    }
    return { action: "steer", body: requiredControlString(input, "body"),
      requestId: requiredControlString(input, "requestId"),
      expectedTarget: requiredControlString(input, "expectedTarget"),
      to: requiredControlString(input, "to"),
      ...(optionalControlString(input, "workItem") === undefined ? {} : { workItem: optionalControlString(input, "workItem") }),
      ...(optionalControlString(input, "reviewRound") === undefined ? {} : { reviewRound: optionalControlString(input, "reviewRound") }) };
  }
  if (action === "interrupt") {
    for (const key of Object.keys(input)) {
      if (!["action", "requestId", "expectedTarget", "role", "thenMessage"].includes(key)) {
        throw new WebRequestRejected(`Unexpected field for interrupt: ${key}.`);
      }
    }
    return { action: "interrupt", requestId: requiredControlString(input, "requestId"),
      expectedTarget: requiredControlString(input, "expectedTarget"),
      role: requiredControlString(input, "role"),
      ...(optionalControlString(input, "thenMessage") === undefined ? {} : { thenMessage: optionalControlString(input, "thenMessage") }) };
  }
  throw new WebRequestRejected("action must be one of queue, steer, or interrupt.");
}

function parseWebInputAnswer(value: unknown): WebInputAnswer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Input answer must be an object.");
  }
  const answer = value as Record<string, unknown>;
  if (Object.keys(answer).length !== 1) {
    throw new Error("Exactly one of choiceKey or text is required.");
  }
  if (typeof answer.choiceKey === "string" && answer.choiceKey.trim().length > 0) {
    return { choiceKey: answer.choiceKey.trim() };
  }
  if (typeof answer.text === "string" && answer.text.trim().length > 0) {
    return { text: answer.text.trim() };
  }
  throw new Error("Exactly one non-empty choiceKey or text is required.");
}

async function readMutationBody(request: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  try { return await readJsonBody(request, limit); }
  catch (error) { throw new WebRequestRejected(error instanceof Error ? error.message : "Invalid request body."); }
}

/** Validate an optional submission intent from a Web message body. Absent leaves
 *  it undefined so the shared service applies the discuss default (task-32 §2.5).
 *  A present-but-invalid value is rejected rather than silently downgraded. */
function webSubmissionIntent(body: Record<string, unknown>): TaskSubmissionIntent | undefined {
  if (!("intent" in body) || body.intent === undefined) return undefined;
  if (typeof body.intent === "string"
    && (TASK_SUBMISSION_INTENTS as readonly string[]).includes(body.intent)) {
    return body.intent as TaskSubmissionIntent;
  }
  throw new WebRequestRejected(`intent must be one of ${TASK_SUBMISSION_INTENTS.join(", ")}.`);
}

async function readJsonBody(request: IncomingMessage, limit = MAX_JSON_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (size === 0) throw new Error("Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown, head: boolean): void {
  sendText(response, status, "application/json; charset=utf-8", JSON.stringify(value), head);
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  head: boolean
): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(head ? undefined : body);
}

function sendAsset(response: ServerResponse, asset: WebAsset, head: boolean): void {
  const payload = asset.encoding === "base64"
    ? Buffer.from(asset.body, "base64")
    : Buffer.from(asset.body, "utf-8");
  if (asset.contentType.startsWith("font/") || asset.contentType.startsWith("image/")) {
    response.setHeader("cache-control", "public, max-age=31536000, immutable");
  }
  response.statusCode = 200;
  response.setHeader("content-type", asset.contentType);
  response.setHeader("content-length", payload.length);
  response.end(head ? undefined : payload);
}

function sendWebSocket(webSocket: WebSocket, value: unknown): void {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(JSON.stringify(value));
  }
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n`
    + "Connection: close\r\n"
    + "Content-Length: 0\r\n\r\n"
  );
}

function dashboardHtml(token: string): string {
  return DASHBOARD_HTML.replace(
    'content="__YUI_WEB_TOKEN__"',
    `content="${escapeHtmlAttribute(token)}"`
  );
}

function tokenMatches(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function isLoopbackHost(value: string | undefined): boolean {
  if (value === undefined) return false;
  let url: URL;
  try {
    url = new URL(`http://${value}`);
  } catch {
    return false;
  }
  if (
    url.username.length > 0
    || url.password.length > 0
    || url.pathname !== "/"
    || url.search.length > 0
    || url.hash.length > 0
  ) {
    return false;
  }
  const hostname = url.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function safeIdentity(value: string | null, label: string): string {
  if (value === null || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundedInteger(
  value: string | null,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (value === null || !/^[0-9]+$/u.test(value)) throw new Error(`${label} is invalid.`);
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function webUsageError(): Error {
  return usageError("Web usage: yui web [--host <loopback>] [--port <port>].", webUsage());
}

function webUsage(): string {
  return "Usage: yui web [--host <127.0.0.1|::1|localhost>] [--port <1-65535>]";
}
