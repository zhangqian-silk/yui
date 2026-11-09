import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Native-title evidence only, not another Session identity or lifecycle.
 * The intent file is exclusive and retained even when a process dies. An
 * unanswered mutation is never made replayable by a new Host attachment. */
export type NativeTitleIdentity = Readonly<{
  scope: "task" | "global";
  taskId?: string;
  roleName: string;
  agentId: string;
  threadId: string;
}>;
export type NativeTitleReceipt = Readonly<{
  schemaVersion: 1;
  identity: NativeTitleIdentity;
  accountHome: string;
  attemptId: string;
  requestedTitle: string;
  expectedTitle: string | null;
  status: "submitted" | "confirmed" | "unknown" | "preserved";
  generatedTitles: readonly string[];
}>;

export function nativeTitleDirectory(home: string, identity: NativeTitleIdentity): string {
  const key = createHash("sha256").update(JSON.stringify([
    identity.scope, identity.taskId ?? null, identity.roleName, identity.agentId, identity.threadId
  ])).digest("hex");
  return join(home, "runtime", "native-titles", key);
}

export function parseNativeTitleReceipt(text: string, identity: NativeTitleIdentity): NativeTitleReceipt {
  const value = JSON.parse(text) as NativeTitleReceipt;
  if (value.schemaVersion !== 1 || JSON.stringify(value.identity) !== JSON.stringify(identity)
    || !value.accountHome || !value.attemptId || !value.requestedTitle
    || !(value.expectedTitle === null || typeof value.expectedTitle === "string")
    || !["submitted", "confirmed", "unknown", "preserved"].includes(value.status)
    || !Array.isArray(value.generatedTitles) || value.generatedTitles.some(title => typeof title !== "string")) {
    throw new Error("Invalid native title receipt; preserve it for diagnosis.");
  }
  return value;
}

/** Read-only diagnostics can reuse confirmation, never a submitted naming intent.
 * Unavailable/uncertain evidence supplies no ownership of an existing title. */
export function confirmedNativeTitles(home: string, identity: NativeTitleIdentity): readonly string[] {
  try {
    const receipt = parseNativeTitleReceipt(
      readFileSync(join(nativeTitleDirectory(home, identity), "receipt.json"), "utf8"), identity);
    return receipt.status === "confirmed" ? receipt.generatedTitles : [];
  } catch {
    return [];
  }
}
