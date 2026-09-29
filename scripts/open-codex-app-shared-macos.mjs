#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";

const prepareOnly = process.argv.length === 3 && process.argv[2] === "--prepare";
if (process.argv.length > (prepareOnly ? 3 : 2)) {
  throw new Error("Usage: open-codex-app-shared-macos.mjs [--prepare]");
}

const app = "/Applications/ChatGPT.app";
const appMain = join(app, "Contents/MacOS/ChatGPT");
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const socketPath = join(codexHome, "app-server-control/app-server-control.sock");

if (process.platform !== "darwin") throw new Error("This launcher is for macOS only.");
if (!isAbsolute(codexHome)) throw new Error("CODEX_HOME must be an absolute path.");
accessSync(appMain, constants.X_OK);

// A second App process would use another window/profile and make writer ownership
// ambiguous. Quit the existing App normally before choosing this launch path.
const processArgs = execFileSync("/bin/ps", ["-axo", "args="], { encoding: "utf8" });
if (!prepareOnly && processArgs.split("\n").some((args) => args === appMain || args.startsWith(`${appMain} `))) {
  throw new Error("Codex App is already running. Quit it normally, then run this command again.");
}

async function socketReady() {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(1000, () => socket.destroy(new Error("Shared daemon socket timed out.")));
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", (error) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
  });
}

if (!await socketReady()) {
  execFileSync(process.env.CODEX_BINARY || "codex", ["app-server", "daemon", "start"], {
    env: { ...process.env, CODEX_HOME: codexHome }, stdio: "inherit", timeout: 15_000
  });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await socketReady()) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Shared daemon did not open ${socketPath}.`);
}

const wsUrl = `ws+unix://localhost${socketPath}:/rpc`;
execFileSync("/bin/launchctl", ["setenv", "CODEX_APP_SERVER_WS_URL", wsUrl], { stdio: "inherit" });
if (prepareOnly) {
  console.log("Shared local app-server is ready for Codex App launches in this login session.");
  process.exit(0);
}
execFileSync("/usr/bin/open", [
  "-n", "--env", `CODEX_HOME=${codexHome}`,
  "--env", `CODEX_APP_SERVER_WS_URL=${wsUrl}`, app
], { stdio: "inherit", timeout: 15_000 });
console.log("Codex App launch requested with the shared local app-server.");
