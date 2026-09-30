import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";

import { isControllerSocketPathForHome } from "./controllerEndpoint.js";
import {
  findLiveControllerProcessForHome,
  inspectLiveControllerProcess
} from "./controllerProcessIdentity.js";
import { readHomeFilesystemId } from "./homeFilesystemIdentity.js";
import {
  CONTROLLER_DISCOVERY_PATH,
  ControllerProtocolError,
  encodeControllerRequest,
  FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
  MAX_CONTROLLER_MESSAGE_BYTES,
  parseControllerDiscovery,
  parseControllerResponse,
  type ControllerDiscovery,
  type JsonValue
} from "./protocol.js";

export class ControllerClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    cause?: unknown,
    readonly diagnostic?: Readonly<{
      delivery: "not-sent" | "unconfirmed" | "response-received";
      method?: string;
      requestId?: string;
      socketPath?: string;
    }>
  ) {
    super(message, { cause });
    this.name = "ControllerClientError";
  }
}

/** The Controller may have committed the request before this client lost its acknowledgement. */
export function controllerCallMayHaveApplied(error: unknown): boolean {
  return error instanceof ControllerClientError
    && [
      "CONTROLLER_TIMEOUT",
      "CONTROLLER_UNAVAILABLE",
      // Raised only after the request write began, so the Controller may well
      // have committed it. Omitting it reported a genuinely unknown outcome as
      // a definite failure, which is the one classification callers must not
      // make: it invites treating possibly-applied work as never applied.
      "CONTROLLER_DELIVERY_UNKNOWN",
      "INVALID_RESPONSE"
    ].includes(error.code);
}

export type ControllerCallOptions = Readonly<{
  timeoutMs?: number;
  id?: string;
}>;

export async function readControllerDiscovery(home: string): Promise<ControllerDiscovery> {
  const discoveryPath = join(home, CONTROLLER_DISCOVERY_PATH);
  try {
    const metadata = await lstat(discoveryPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isFile()) throw invalidDiscovery(new Error("Discovery path is not a regular file."));
    if ((metadata.mode & 0o077) !== 0) throw invalidDiscovery(new Error("Discovery record permissions are not owner-only."));
    if (metadata.size > 4_096) throw invalidDiscovery(new Error("Discovery record exceeds the 4096-byte limit."));
    if (uid !== undefined && metadata.uid !== uid) throw invalidDiscovery(new Error("Discovery record belongs to a different user."));
    const value: unknown = JSON.parse(await readFile(discoveryPath, "utf8"));
    const socketPath = discoverySocketPath(value);
    return parseControllerDiscovery(value, {
      homeFilesystemId: readHomeFilesystemId(home),
      socketPath
    });
  } catch (error) {
    if (error instanceof ControllerClientError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new ControllerClientError(
        "CONTROLLER_NOT_RUNNING",
        withOriginalError("Controller discovery record is missing; process state is unverified.", error),
        error,
        { delivery: "not-sent" }
      );
    }
    if (isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES")) {
      throw controllerAccessDenied(error, "discovery record");
    }
    throw invalidDiscovery(error);
  }
}

function discoverySocketPath(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidDiscovery();
  }
  const homeId = Reflect.get(value, "homeId");
  const socketPath = Reflect.get(value, "socketPath");
  if (
    typeof homeId !== "string"
    || typeof socketPath !== "string"
    || !isControllerSocketPathForHome(homeId, socketPath)
  ) {
    throw invalidDiscovery();
  }
  return socketPath;
}

export async function callController(
  home: string,
  method: string,
  params: JsonValue = {},
  options: ControllerCallOptions = {}
): Promise<JsonValue> {
  const id = options.id ?? randomUUID();
  let discovery: ControllerDiscovery;
  try {
    discovery = await readControllerDiscovery(home);
  } catch (error) {
    if (!(error instanceof ControllerClientError)) throw error;
    throw new ControllerClientError(error.code, error.message, error.cause, {
      delivery: "not-sent", method, requestId: id
    });
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Controller timeout must be a positive integer.");
  }
  let requestLine: string;
  try {
    requestLine = encodeControllerRequest({
      id,
      token: discovery.token,
      protocolVersion: FILE_TASK_CONTROLLER_PROTOCOL_VERSION,
      homeId: discovery.homeId,
      homeFilesystemId: discovery.homeFilesystemId,
      controllerInstanceId: discovery.controllerInstanceId,
      method,
      params
    });
  } catch (error) {
    if (error instanceof ControllerProtocolError) {
      throw new ControllerClientError(error.code, error.message, error, {
        delivery: "not-sent", method, requestId: id
      });
    }
    throw new ControllerClientError(
      "INVALID_REQUEST",
      withOriginalError("Invalid controller request.", error),
      error,
      { delivery: "not-sent", method, requestId: id }
    );
  }
  return exchange(discovery.socketPath, requestLine, id, timeoutMs, method);
}

/**
 * Explicit restart recovery for an exact Controller whose discovery record
 * was lost. The signal is fenced by same UID, controller entrypoint, physical
 * Home identity, PID, and process-start identity; an unprovable process is
 * never touched.
 */
