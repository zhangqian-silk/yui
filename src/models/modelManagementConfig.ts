import { isAbsolute } from "node:path";
import { WebRequestRejected } from "../web/webMutation.js";
import type { ModelConnection } from "./modelManagementTypes.js";

export function modelObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebRequestRejected("Expected an object.");
  return value as Record<string, unknown>;
}

export function modelFields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new WebRequestRejected("Unknown Model management field.");
}

/** Configuration validation does not resolve DNS or contact a service. */
export function modelUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new WebRequestRejected("Expected an HTTP(S) service URL."); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (!loopback && url.protocol !== "https:") || value.length > 2048) {
    throw new WebRequestRejected("Use loopback HTTP or HTTPS without credentials, query or fragment.");
  }
  return url;
}

export function validateModelConnection(value: unknown): ModelConnection {
  const row = modelObject(value);
  const fields = ["bridgeUrl", "bridgeConfigFile", "cpaUrl", "managementKeyFile", "catalogKeyFile"] as const;
  modelFields(row, fields);
  for (const field of fields) {
    if (typeof row[field] !== "string" || (row[field] as string).length > 4096
      || /[\0\r\n]/.test(row[field] as string)) throw new WebRequestRejected("Invalid Model connection field.");
  }
  const result = row as ModelConnection;
  modelUrl(result.bridgeUrl);
  if (result.cpaUrl) modelUrl(result.cpaUrl);
  for (const field of ["bridgeConfigFile", "managementKeyFile", "catalogKeyFile"] as const) {
    if (result[field] && !isAbsolute(result[field])) throw new WebRequestRejected("Server file references must be absolute paths.");
  }
  return { ...result };
}
