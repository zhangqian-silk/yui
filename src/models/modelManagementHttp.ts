import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { modelUrl } from "./modelManagementConfig.js";

const denied = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) denied.addSubnet(address, bits, "ipv4");
for (const [address, bits] of [["::", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["::ffff:0:0", 96]] as const) {
  denied.addSubnet(address, bits, "ipv6");
}

/** Small fixed-route client: pinned DNS, no redirects/proxies, deadline and byte cap. */
export async function readModelJson(base: string, suffix: string, key: string, timeoutMs: number): Promise<unknown> {
  const url = modelUrl(`${base.replace(/\/+$/, "")}${suffix}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const explicitLoopback = ["127.0.0.1", "::1", "localhost"].includes(hostname);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const addresses = await Promise.race([
      isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }))
    ]);
    if (abort.signal.aborted || !addresses.length || addresses.some(({ address, family }) => {
      const loopback = address === "::1" || address.startsWith("127.");
      return (loopback && !explicitLoopback) || (!loopback && explicitLoopback)
        || (!loopback && denied.check(address, family === 6 ? "ipv6" : "ipv4"));
    })) throw new Error("target-rejected");
    const selected = addresses[0]!;
    return await new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", signal: abort.signal, agent: false,
        headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        lookup: (_name, _options, callback) => callback(null, selected.address, selected.family)
      }, response => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(response.statusCode === 401 || response.statusCode === 403 ? "authentication-failed"
            : response.statusCode === 404 ? "route-unavailable" : "service-failed"));
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { response.destroy(); reject(new Error("response-too-large")); }
          else chunks.push(chunk);
        });
        response.on("error", () => reject(new Error("read-failed")));
        response.on("end", () => {
          try {
            // Even schema-allowed upstream strings must not echo our credential.
            const text = Buffer.concat(chunks).toString("utf8");
            const parsed: unknown = JSON.parse(text);
            resolve(key ? redact(parsed, key) : parsed);
          } catch { reject(new Error("invalid-response")); }
        });
      });
      request.on("error", () => reject(new Error(abort.signal.aborted ? "timeout" : "connection-failed")));
      request.end();
    });
  } finally { clearTimeout(timer); }
}

function redact(value: unknown, key: string): unknown {
  if (typeof value === "string") return value.split(key).join("[redacted]");
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .map(([name, item]) => [name.split(key).join("[redacted]"), redact(item, key)]));
  return value;
}
