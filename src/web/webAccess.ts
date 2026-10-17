import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";

export type WebAccessOptions = Readonly<{ host: string; port: number; authFile?: string }>;

export function isLoopbackAddress(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host) && isIP(host) === 4;
}

/** Only numeric private addresses are advertised/accepted for LAN access.
 * DNS aliases and proxy headers are deliberately not an authentication input. */
export function isPrivateAddress(host: string): boolean {
  return isIP(host) === 4
    ? /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)
    : isIP(host) === 6 && /^f[cd]/i.test(host);
}

export function validateWebAccessOptions(options: WebAccessOptions): void {
  if (!isLoopbackAddress(options.host) && !isPrivateAddress(options.host)
    && options.host !== "0.0.0.0" && options.host !== "::") {
    throw new Error("Web host must be localhost, a loopback/private IP address, 0.0.0.0 or ::.");
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("Web port must be an integer between 1 and 65535.");
  }
  if (!isLoopbackAddress(options.host) && !options.authFile) {
    throw new Error("Non-loopback Web access requires --auth-file <absolute-path>.");
  }
  if (options.authFile !== undefined && !isAbsolute(options.authFile)) {
    throw new Error("--auth-file must be an absolute path to an owner-only password file.");
  }
}

function passwordDigest(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
      || stat.size < 32 || stat.size > 256) throw new Error("invalid credential file");
    const password = readFileSync(fd, "utf8").replace(/\r?\n$/, "");
    if (!/^[\x21-\x7e]{32,128}$/.test(password)) throw new Error("invalid password");
    return createHash("sha256").update(`Basic ${Buffer.from(`yui:${password}`).toString("base64")}`).digest();
  } catch {
    // Never include file contents, OS error text or a submitted credential.
    throw new Error("Cannot load Web credential: use a regular owner-only (0600) file containing a unique 32–128 character ASCII password. Then restart Web.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createWebAccess(options: WebAccessOptions, interfaces = networkInterfaces()) {
  validateWebAccessOptions(options);
  const lan = !isLoopbackAddress(options.host);
  const digest = options.authFile === undefined ? undefined : passwordDigest(options.authFile);
  const wildcard = options.host === "0.0.0.0" || options.host === "::";
  const canonicalHost = (host: string) => isIP(host) === 6
    ? new URL(`http://[${host}]`).hostname.slice(1, -1) : host;
  const addresses = (wildcard
    ? [...new Set(Object.values(interfaces).flatMap(entries => entries ?? [])
      .filter(entry => isPrivateAddress(entry.address) && (options.host === "::" || entry.family === "IPv4"))
      .map(entry => entry.address))]
    : [options.host]).map(canonicalHost);
  const allowed = new Set(!lan || wildcard ? [...addresses, "127.0.0.1", "::1", "localhost"] : addresses);
  const urlHost = (host: string) => isIP(host) === 6 ? `[${host}]` : host;
  const urls = addresses.map(host => `http://${urlHost(host)}:${options.port}`);
  const warnings = lan ? [
    "HTTP is not encrypted. Use only a trusted network; credentials and data are visible to network observers.",
    ...(wildcard ? ["Wildcard binding listens on all matching interfaces, including public ones. Yui does not open firewall ports or tunnels."] : []),
    ...(!urls.length ? ["No usable private interface address was found. Check interfaces or bind an explicit private address; reachability is not verified."] : [])
  ] : [];
  return {
    lan,
    authentication: digest ? "basic" as const : "local" as const,
    urls,
    warnings,
    acceptsHost(request: IncomingMessage): boolean {
      const host = request.headers.host;
      if (!host) return false;
      try {
        const url = new URL(`http://${host}`);
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        return allowed.has(hostname) && host === `${urlHost(hostname)}${request.socket.localPort === 80 ? "" : `:${request.socket.localPort}`}`
          && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
      } catch { return false; }
    },
    acceptsOrigin(request: IncomingMessage, requireOrigin = false, scopedPreview = false): boolean {
      const origin = request.headers.origin;
      // Existing preview tickets authenticate only GET/HEAD of one sandboxed
      // Job. Its opaque-origin modules/fetches must not inherit user credentials.
      if (scopedPreview && (origin === undefined || origin === "null")) return true;
      return request.headers["sec-fetch-site"] !== "cross-site"
        && (origin === undefined ? !requireOrigin : origin === `http://${request.headers.host}`);
    },
    authenticated(request: IncomingMessage): boolean {
      if (!digest) return true;
      const authorization = request.headers.authorization;
      return typeof authorization === "string" && authorization.length <= 512
        && timingSafeEqual(createHash("sha256").update(authorization).digest(), digest);
    }
  };
}

export type WebAccess = ReturnType<typeof createWebAccess>;