export async function stopOrphanedFileTaskController(
  home: string,
  timeoutMs: number,
  options: Readonly<{ force?: boolean; expectedPid?: number; expectedProcessStartIdentity?: string }> = {}
): Promise<Readonly<{ pid: number }> | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Controller timeout must be a positive integer.");
  }
  const homeFilesystemId = readHomeFilesystemId(home);
  const candidate = findLiveControllerProcessForHome(homeFilesystemId);
  if (candidate === undefined) return undefined;
  if ((options.expectedPid !== undefined && candidate.pid !== options.expectedPid)
    || (options.expectedProcessStartIdentity !== undefined
      && candidate.processStartIdentity !== options.expectedProcessStartIdentity)) {
    throw new Error("Controller ownership changed before physical recovery.");
  }
  if (
    inspectLiveControllerProcess(
      candidate.pid,
      homeFilesystemId,
      candidate.processStartIdentity
    ) === undefined
  ) return undefined;
  try {
    process.kill(candidate.pid, "SIGTERM");
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return undefined;
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  const forceAt = Date.now() + Math.min(1000, timeoutMs / 2);
  let forced = false;
  while (
    inspectLiveControllerProcess(
      candidate.pid,
      homeFilesystemId,
      candidate.processStartIdentity
    ) !== undefined
  ) {
    if (options.force && !forced && Date.now() >= forceAt) {
      // The loop revalidates UID, entrypoint, Home and process start identity
      // immediately before escalation. Never signal a successor Controller.
      try { process.kill(candidate.pid, "SIGKILL"); }
      catch (error) { if (!isNodeError(error) || error.code !== "ESRCH") throw error; }
      forced = true;
    }
    if (Date.now() >= deadline) {
      throw new ControllerClientError(
        "CONTROLLER_TIMEOUT",
        `Orphaned Controller did not stop within ${timeoutMs} ms.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Object.freeze({ pid: candidate.pid });
}

function exchange(
  socketPath: string,
  requestLine: string,
  expectedId: string,
  timeoutMs: number,
  method: string
): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    let deliveryStarted = false;
    const timer = setTimeout(() => {
      fail(new ControllerClientError(
        "CONTROLLER_TIMEOUT",
        "Controller request timed out."
      ));
    }, timeoutMs);

    const finish = (result: JsonValue): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const fail = (error: ControllerClientError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new ControllerClientError(error.code, error.message, error.cause, {
        delivery: error.diagnostic?.delivery ?? (deliveryStarted ? "unconfirmed" : "not-sent"),
        method,
        requestId: expectedId,
        socketPath
      }));
    };

    socket.on("connect", () => {
      // Once write begins, a missing response cannot prove that the Controller
      // did not commit the request. Callers must use their domain identity to
      // decide whether an explicit retry is safe.
      deliveryStarted = true;
      socket.write(requestLine);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_CONTROLLER_MESSAGE_BYTES) fail(invalidResponse());
        return;
      }
      if (newline > MAX_CONTROLLER_MESSAGE_BYTES || buffer.length !== newline + 1) {
        fail(invalidResponse());
        return;
      }
      try {
        const response = parseControllerResponse(
          buffer.subarray(0, newline).toString("utf8"),
          expectedId
        );
        if (response.ok) finish(response.result);
        else fail(new ControllerClientError(response.error.code, response.error.message, undefined, {
          delivery: "response-received"
        }));
      } catch (error) {
        fail(invalidResponse(error));
      }
    });
    socket.on("end", () => {
      if (!settled) fail(invalidResponse());
    });
    socket.on("error", (error: Error) => {
      fail(classifyControllerSocketError(error, deliveryStarted));
    });
  });
}

export function classifyControllerSocketError(error: unknown, deliveryStarted: boolean): ControllerClientError {
  if (deliveryStarted) {
    return new ControllerClientError(
      "CONTROLLER_DELIVERY_UNKNOWN",
      withOriginalError("Controller request delivery is unknown.", error),
      error,
      { delivery: "unconfirmed" }
    );
  }
  if (isNodeError(error) && (error.code === "EPERM" || error.code === "EACCES")) {
    return controllerAccessDenied(error, "socket");
  }
  return new ControllerClientError(
    "CONTROLLER_UNAVAILABLE",
    withOriginalError("Controller is unavailable.", error),
    error,
    { delivery: "not-sent" }
  );
}

function controllerAccessDenied(error: NodeJS.ErrnoException, target: string): ControllerClientError {
  return new ControllerClientError(
    "CONTROLLER_ACCESS_DENIED",
    `Controller ${target} access was denied (${error.code}) before any request was sent. `
      + "In Codex, request sandbox escalation to rerun the same Yui CLI command outside the sandbox "
      + `if authorized. If escalation is denied, report that to the user.${originalErrorDetail(error)}`,
    error,
    { delivery: "not-sent" }
  );
}

function invalidDiscovery(error?: unknown): ControllerClientError {
  return new ControllerClientError(
    "CONTROLLER_DISCOVERY_INVALID",
    error === undefined
      ? "Controller discovery is invalid."
      : withOriginalError("Controller discovery is invalid.", error),
    error,
    { delivery: "not-sent" }
  );
}

function invalidResponse(error?: unknown): ControllerClientError {
  return new ControllerClientError(
    "INVALID_RESPONSE",
    error === undefined
      ? "Controller response is invalid."
      : withOriginalError("Controller response is invalid.", error),
    error
  );
}

function withOriginalError(message: string, error: unknown): string {
  return `${message}${originalErrorDetail(error)}`;
}

function originalErrorDetail(error: unknown): string {
  const code = isNodeError(error) && typeof error.code === "string"
    ? ` (${error.code})`
    : "";
  return ` Original error${code}: ${error instanceof SyntaxError
    ? "Input could not be parsed; raw input omitted."
    : error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown cause."}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
