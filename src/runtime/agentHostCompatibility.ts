import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { agentHostControlSocketPath, inspectAgentHostSocket, type AgentHostSnapshot } from "./agentHost.js";
import { AGENT_HOST_CONTROL_PROTOCOL, AGENT_HOST_EVENT_PROTOCOL } from "./agentHostProtocol.js";
import { FILE_TASK_CONTROLLER_PROTOCOL_VERSION } from "../core/protocol.js";
import { readHomeFilesystemId } from "../core/homeFilesystemIdentity.js";
import { readLinuxProcessIdentity } from "./sessionOwnerIdentity.js";

export type AgentHostUpgradeBlocker = Readonly<{
  socket: string;
  owner?: AgentHostSnapshot["owner"];
  nativeSessionId?: string;
  attemptId?: string;
  state?: string;
  pid?: number;
  reason: string;
}>;

/** Inspect the concrete Home's existing control sockets, independently of the
 * database layout. No discovery write, process signal, input replay or repair.
 * Idle legacy Hosts are not safe: their next event still opens their old schema.
 */
export async function inspectAgentHostCompatibility(home: string): Promise<readonly AgentHostUpgradeBlocker[]> {
  const sample = agentHostControlSocketPath({ home, scope: "global", roleName: "compatibility-probe" });
  const directory = dirname(sample);
  const prefix = `${basename(sample).split("-")[0]}-`;
  let names: string[];
  try { names = readdirSync(directory).filter(name => name.startsWith(prefix) && /^[a-f0-9]{16}-[a-f0-9]{16}\.sock$/.test(name)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else return [{ socket: directory, reason: `Host inventory is unreadable: ${messageOf(error)}` }];
  }
  // A launch can have redeemed its payload but not yet bound its socket.
  // It is still a loaded Host implementation. Do not miss it just because
  // preflight happened in that short startup interval.
  const processes = liveHostProcesses(home);
  const sockets = new Set([...names.map(name => join(directory, name)), ...processes.map(p => p.socket)]);
  const results = await Promise.all([...sockets].map(async socket => {
    const live = processes.filter(p => p.socket === socket);
    try {
      const stat = lstatSync(socket);
      if (!stat.isSocket() || (stat.mode & 0o077) !== 0
        || (process.getuid !== undefined && stat.uid !== process.getuid())) {
        return { socket, reason: "Host socket ownership cannot be verified." };
      }
      const snapshot = await inspectAgentHostSocket(socket);
      if (live.some(p => snapshot.hostProcess?.pid !== p.pid
        || snapshot.hostProcess?.startIdentity !== p.startIdentity)) {
        return {
          socket, pid: live[0]!.pid,
          nativeSessionId: snapshot.nativeSessionId,
          reason: "The live Host process has no exact matching compatibility response (legacy or still starting)."
        };
      }
      const compatibility = snapshot.compatibility;
      if (compatibility?.control === AGENT_HOST_CONTROL_PROTOCOL
        && compatibility.events === AGENT_HOST_EVENT_PROTOCOL
        && compatibility.rpc === FILE_TASK_CONTROLLER_PROTOCOL_VERSION
        && compatibility.storage === "controller-owned") return undefined;
      return {
        socket,
        ...(snapshot.owner === undefined ? {} : { owner: snapshot.owner }),
        ...(snapshot.nativeSessionId === undefined ? {} : { nativeSessionId: snapshot.nativeSessionId }),
        ...(snapshot.attemptId === undefined ? {} : { attemptId: snapshot.attemptId }),
        state: snapshot.state,
        reason: compatibility === undefined
          ? "Legacy Host has no schema-independent event capability; its loaded code cannot be upgraded in place."
          : "Host control/event/RPC compatibility is outside this Controller's supported range."
      };
    } catch (error) {
      const stillLive = live.find(p => readLinuxProcessIdentity(p.pid)?.startIdentity === p.startIdentity);
      if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")
        && stillLive === undefined) return undefined;
      return { socket, ...(stillLive === undefined ? {} : { pid: stillLive.pid }),
        reason: `Live Host compatibility is unconfirmed: ${messageOf(error)}` };
    }
  }));
  return results.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

export function describeAgentHostUpgradeBlockers(blockers: readonly AgentHostUpgradeBlocker[]): string {
  return blockers.map(blocker => [
    blocker.owner === undefined ? blocker.socket
      : `${blocker.owner.taskId ?? blocker.owner.scope}/${blocker.owner.roleName}`,
    blocker.nativeSessionId === undefined ? "" : `Session=${blocker.nativeSessionId}`,
    blocker.attemptId === undefined ? "" : `input=${blocker.attemptId}`,
    blocker.state === undefined ? "" : `Host=${blocker.state}`,
    blocker.pid === undefined ? "" : `PID=${blocker.pid}`,
    blocker.reason
  ].filter(Boolean).join("; ")).join("\n");
}

function liveHostProcesses(home: string): Array<{ socket: string; pid: number; startIdentity: string }> {
  if (process.platform !== "linux") return [];
  const expected = readHomeFilesystemId(home);
  const hosts: Array<{ socket: string; pid: number; startIdentity: string }> = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const pid = Number(name);
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      if (Number(/^Uid:\s+([0-9]+)/mu.exec(status)?.[1]) !== process.getuid?.()) continue;
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!args.some((arg, i) => /(?:^|\/)cli\.js$/.test(arg)
        && args[i + 1] === "internal" && args[i + 2] === "agent-host")) continue;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      const value = (key: string) => env.find(entry => entry.startsWith(`${key}=`))?.slice(key.length + 1);
      const processHome = value("YUI_HOME");
      if (processHome === undefined || readHomeFilesystemId(processHome) !== expected) continue;
      const identity = readLinuxProcessIdentity(pid);
      if (identity === undefined || identity.state === "Z") continue;
      hosts.push({ pid, startIdentity: identity.startIdentity,
        socket: agentHostControlSocketPath({
          home, scope: value("YUI_SESSION_SCOPE") ?? "task",
          taskId: value("YUI_TASK_ID"), roleName: value("YUI_ROLE") ?? "unknown-role"
        }) });
    } catch {
      // Other owners and processes that exited while being read are not this
      // Home's proven Hosts. No PID is ever acted on by this read-only inventory.
    }
  }
  return hosts;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
