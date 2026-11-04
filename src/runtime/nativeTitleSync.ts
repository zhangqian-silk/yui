import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rmdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { AgentHostLaunchPayload } from "./launchBroker.js";
import { createNonBlockingChecks } from "./lifecycleChecks.js";
import { CodexNamingClient } from "../execution/codexThreadNaming.js";
import {
  nativeTitleDirectory, parseNativeTitleReceipt,
  type NativeTitleIdentity, type NativeTitleReceipt
} from "./nativeTitleReceipt.js";

export type NativeTitleSyncRequest = Readonly<{
  home: string;
  identity: NativeTitleIdentity;
  accountHome: string;
  command: string;
  baseArgs: readonly string[];
  environment: NodeJS.ProcessEnv;
  title: string;
  generatedTitle?: string;
  localTitle?: string;
  newThread: boolean;
  previousTitle?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;
export type NativeTitleSyncResult = Readonly<{
  threadId: string;
  status: "confirmed" | "preserved" | "not-submitted" | "unknown";
  attemptId?: string;
  title?: string;
  detail: string;
  receiptPath?: string;
}>;

/** A standalone metadata process, NOT a second connection to the shared
 * business daemon. It never starts/resumes a Thread or runs a Turn. Its hard
 * process deadline releases even native locks after an unanswered request.
 * Caller launches this in an independent lane; Goal/Turn never await it. */
export async function synchronizeNativeTitle(request: NativeTitleSyncRequest): Promise<NativeTitleSyncResult> {
  const result = (status: NativeTitleSyncResult["status"], detail: string,
    extra: Partial<NativeTitleSyncResult> = {}): NativeTitleSyncResult =>
    ({ threadId: request.identity.threadId, status, detail, ...extra });
  let client: CodexNamingClient | undefined;
  let locked = false;
  let submitted = false;
  let receipt: NativeTitleReceipt | undefined;
  const cancel = () => client?.close("SIGKILL");
  const directory = nativeTitleDirectory(request.home, request.identity);
  try {
    if (!isAbsolute(request.home) || !isAbsolute(request.accountHome)
      || [request.title, request.generatedTitle].some(title => title !== undefined
        && (!title || title.trim() !== title || title.length > 1024 || /[\r\n\0]/u.test(title)))) {
      return result("not-submitted", "Native title request has an invalid local identity or title.");
    }
    if (request.signal?.aborted) return result("not-submitted", "Title attachment closed.");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Never remove another attempt's lock, including after a Host crash.
    await mkdir(join(directory, "writing"), { mode: 0o700 });
    locked = true;
    try {
      receipt = parseNativeTitleReceipt(await readFile(join(directory, "receipt.json"), "utf8"), request.identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (receipt !== undefined && (receipt.accountHome !== request.accountHome || receipt.status !== "confirmed")) {
      return result("not-submitted", "Prior title identity/effect is unresolved; no rename replayed.",
        { attemptId: receipt.attemptId, receiptPath: join(directory, "receipt.json") });
    }
    if (request.localTitle !== undefined && request.localTitle !== request.previousTitle
      && !receipt?.generatedTitles.includes(request.localTitle)) {
      return result("preserved", "Yui Session has a custom or unowned local title; native name left unchanged.");
    }
    client = await CodexNamingClient.start(request.command,
      { ...request.environment, CODEX_HOME: request.accountHome }, request.baseArgs, request.timeoutMs ?? 2_000);
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) return result("not-submitted", "Title attachment closed.");
    if (client.accountHome !== request.accountHome) {
      return result("not-submitted", "Metadata process account identity did not match the business connection.");
    }
    const read = await client.request("thread/read", { threadId: request.identity.threadId, includeTurns: false });
    const thread = read.thread as Record<string, unknown> | undefined;
    if (thread?.id !== request.identity.threadId
      || !(thread.name == null || typeof thread.name === "string")) {
      return result("not-submitted", "Native title observation has no exact Thread/name identity.");
    }
    const current = typeof thread.name === "string" && thread.name.length > 0 ? thread.name : null;
    const previous = receipt?.requestedTitle ?? request.previousTitle;
    const title = request.generatedTitle !== undefined
      && (request.title === previous || receipt?.generatedTitles.includes(request.title))
      ? request.generatedTitle : request.title;
    // A prefix (including the historic Skill notice) is not ownership proof.
    if (current !== previous && !(request.newThread && current === null && receipt === undefined)) {
      const pollution = [current, thread.preview].some(value => typeof value === "string"
        && (value.startsWith("Yui Host checked current Skills;")
          || value.startsWith("Yui Session Manifest:")
          || value.startsWith("<!-- yui:skills-checked -->")));
      return result("preserved", pollution
        ? "Historical Skill-prefix title/preview candidate; no native ownership proof, so no repair submitted."
        : "Native name has no matching generated-title provenance; left unchanged.");
    }
    if (current === title) return result("confirmed", "Existing generated title observed.",
      { title, ...(receipt === undefined ? {} : { attemptId: receipt.attemptId }) });
    receipt = {
      schemaVersion: 1, identity: request.identity, accountHome: request.accountHome,
      attemptId: randomUUID(), requestedTitle: title, expectedTitle: current,
      status: "submitted", generatedTitles: receipt?.generatedTitles ?? (previous === undefined ? [] : [previous])
    };
    // Durable intent precedes the only mutation. A crash anywhere after this
    // write is an unknown effect, never permission to resubmit.
    await saveReceipt(directory, receipt);
    if (request.signal?.aborted) return result("not-submitted", "Title attachment closed before mutation.");
    // Persistence may yield to a user's edit. Recheck immediately before
    // sending; the native API has no expected-name compare-and-swap.
    const prewrite = await client.request("thread/read", { threadId: request.identity.threadId, includeTurns: false });
    const fresh = prewrite.thread as Record<string, unknown> | undefined;
    if (fresh?.id !== request.identity.threadId || (fresh.name ?? null) !== current) {
      await saveReceipt(directory, { ...receipt, status: "preserved" });
      return result("preserved", "Native name changed before submission; no rename sent.", { attemptId: receipt.attemptId });
    }
    if (request.signal?.aborted) return result("not-submitted", "Title attachment closed before mutation.");
    submitted = true;
    await client.request("thread/name/set", { threadId: request.identity.threadId, name: title });
    const confirmation = await client.request("thread/read", { threadId: request.identity.threadId, includeTurns: false });
    const observed = confirmation.thread as Record<string, unknown> | undefined;
    if (observed?.id !== request.identity.threadId || observed.name !== title) {
      throw new Error("Title mutation has no matching readback; preserve unknown effect.");
    }
    receipt = { ...receipt, status: "confirmed",
      generatedTitles: [...new Set([...receipt.generatedTitles, title])] };
    await saveReceipt(directory, receipt);
    return result("confirmed", "Native title acknowledged and read back.", {
      attemptId: receipt.attemptId, title, receiptPath: join(directory, "receipt.json")
    });
  } catch (error) {
    if (submitted && receipt !== undefined) {
      await saveReceipt(directory, { ...receipt, status: "unknown" }).catch(() => {});
    }
    return result(submitted ? "unknown" : "not-submitted",
      error instanceof Error ? error.message : String(error),
      receipt === undefined ? {} : { attemptId: receipt.attemptId, receiptPath: join(directory, "receipt.json") });
  } finally {
    request.signal?.removeEventListener("abort", cancel);
    client?.close();
    await client?.exited;
    if (locked) await rmdir(join(directory, "writing")).catch(() => {});
  }
}

/** Use task-161's independent lifecycle-check lane without changing its FSM.
 * One trigger per attachment; receipt fencing handles reconnects/other Hosts. */
export function createNativeTitleSync(
  payload: AgentHostLaunchPayload,
  threadId: string,
  accountHome: string | undefined,
  report: (result: NativeTitleSyncResult) => void
) {
  let triggered = false;
  const checks = createNonBlockingChecks([{
    id: "native-title",
    async run(_observation: boolean, signal: AbortSignal) {
      const env = payload.environment;
      const title = payload.providerControl?.sessionTitle ?? env.YUI_SESSION_TITLE ?? env.YUI_NATIVE_TITLE_PROPOSAL;
      if (title === undefined) return;
      const scope = env.YUI_SESSION_SCOPE;
      if (!accountHome || !env.YUI_HOME || !env.YUI_ROLE || !env.YUI_AGENT_ID
        || !["task", "global"].includes(scope ?? "") || scope === "task" && !env.YUI_TASK_ID
        || !env.YUI_AGENT_BASE_ARGS) {
        report({ threadId, status: "not-submitted", detail: "Native title synchronization lacks an exact local account/launch identity." });
        return;
      }
      const baseArgs: unknown = JSON.parse(env.YUI_AGENT_BASE_ARGS);
      if (!Array.isArray(baseArgs) || baseArgs.some(value => typeof value !== "string")) {
        throw new Error("Invalid native naming executable arguments.");
      }
      const observed = await synchronizeNativeTitle({
        home: env.YUI_HOME, identity: {
          scope: scope as "task" | "global",
          ...(scope === "task" ? { taskId: env.YUI_TASK_ID } : {}),
          roleName: env.YUI_ROLE, agentId: env.YUI_AGENT_ID, threadId
        },
        accountHome, command: payload.command, baseArgs,
        environment: env, title,
        ...(env.YUI_NATIVE_TITLE_PROPOSAL === undefined ? {} : { generatedTitle: env.YUI_NATIVE_TITLE_PROPOSAL }),
        ...(env.YUI_NATIVE_TITLE_LOCAL === undefined ? {} : { localTitle: env.YUI_NATIVE_TITLE_LOCAL }),
        newThread: payload.providerControl?.mode === "new"
          || payload.providerControl === undefined && env.YUI_NATIVE_SESSION_ID === undefined,
        ...(payload.providerControl?.previousSessionTitle === undefined ? {} : {
          previousTitle: payload.providerControl.previousSessionTitle
        }),
        signal
      });
      if (!signal.aborted) report(observed);
    }
  }], error => report({ threadId, status: "not-submitted", detail: String(error) }));
  return {
    notify() { if (!triggered) { triggered = true; checks.notify(true); } },
    close() { checks.close(); }
  };
}

async function saveReceipt(directory: string, receipt: NativeTitleReceipt): Promise<void> {
  const temporary = join(directory, `${receipt.attemptId}-${receipt.status}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt) + "\n");
    await file.sync();
  } finally { await file.close(); }
  await rename(temporary, join(directory, "receipt.json"));
  const parent = await open(directory, "r");
  try { await parent.sync(); } finally { await parent.close(); }
}
