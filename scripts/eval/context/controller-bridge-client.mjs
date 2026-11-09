// Evaluation-only transport adapter; the checkout's CLI and protocol parser
// still execute inside the native sandbox. No host command execution.
import net from "node:net";
import { Duplex } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const limit = 1_048_577;
export function bridgeConnection(directory, { timeoutMs = 5000 } = {}) {
  const id = randomUUID();
  let poll, deadline, published = false;
  const socket = new Duplex({
    read() {},
    write(bytes, encoding, done) {
      try {
        if (published || bytes.length > limit || bytes.at(-1) !== 10
          || bytes.indexOf(10) !== bytes.length - 1) throw Error("Invalid Controller bridge frame");
        published = true;
        const staging = join(directory, `${id}.tmp`);
        writeFileSync(staging, bytes, { flag: "wx", mode: 0o600 });
        renameSync(staging, join(directory, `${id}.request`));
        done();
      } catch (error) { done(error); }
    },
    destroy(error, done) { clearInterval(poll); clearTimeout(deadline); done(error); }
  });
  poll = setInterval(() => {
    let fd;
    try {
      fd = openSync(join(directory, `${id}.response`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit * 2) throw Error("Invalid Controller bridge response");
      const buffer = Buffer.alloc(limit * 2 + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > limit * 2) throw Error("Oversized Controller bridge response");
      const response = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      clearInterval(poll);
      if (response.error) throw Error(`Controller bridge: ${response.error}`);
      if (typeof response.bytes !== "string") throw Error("Invalid Controller bridge response");
      socket.push(Buffer.from(response.bytes, "base64"));
    } catch (error) {
      if (error.code !== "ENOENT") socket.destroy(error);
    } finally { if (fd !== undefined) closeSync(fd); }
  }, 10);
  deadline = setTimeout(() => socket.destroy(Error("Controller bridge timed out; delivery unconfirmed")), timeoutMs);
  // "connect" means this one-shot relay is ready, not that delivery is proven.
  // Product errors after write therefore remain conservatively unconfirmed.
  queueMicrotask(() => { if (!socket.destroyed) socket.emit("connect"); });
  return socket;
}

if (process.env.YUI_EVAL_CONTROLLER_BRIDGE) {
  const binding = JSON.parse(process.env.YUI_EVAL_CONTROLLER_BRIDGE);
  if (binding.home !== process.env.YUI_HOME || typeof binding.directory !== "string"
    || typeof binding.socketPath !== "string") throw Error("Controller bridge Home binding mismatch");
  const original = net.createConnection;
  net.createConnection = function (path, ...args) {
    if (path !== binding.socketPath) return original.call(this, path, ...args);
    return bridgeConnection(binding.directory);
  };
  syncBuiltinESMExports();
}
