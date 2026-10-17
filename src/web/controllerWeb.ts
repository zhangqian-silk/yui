import type { JsonValue } from "../core/protocol.js";
import { parseWebCommandOptions, startYuiWebServer, type WebServerDependencies, type YuiWebServer } from "./webServer.js";
import type { TaskStore } from "../storage/taskStore.js";
import { parseDurableJobCaller } from "../controller/jobControl.js";
import { requireManagedGlobalCaller } from "../runtime/managedCaller.js";

export type WebListenerStatus = Readonly<{
  id: string; host: string; port: number; url: string | null;
  urls: string[]; authentication: "local" | "basic"; warnings: string[];
}>;

/** HTTP listener ownership only, alongside the Controller's one Kernel Host.
 * The authenticated Controller control socket starts/stops the exact listener;
 * no capability identity is accepted through this lifecycle API. */
export function createControllerWeb(store: TaskStore, dependencies: WebServerDependencies) {
  let current: { status: WebListenerStatus; server: YuiWebServer; authFile?: string } | undefined;
  let shutdown = false;
  let startup: Promise<YuiWebServer> | undefined;
  let closing: Promise<void> | undefined;
  const closeListener = async () => {
    if (closing) return closing;
    const owned = current;
    if (!owned) return;
    owned.server.closeTerminals();
    closing = new Promise<void>((resolve, reject) => {
      owned.server.close((error) => error ? reject(error) : resolve());
      owned.server.closeAllConnections();
    });
    try { await closing; current = undefined; }
    finally { closing = undefined; }
  };
  return {
    async close() {
      shutdown = true;
      // A Controller shutdown must also own a bind still in flight.
      if (startup) await startup.catch(() => undefined);
      await closeListener();
    },
    async dispatch(method: string, value: JsonValue): Promise<JsonValue> {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Web listener request.");
      const params = value as Readonly<Record<string, JsonValue>>;
      // The control socket proves the local Home/user boundary. Managed
      // callers additionally retain their current native identity; no Web
      // token or browser-user credential is issued by this API.
      const caller = parseDurableJobCaller(params.caller);
      if (caller.scope === "user") {
        if (Object.keys(caller).length !== 1) throw new Error("Invalid local Web caller.");
      } else {
        if (caller.scope !== "global" || caller.role !== "operator" || caller.taskId !== undefined || caller.runId !== undefined) {
          throw new Error("Only the current global Operator may manage Web listeners.");
        }
        requireManagedGlobalCaller(store, {
          YUI_SESSION_SCOPE: "global", YUI_ROLE: caller.role, YUI_AGENT_ID: caller.agentId,
          YUI_ADAPTER_ID: caller.adapterId, YUI_NATIVE_SESSION_ID: caller.nativeSessionId
        });
      }
      if (method === "web.status") {
        if (Object.keys(params).some(key => key !== "caller")) throw new Error("Web status takes no arguments.");
        return current ? { ...current.status, state: closing ? "stopping" : "running" }
          : startup ? { state: "starting" } : null;
      }
      if (method === "web.stop") {
        if (Object.keys(params).some((key) => !["id", "caller"].includes(key)) || typeof params.id !== "string") throw new Error("Expected Web listener id.");
        if (startup) throw new Error("Web listener is starting; query status before retrying.");
        if (!current) return { stopped: false };
        if (current.status.id !== params.id) throw new Error("Web listener identity changed.");
        await closeListener();
        return { stopped: true };
      }
      if (method !== "web.start" || Object.keys(params).some((key) => !["id","host","port","authFile","caller"].includes(key))
        || typeof params.id !== "string" || !params.id.trim()
        || typeof params.host !== "string" || typeof params.port !== "number"
        || (params.authFile !== undefined && typeof params.authFile !== "string")) {
        throw new Error("Expected id, host and port for Web start.");
      }
      const options = parseWebCommandOptions(["--host", params.host, "--port", String(params.port),
        ...(typeof params.authFile === "string" ? ["--auth-file", params.authFile] : [])]);
      if (shutdown) throw new Error("Controller Web lifecycle is shutting down.");
      if (startup || closing) throw new Error("Web listener lifecycle is busy; query status before retrying.");
      if (current) {
        if (current.status.host === options.host && current.status.port === options.port && current.authFile === options.authFile) {
          return { ...current.status, state: "running", alreadyRunning: true };
        }
        throw new Error("A different Web listener is already running. Inspect --status and explicitly --stop before changing its configuration.");
      }
      try {
        startup = startYuiWebServer(store, options, dependencies);
        const server = await startup;
        const { urls, authentication, warnings } = server.access;
        const status: WebListenerStatus = { id: params.id, host: options.host, port: options.port,
          url: urls[0] ?? null, urls, authentication, warnings };
        current = { status, server, authFile: options.authFile };
        if (shutdown) throw new Error("Controller shut down before Web startup completed.");
        return { ...status, state: "running", alreadyRunning: false };
      } finally { startup = undefined; }
    }
  };
}
