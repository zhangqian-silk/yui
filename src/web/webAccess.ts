import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { isAbsolute } from "node:path";

export type WebAccessOptions = Readonly<{ host: string; port: number; authFile?: string }>;

/** Listener-scoped browser sessions. Nothing is persisted: stopping Web (or
 * replacing the credential file and restarting) revokes every session. */
export type WebSessionPolicy = Readonly<{
  idleMs: number; absoluteMs: number; maxSessions: number;
  failureWindowMs: number; maxFailures: number; now: () => number;
}>;

export const DEFAULT_WEB_SESSION_POLICY: WebSessionPolicy = Object.freeze({
  idleMs: 8 * 60 * 60 * 1000,
  absoluteMs: 24 * 60 * 60 * 1000,
  maxSessions: 32,
  failureWindowMs: 60 * 1000,
  maxFailures: 5,
  now: () => Date.now()
});

export type WebLoginResult =
  | Readonly<{ ok: true; cookie: string }>
  | Readonly<{ ok: false; reason: "invalid" | "throttled" | "unconfigured"; retryAfterSeconds?: number }>;

/** A post-login destination must stay a same-origin document path. Anything
 * else (absolute/protocol-relative URLs, backslashes, API/auth/asset paths)
 * falls back to the workbench root. */
export function safeReturnPath(candidate: unknown): string {
  if (typeof candidate !== "string" || candidate.length > 2048 || !candidate.startsWith("/")
    || candidate.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(candidate)) return "/";
  try {
    const url = new URL(candidate, "http://return.invalid");
    if (url.origin !== "http://return.invalid") return "/";
    if (/^\/(?:login|auth|api|assets|preview)(?:\/|$)/u.test(url.pathname)) return "/";
    return url.pathname + url.search;
  } catch { return "/"; }
}

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
    return createHash("sha256").update(password).digest();
  } catch {
    // Never include file contents, OS error text or a submitted credential.
    throw new Error("Cannot load Web credential: use a regular owner-only (0600) file containing a unique 32–128 character ASCII password. Then restart Web.");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function createWebAccess(
  options: WebAccessOptions,
  interfaces = networkInterfaces(),
  policy: WebSessionPolicy = DEFAULT_WEB_SESSION_POLICY
) {
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
  // Cookies are scoped by host, not port: include the port so two listeners on
  // one machine cannot overwrite each other's session.
  const cookieName = `yui_session_${options.port}`;
  // Keyed by a hash of the opaque cookie value; the raw value is never stored.
  const sessions = new Map<string, { created: number; seen: number }>();
  const failures = new Map<string, number[]>();
  const sessionKey = (request: IncomingMessage): string | undefined => {
    const header = request.headers.cookie;
    if (typeof header !== "string" || header.length > 8192) return undefined;
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index > 0 && part.slice(0, index).trim() === cookieName) {
        const value = part.slice(index + 1).trim();
        return /^[A-Za-z0-9_-]{43}$/.test(value) ? createHash("sha256").update(value).digest("hex") : undefined;
      }
    }
    return undefined;
  };
  const live = (key: string | undefined, touch: boolean): boolean => {
    if (key === undefined) return false;
    const session = sessions.get(key);
    if (!session) return false;
    const now = policy.now();
    if (now - session.seen >= policy.idleMs || now - session.created >= policy.absoluteMs) {
      sessions.delete(key);
      return false;
    }
    if (touch) session.seen = now;
    return true;
  };
  const cookie = (value: string, maxAgeSeconds: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  const warnings = lan ? [
    "HTTP is not encrypted. Use only a trusted network; credentials and data are visible to network observers.",
    ...(wildcard ? ["Wildcard binding listens on all matching interfaces, including public ones. Yui does not open firewall ports or tunnels."] : []),
    ...(!urls.length ? ["No usable private interface address was found. Check interfaces or bind an explicit private address; reachability is not verified."] : [])
  ] : [];
  return {
    lan,
    authentication: digest ? "password" as const : "local" as const,
    passwordRequired: digest !== undefined,
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
    /** Every protected request/handshake checks the listener's session table. */
    authenticated(request: IncomingMessage): boolean {
      return !digest || live(sessionKey(request), true);
    },
    /** True when the request carries this listener's cookie name, valid or not. */
    presentedSession(request: IncomingMessage): boolean {
      return typeof request.headers.cookie === "string"
        && request.headers.cookie.split(";").some(part => part.trim().startsWith(`${cookieName}=`));
    },
    /** Opaque identity for binding long-lived connections; not a credential. */
    sessionOf(request: IncomingMessage): string | undefined {
      const key = sessionKey(request);
      return live(key, false) ? key : undefined;
    },
    sessionActive(key: string | undefined): boolean { return !digest || live(key, false); },
    login(request: IncomingMessage, password: unknown): WebLoginResult {
      if (!digest) return { ok: false, reason: "unconfigured" };
      const now = policy.now();
      const address = request.socket.remoteAddress ?? "unknown";
      const recent = (failures.get(address) ?? []).filter(at => now - at < policy.failureWindowMs);
      if (recent.length >= policy.maxFailures) {
        failures.set(address, recent);
        return { ok: false, reason: "throttled",
          retryAfterSeconds: Math.max(1, Math.ceil((recent[0]! + policy.failureWindowMs - now) / 1000)) };
      }
      const valid = typeof password === "string" && password.length <= 256
        && timingSafeEqual(createHash("sha256").update(password).digest(), digest);
      if (!valid) {
        recent.push(now);
        failures.delete(address);
        failures.set(address, recent);
        // Bound memory: forget the oldest addresses first.
        while (failures.size > 1024) failures.delete(failures.keys().next().value!);
        return { ok: false, reason: "invalid" };
      }
      failures.delete(address);
      for (const [key, session] of sessions) {
        if (now - session.seen >= policy.idleMs || now - session.created >= policy.absoluteMs) sessions.delete(key);
      }
      while (sessions.size >= policy.maxSessions) {
        let oldest: string | undefined;
        let seen = Infinity;
        for (const [key, session] of sessions) if (session.seen < seen) { seen = session.seen; oldest = key; }
        sessions.delete(oldest!);
      }
      const value = randomBytes(32).toString("base64url");
      sessions.set(createHash("sha256").update(value).digest("hex"), { created: now, seen: now });
      return { ok: true, cookie: cookie(value, Math.floor(policy.absoluteMs / 1000)) };
    },
    /** Revokes the presented session (if any) and returns a clearing cookie. */
    logout(request: IncomingMessage): string {
      const key = sessionKey(request);
      if (key !== undefined) sessions.delete(key);
      return cookie("", 0);
    },
    clearCookie(): string { return cookie("", 0); }
  };
}

export type WebAccess = ReturnType<typeof createWebAccess>;
