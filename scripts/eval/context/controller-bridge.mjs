// Linux fixture-only, one-shot file-to-Unix-socket relay. The destination and
// Home identity are captured by the evaluator, never taken from a request.
import { constants, openSync, closeSync, fstatSync, readSync, writeFileSync,
  readdirSync, renameSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const limit = 1_048_577, requestName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.request$/;
export function startControllerBridge({ directory, socketPath, homeId, homeFilesystemId }) {
  if (process.platform !== "linux") throw Error("Controller fixture bridge requires Linux anchored directory descriptors");
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  // Pin the directory inode, including against replacement by a symlink. All
  // host file operations stay relative to this descriptor, not caller paths.
  const anchor = `/proc/self/fd/${fd}`, seen = new Set(), pending = new Set();
  let stopping = false, closed;
  const stats = { forwarded: 0, rejected: 0 };
  const respond = (id, response) => {
    const staging = `${anchor}/${randomUUID()}.reply-tmp`;
    try {
      writeFileSync(staging, JSON.stringify(response), { flag: "wx", mode: 0o600 });
      renameSync(staging, `${anchor}/${id}.response`);
    } catch { try { unlinkSync(staging); } catch {} } // Lost response is not replay authority.
  };
  const forward = (id, bytes) => new Promise(resolve => {
    const socket = createConnection(socketPath);
    let chunks = [], size = 0, settled = false;
    const finish = response => {
      if (settled) return;
      settled = true; clearTimeout(timeout); socket.destroy(); respond(id, response); resolve();
    };
    const timeout = setTimeout(() => finish({ error: "transport timeout; delivery unconfirmed" }), 5000);
    socket.on("connect", () => { stats.forwarded++; socket.write(bytes); });
    socket.on("data", chunk => {
      chunks.push(chunk); size += chunk.length;
      if (size > limit) return finish({ error: "oversized Controller response; delivery unconfirmed" });
      if (chunk.includes(10)) finish({ bytes: Buffer.concat(chunks).toString("base64") });
    });
    socket.on("end", () => finish({ error: "Controller closed before response; delivery unconfirmed" }));
    socket.on("error", () => finish({ error: "Controller transport failed; delivery unconfirmed" }));
  });
  const poll = setInterval(() => {
    if (stopping) return;
    for (const name of readdirSync(anchor)) {
      if (!requestName.test(name)) continue;
      if (pending.size >= 8) break;
      const id = name.slice(0, -8), active = `${anchor}/${id}.active`;
      let input;
      try {
        renameSync(`${anchor}/${name}`, active);
        if (seen.has(id) || seen.size >= 10000) throw Error("replayed or exhausted mailbox");
        seen.add(id); // Claim once, including invalid requests; never retry.
        input = openSync(active, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(input);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw Error("invalid request file");
        const buffer = Buffer.alloc(limit + 1);
        const length = readSync(input, buffer, 0, buffer.length, 0);
        if (length > limit) throw Error("oversized request");
        const bytes = buffer.subarray(0, length);
        if (bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) throw Error("invalid request frame");
        const request = JSON.parse(bytes.toString("utf8"));
        if (request.homeId !== homeId || request.homeFilesystemId !== homeFilesystemId) throw Error("foreign Home");
        const operation = forward(id, bytes);
        pending.add(operation); operation.finally(() => pending.delete(operation));
      } catch {
        stats.rejected++;
        respond(id, { error: "request refused by fixed-Home bridge" });
      } finally {
        if (input !== undefined) closeSync(input);
        try { unlinkSync(active); } catch {}
      }
    }
  }, 10);
  return {
    stats,
    close() {
      if (!closed) {
        stopping = true; clearInterval(poll);
        closed = Promise.all([...pending]).then(() => { closeSync(fd); return { ...stats, stopped: true }; });
      }
      return closed;
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = startControllerBridge(JSON.parse(process.argv[2]));
  let closing;
  const close = () => closing ??= bridge.close().then(stats => {
    if (process.connected) { process.send({ finished: stats }); process.disconnect(); }
  });
  process.on("message", message => { if (message === "finish") void close(); });
  process.on("disconnect", close); process.on("SIGTERM", close);
  process.send({ ready: true });
}
