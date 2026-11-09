import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// No Thread, Turn, model, auth copy or shared daemon. This is a negative
// capability gate, not proof that every later managed command will succeed.
export async function controllerSandboxPreflight({ providerBin, product, root, home, controllerBridge, timeoutMs = 15000 }) {
  const codexHome = join(root, "user/.codex-controller-preflight");
  mkdirSync(codexHome, { recursive: true });
  const cwd = join(root, "controller-preflight-work");
  mkdirSync(cwd, { recursive: true });
  const child = spawn(providerBin, ["app-server", "--listen", "stdio://"], {
    cwd: root, detached: process.platform !== "win32",
    env: { HOME: join(root, "user"), CODEX_HOME: codexHome,
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  let sequence = 0, totalBytes = 0;
  const pending = new Map();
  const rejectAll = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on("error", rejectAll);
  child.on("close", () => rejectAll(Error("Native preflight exited before its response")));
  child.stdin.on("error", rejectAll);
  child.stderr.resume(); // Never persist native configuration/auth diagnostics.
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    totalBytes += Buffer.byteLength(line);
    if (totalBytes > 1024 * 1024) return rejectAll(Error("Native preflight output exceeded limit"));
    let message;
    try { message = JSON.parse(line); } catch { return rejectAll(Error("Invalid native preflight response")); }
    const p = pending.get(message.id);
    if (!p) return;
    pending.delete(message.id);
    if (message.error) p.reject(Error(`Native preflight RPC rejected: ${message.error.code}`));
    else p.resolve(message.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const timer = setTimeout(() => rejectAll(Error("Native preflight timeout")), timeoutMs);
  const stop = signal => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  try {
    await call("initialize", { clientInfo: { name: "yui-controller-preflight", version: "1" } });
    child.stdin.write('{"method":"initialized"}\n');
    // Public `controller status` is an inventory and can exit successfully even
    // when RPC is unavailable. Exercise the exact checkout's authenticated RPC.
    const bridgeChecks = controllerBridge ? `
const {Socket}=await import("node:net");
for(const target of [${JSON.stringify(controllerBridge.socketPath)},${JSON.stringify(controllerBridge.socketPath + ".neighbor")},{host:"127.0.0.1",port:9}]) {
  await new Promise((resolve,reject)=>{
    const socket=new Socket(), timer=setTimeout(()=>{socket.destroy();reject(Error("Sandbox denial not observed"))},500);
    socket.on("connect",()=>{clearTimeout(timer);socket.destroy();reject(Error("Unexpected direct socket access"))});
    socket.on("error",e=>{clearTimeout(timer);["EPERM","EACCES"].includes(e.code)?resolve():reject(e)});
    socket.connect(target);
  });
}
const {writeFileSync,unlinkSync}=await import("node:fs");
const {randomUUID}=await import("node:crypto");
const owned=${JSON.stringify(join(home, ".bridge-write-probe-"))}+randomUUID();
writeFileSync(owned,"owned",{flag:"wx"});unlinkSync(owned);
const path="/tmp/yui-bridge-denied-"+randomUUID();
let denied=false;
try {writeFileSync(path,"probe",{flag:"wx"});}catch(e){if(!["EROFS","EACCES","EPERM"].includes(e.code))throw e;denied=true;}
if(!denied){unlinkSync(path);throw Error("Shared /tmp unexpectedly writable");}
` : "";
    const probe = `import {callController} from ${JSON.stringify(pathToFileURL(join(product, "dist/core/controllerClient.js")).href)};
try { await callController(${JSON.stringify(home)}, "controller.status");
${bridgeChecks}
console.log("controller-rpc-connected"); }
catch(e) { console.error(JSON.stringify({code:e.code,message:e.message,diagnostic:e.diagnostic}));process.exitCode=5; }`;
    const commandParams = {
      command: [process.execPath, ...(controllerBridge ? ["--import", controllerBridge.module] : []),
        "--input-type=module", "-e", probe],
      cwd, env: { YUI_HOME: home, HOME: join(root, "user"),
        ...(controllerBridge ? { YUI_EVAL_CONTROLLER_BRIDGE: JSON.stringify(controllerBridge) } : {}),
        PATH: `${join(root, "bin")}:/usr/bin:/bin` }, timeoutMs: Math.min(timeoutMs, 10000),
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd,
        ...(controllerBridge ? [controllerBridge.home, controllerBridge.directory] : [])],
        excludeSlashTmp: true, excludeTmpdirEnvVar: true, networkAccess: false }
    };
    const result = await call("command/exec", commandParams);
    if (!Number.isInteger(result?.exitCode) || typeof result.stdout !== "string"
      || typeof result.stderr !== "string") throw Error("Native preflight result is incomplete");
    let cli, reachable = result.exitCode === 0 && result.stdout.trim() === "controller-rpc-connected";
    if (reachable && controllerBridge) {
      cli = await call("command/exec", { ...commandParams,
        command: [join(root, "bin/yui"), "--json", "controller", "live-identity"] });
      try { reachable = cli.exitCode === 0 && JSON.parse(cli.stdout).ok === true; }
      catch { reachable = false; }
    }
    return { status: reachable ? "reachable" : "blocked", ...(cli ? { cli } : {}),
      ...(controllerBridge ? { requiredChecks: ["authenticated-rpc", "fixture-cli-rpc", "raw-own-socket-denied",
        "raw-neighbor-socket-denied", "raw-tcp-denied", "fixture-home-write", "shared-tmp-write-denied"] } : {}),
      modelStarted: false, ...result };
  } finally {
    clearTimeout(timer);
    stop("SIGTERM");
    const kill = setTimeout(() => stop("SIGKILL"), 2000);
    try { await closed; } finally { clearTimeout(kill); lines.close(); }
  }
}
