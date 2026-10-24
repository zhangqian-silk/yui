import { WebRequestRejected } from "../web/webMutation.js";

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
