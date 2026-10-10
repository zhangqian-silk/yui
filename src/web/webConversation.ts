import { realpathSync } from "node:fs";
import type { RoleSessionOwner, RoleSessionSet } from "../executor/agentExecutor.js";
import { CodexAppServerRuntime, codexClientInitialization } from "../runtime/codexAppServerRuntime.js";
import { openCodexInteractiveConnection } from "../runtime/structuredProviderHost.js";
import type { NativeControlConnection } from "../runtime/nativeSessionControl.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { WebTaskSurface } from "./webTaskSurface.js";
import { WebRequestRejected } from "./webMutation.js";
import { findTaskInterrupt, taskInterruptReceipt } from "../message/taskInterrupt.js";
import type { AgentHostSnapshot } from "../runtime/agentHost.js";
import type { GitArtifactRef } from "../artifacts/gitArtifactRef.js";
import { materialInputBody, saveTextMaterial, type TextMaterialInput } from "./webMaterials.js";
import type { AgentConfigurationCatalogService } from "../executor/agentConfigurationCatalog.js";
import { effectiveLaunchConfig } from "../executor/effectiveLaunch.js";

export type ConversationItem = Readonly<{
  id: string; turnId: string; kind: "user" | "assistant" | "activity";
  text: string; truncated: boolean; status?: string;
  source?: "yui-input"; messageId?: string;
}>;
type PageQuery = { nativeSessionId: string; cursor?: string };
type Channel = Pick<Awaited<ReturnType<typeof openCodexInteractiveConnection>>, "request" | "notify" | "close">;

/** Disposable read-only attachment to the existing daemon. No resume/start,
 * configuration changes, raw transcripts, reasoning, or automatic full reads.
 * Codex 0.159.2's experimental item pagination is checked at the actual call. */
export async function readCodexConversationPage(
  launch: NativeControlConnection, query: PageQuery,
  connect: (launch: NativeControlConnection) => Promise<Channel> = openCodexInteractiveConnection
) {
  const channel = await connect(launch);
  try {
    const initialized = await channel.request("initialize", codexClientInitialization());
    await channel.notify("initialized");
    if (launch.expectedAccountHome !== undefined
      && (typeof initialized.codexHome !== "string"
        || canonical(initialized.codexHome) !== canonical(launch.expectedAccountHome))) {
      throw new Error("Native account identity differs or cannot be verified.");
    }
    const snapshot = await new CodexAppServerRuntime(channel).readConversation(query.nativeSessionId, { includeTurns: false });
    const page = await channel.request("thread/items/list", {
      threadId: query.nativeSessionId, limit: 40, sortDirection: "desc",
      ...(query.cursor === undefined ? {} : { cursor: query.cursor })
    });
    if (!Array.isArray(page.data) || page.data.length > 40
      || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
      throw new Error("Native item pagination returned an invalid page.");
    }
    const items = page.data.flatMap(entry => {
      if (!entry || typeof entry !== "object" || typeof entry.turnId !== "string") {
        throw new Error("Native item has no exact Turn identity.");
      }
      const item = publicItem(entry.item, entry.turnId);
      return item === null ? [] : [item];
    });
    const thread = snapshot.raw.thread as Record<string, unknown>;
    const status = thread.status as { activeFlags?: unknown[] };
    const waiting = Array.isArray(status?.activeFlags) && status.activeFlags.some(f => f === "waitingOnApproval" || f === "waitingOnUserInput");
    return { nativeSessionId: query.nativeSessionId, status: waiting ? "waiting-user" : snapshot.status,
      activeTurnId: snapshot.activeTurnId ?? null, items, nextCursor: page.nextCursor,
      source: "codex-thread-items" as const, observedAt: new Date().toISOString() };
  } finally { channel.close(); }
}

function canonical(path: string) { try { return realpathSync(path); } catch { return path; } }

function publicItem(value: unknown, turnId: string): ConversationItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string") return null;
  let text: string;
  let kind: ConversationItem["kind"];
  if (item.type === "agentMessage" && typeof item.text === "string") {
    kind = "assistant"; text = item.text;
  } else if (item.type === "userMessage" && Array.isArray(item.content)) {
    kind = "user";
    text = item.content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "collabAgentToolCall"].includes(String(item.type))) {
    kind = "activity";
    text = [item.type, item.command, item.server, item.tool].filter(v => typeof v === "string").join(" · ");
  } else return null;
  // Bound both response and rendering cost. Omitted tool results and reasoning
  // are not details that the browser can accidentally reveal.
  const limit = kind === "activity" ? 1000 : 12000;
  return { id: item.id, turnId, kind, text: text.slice(0, limit), truncated: text.length > limit,
    ...(typeof item.status === "string" ? { status: item.status.slice(0, 100) } : {}) };
}

export function conversationSessions(set: RoleSessionSet | null) {
  if (set === null) return [];
  const history = Object.values(set.history ?? {});
  return [...Object.values(set.sessions), ...history]
    .filter((s, i, all) => all.findIndex(a => a.nativeSessionId === s.nativeSessionId && a.agentId === s.agentId) === i)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(session => ({ nativeSessionId: session.nativeSessionId, agentId: session.agentId,
      adapterId: session.adapterId, title: session.title, status: session.status,
      endReason: session.endReason, createdAt: session.createdAt,
      executionAuthority: session.effective.executionAuthority,
      launchModel: session.effective.model ?? null,
      current: set.sessions[set.activeAgentId] === session,
      conversationEpoch: set.providerBinding?.conversations.find(c => c.conversationId === session.nativeSessionId)?.epoch ?? null }));
}

/** Local-user Web adapter over existing Session, Message and control facts.
 * Browser state and native history never acquire Task business authority. */
export function createWebConversationSurface(
  store: TaskStore, surface: WebTaskSurface,
  plan: (owner: RoleSessionOwner, nativeSessionId: string) => NativeControlConnection,
  readPage: typeof readCodexConversationPage = readCodexConversationPage,
  live?: (owner: RoleSessionOwner) => Promise<AgentHostSnapshot>,
  access?: {
    hasWriter(owner: RoleSessionOwner): boolean;
    respond(owner: RoleSessionOwner, id: string, requestId: string | number, turnId: string | null, result: Record<string, unknown>): Promise<unknown>;
    setModel?(owner: RoleSessionOwner, id: string, model: string): Promise<unknown>;
  },
  catalogs?: Pick<AgentConfigurationCatalogService, "resolve">
) {
  const sessions = (owner: RoleSessionOwner) => {
    if (owner.scope === "task") {
      if (store.getTask(owner.taskId) === null || store.getRole(owner.taskId, owner.roleName) === null) {
        throw new WebRequestRejected("Task Role not found.");
      }
      return store.getTaskRoleSessionSet(owner.taskId, owner.roleName);
    }
    if (store.getGlobalRole(owner.roleName) === null) throw new WebRequestRejected("Global Role not found.");
    return store.getGlobalRoleSessionSet(owner.roleName);
  };
  const select = (owner: RoleSessionOwner, id: string) => {
    const set = sessions(owner);
    const session = [...Object.values(set?.sessions ?? {}), ...Object.values(set?.history ?? {})]
      .find(s => s.nativeSessionId === id);
    if (!session) throw new WebRequestRejected("Session does not belong to this Role.");
    return { set: set!, session };
  };
  const writable = (owner: RoleSessionOwner, id: string) => {
    const chosen = select(owner, id);
    const { set, session } = chosen;
    if (access?.hasWriter(owner)) throw new WebRequestRejected("Terminal owns input. Disconnect it before using conversation input.");
    if (set.sessions[set.activeAgentId] !== session || session.status !== "active") {
      throw new WebRequestRejected("Historical Session is read-only. Select the current Session.");
    }
    if (session.adapterId !== "codex" || set.providerBinding === null) {
      throw new WebRequestRejected("Structured input requires an existing controlled Codex Session.");
    }
    if (owner.scope === "task" && owner.roleName !== "leader") {
      throw new WebRequestRejected("This entry supports Task Leader input; other Roles retain their assignment controls.");
    }
    return chosen;
  };
  const modelWritable = (owner: RoleSessionOwner, id: string) => {
    const chosen = writable(owner, id);
    if (owner.scope === "global" && owner.roleName !== "operator") throw new WebRequestRejected("Model switching supports Operator and Task Leader only.");
    if (owner.scope === "task") {
      const task = store.getTask(owner.taskId)!;
      if (!["active", "draft"].includes(task.status) || task.executionGate.state !== "enabled") {
        throw new WebRequestRejected("Model switching requires an execution-enabled Task.");
      }
    }
    const binding = chosen.set.providerBinding!;
    if (binding.conversations.find(c => c.epoch === binding.currentConversationEpoch)?.conversationId !== id
      || binding.authority.owner !== "controller"
      || binding.run && ["submitting", "accepted", "delivery-unknown"].includes(binding.run.status)) {
      throw new WebRequestRejected("Wait for the current Turn to settle before switching model.");
    }
    return chosen;
  };
  const models = async (owner: RoleSessionOwner, id: string) => {
    const { session } = select(owner, id);
    if (!catalogs || session.adapterId !== "codex") throw new WebRequestRejected("Model catalog is unavailable for this Session.");
    const agent = store.getConfiguredAgent(session.agentId);
    if (!agent) throw new WebRequestRejected("Configured Agent no longer exists.");
    return catalogs.resolve({ agent, cwd: session.effective.workspace.root, config: effectiveLaunchConfig(session.effective) });
  };
  // Native queue input is a reference-only notification, not the user's body.
  // Join only selected-Session inputs named by that exact native notification,
  // with confirmed delivery. Keep native text and label the linked source.
  const linkInputs = (owner: RoleSessionOwner, id: string, items: ConversationItem[]) => {
    let remaining = 48000, count = 0, omitted = false;
    const seen = new Set<string>();
    const linked = items.flatMap(item => {
      if (item.kind !== "user") return [item];
      let messages: Array<{ id: string; body: string; inputControl?: { action: string; expectedSessionId?: string } }> = [];
      if (owner.scope === "task") {
        const ref = /^Yui Task notification: task=([A-Za-z0-9_-]+) wake=([A-Za-z0-9_-]+)\.\nRead current context: /m.exec(item.text);
        if (ref?.[1] === owner.taskId) {
          const wake = store.listTaskWakes(owner.taskId).find(w => w.id === ref[2] && w.status === "consumed");
          const ids = new Set(wake?.refs?.filter(r => r.type === "message").map(r => r.id));
          messages = store.listMessages(owner.taskId).filter(m => ids.has(m.id));
        }
      } else {
        const ref = /^Yui Global Message: role=([A-Za-z0-9_-]+) message=([A-Za-z0-9_-]+)\.\nRead your Session Context/m.exec(item.text);
        if (ref?.[1] === owner.roleName) messages = store.listGlobalRoleMessages(owner.roleName)
          .filter(m => m.id === ref[2] && m.delivery?.via === "provider" && m.deliveryTarget?.nativeSessionId === id);
      }
      const inputs: ConversationItem[] = [];
      for (const message of messages) {
        if (message.inputControl?.action !== "queue" || message.inputControl.expectedSessionId !== id
          || seen.has(message.id)) continue;
        seen.add(message.id);
        if (count >= 40) { omitted = true; continue; }
        const text = message.body.slice(0, Math.min(12000, remaining));
        remaining -= text.length; count++;
        inputs.push({ id: `yui-input:${message.id}`, messageId: message.id, source: "yui-input",
          turnId: item.turnId, kind: "user", text, truncated: text.length < message.body.length });
      }
      return [...inputs.reverse(), item];
    });
    return { items: linked, linkedInputsOmitted: omitted };
  };
  return {
    models,
    async setModel(owner: RoleSessionOwner, id: string, model: string) {
      modelWritable(owner, id);
      if (!access?.setModel) throw new WebRequestRejected("This Host does not support model adoption.");
      const catalog = await models(owner, id);
      if (catalog.source === "fallback" || catalog.failure
        || !catalog.catalog.models.some(choice => choice.value === model)) {
        throw new WebRequestRejected("Select a model from the available native catalog. Discovery failure is not support.");
      }
      // Catalog discovery is asynchronous; preserve exact Session/writer fencing.
      modelWritable(owner, id);
      return access.setModel(owner, id, model);
    },
    async material(owner: RoleSessionOwner, id: string, input: TextMaterialInput) {
      writable(owner, id);
      if (owner.scope !== "task") throw new WebRequestRejected("Text materials require a Task.");
      const task = store.getTask(owner.taskId)!;
      if (["completed", "cancelled", "retired", "archived"].includes(task.status)) {
        throw new WebRequestRejected("Terminal Task materials are read-only.");
      }
      return saveTextMaterial(store.rootDirectory(), owner.taskId, id, input);
    },
    state(owner: RoleSessionOwner, offset = 0) {
      const set = sessions(owner);
      const all = conversationSessions(set);
      const current = set?.sessions[set.activeAgentId];
      const binding = set?.providerBinding;
      const conversation = binding?.conversations.find(c => c.epoch === binding.currentConversationEpoch);
      const exact = conversation?.conversationId === current?.nativeSessionId;
      const questions = owner.scope === "task" && owner.roleName === "leader"
        ? store.listInputRequests(owner.taskId).filter(input => input.status === "open") : [];
      const leaderQuestions = questions.slice(0, 3).filter(question => Buffer.byteLength(JSON.stringify(question)) <= 16000);
      return { owner, sessions: all.slice(offset, offset + 30), total: all.length,
        leaderQuestions, questionsOmitted: questions.length - leaderQuestions.length,
        nextOffset: offset + 30 < all.length ? offset + 30 : null,
        currentSessionId: current?.nativeSessionId ?? null,
        turn: exact ? binding?.run ?? null : null,
        authority: exact ? binding?.authority ?? null : null,
        terminalWriter: access?.hasWriter(owner) ?? false,
        observedAt: new Date().toISOString() };
    },
    async history(owner: RoleSessionOwner, id: string, cursor?: string) {
      const { session } = select(owner, id);
      if (session.adapterId !== "codex") throw new WebRequestRejected("This Agent has no structured conversation reader; use native access.");
      let nativeCursor: string | undefined;
      if (cursor !== undefined) {
        let decoded;
        try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { throw new WebRequestRejected("Invalid history cursor."); }
        if (decoded.id !== id || decoded.owner !== JSON.stringify(owner) || typeof decoded.cursor !== "string") {
          throw new WebRequestRejected("History cursor belongs to another Session.");
        }
        nativeCursor = decoded.cursor;
      }
      const liveRead = cursor === undefined && live !== undefined
        ? live(owner).then(snapshot => snapshot.nativeSessionId === id ? snapshot : undefined).catch(() => undefined)
        : Promise.resolve(undefined);
      const page = await readPage(plan(owner, session.nativeSessionId), {
        nativeSessionId: id, ...(nativeCursor === undefined ? {} : { cursor: nativeCursor })
      });
      const observed = await liveRead;
      const reply = observed?.publicReply;
      const exactReply = reply?.nativeSessionId === id
        && observed?.nativeTurnId === reply.turnId
        && (page.status === "active" || page.status === "waiting-user");
      const items = exactReply && reply
        ? [{ id: reply.id, turnId: reply.turnId, kind: "assistant" as const,
          text: reply.text, truncated: reply.truncated },
          ...page.items.filter(i => i.id !== reply.id || i.turnId !== reply.turnId)]
        : page.items;
      return { ...page, ...linkInputs(owner, id, items), nativeRequests: observed?.nativeRequests ?? [],
        runConfiguration: observed?.runConfiguration ?? null,
        nativeRequestsOmitted: observed?.nativeRequestsOmitted ?? false,
        live: observed?.publicReplyObservation !== "supported" ? "unavailable" : "connected",
        nextCursor: page.nextCursor === null ? null
        : Buffer.from(JSON.stringify({ owner: JSON.stringify(owner), id, cursor: page.nextCursor })).toString("base64url") };
    },
    async control(owner: RoleSessionOwner, id: string, input: {
      action: "queue" | "steer" | "interrupt"; requestId: string; body?: string; expectedTarget?: string;
      materials?: readonly GitArtifactRef[];
    }) {
      writable(owner, id);
      let body = input.body;
      if (input.materials !== undefined) {
        if (owner.scope !== "task" || input.action === "interrupt") throw new WebRequestRejected("Materials require Task text input.");
        try { body = await materialInputBody(store.rootDirectory(), owner.taskId, required(body), input.materials); }
        catch (error) { throw new WebRequestRejected(error instanceof Error ? error.message : "Invalid material."); }
        // Reading blobs is asynchronous: fence again before entering the shared
        // atomic input primitive (which also checks expectedSessionId).
        writable(owner, id);
      }
      const common = { requestId: input.requestId, expectedSessionId: id };
      const control = input.action === "interrupt"
        ? { ...common, action: "interrupt" as const, role: owner.roleName, expectedTarget: required(input.expectedTarget) }
        : input.action === "steer"
          ? { ...common, action: "steer" as const, to: owner.roleName, expectedTarget: required(input.expectedTarget), body: required(body) }
          : { ...common, action: "queue" as const, body: required(body) };
      return owner.scope === "task" ? surface.control(owner.taskId, control) : surface.globalControl(owner.roleName, control);
    },
    async respond(owner: RoleSessionOwner, id: string, requestId: string | number, turnId: string | null, result: Record<string, unknown>) {
      const { set, session } = select(owner, id);
      if (!access || access.hasWriter(owner) || session.status !== "active"
        || set.sessions[set.activeAgentId] !== session || session.adapterId !== "codex"
        || (owner.scope === "task" && (owner.roleName !== "leader"
          || !["active", "draft"].includes(store.getTask(owner.taskId)!.status)
          || store.getTask(owner.taskId)!.executionGate.state !== "enabled"))) {
        throw new WebRequestRejected("Native response requires current writable Session access.");
      }
      return access.respond(owner, id, requestId, turnId, result);
    },
    receipt(owner: RoleSessionOwner, requestId: string) {
      const set = sessions(owner);
      const interrupted = owner.scope === "task" ? findTaskInterrupt(store, owner.taskId, requestId) : undefined;
      const interrupt = owner.scope === "task"
        ? interrupted === undefined ? undefined : taskInterruptReceipt(store, owner.taskId, interrupted.payload.receiptId!) as { state?: string }
        : (set as import("../executor/agentExecutor.js").GlobalRoleSessionSet | null)?.interrupts?.[requestId]?.receipt;
      if (interrupt !== undefined) return { requestId,
        state: interrupt.state === "interrupt-requested" ? "accepted"
          : interrupt.state === "interrupt-not-active" || interrupt.state === "interrupt-unavailable" ? "failed" : "unknown",
        interrupt };
      const messages = owner.scope === "task" ? store.listMessages(owner.taskId) : store.listGlobalRoleMessages(owner.roleName);
      const message = messages.find(m => (m.inputControl ?? m.interruptThen?.reusedInput)?.requestId === requestId);
      // Receipt lookup is deliberately exact and never returns an entire
      // conversation as TaskMessages. A missing record is not failure proof.
      if (!message) return { requestId, state: "unknown", reason: "No saved input found; do not automatically resend." };
      const raw = message as typeof message & { delivery?: { via: string }; notDelivered?: unknown; continuation?: { notDeliveredReason?: string } };
      let state = message.control?.outcome === "accepted" ? "accepted"
        : message.control?.outcome === "rejected" || raw.notDelivered || raw.continuation?.notDeliveredReason ? "failed"
          : message.control ? "unknown" : raw.delivery?.via === "provider" ? "accepted" : raw.delivery ? "unknown"
            : message.inputControl?.action === "steer" ? "failed" : "submitted";
      if (owner.scope === "task" && message.inputControl?.action === "queue") {
        const wake = store.listTaskWakes(owner.taskId).find(w => w.refs?.some(r => r.type === "message" && r.id === message.id));
        if (wake?.status === "consumed") state = "accepted";
        else if (wake) {
          const delivery = store.listEventsByType(owner.taskId, ["notification.delivery"])
            .filter(e => typeof e.payload.attemptId === "string"
              && e.payload.attemptId.startsWith(`notification:${owner.taskId}/${wake.id}/`)).at(-1);
          if (delivery?.payload.outcome === "accepted") state = "accepted";
          else if (delivery?.payload.outcome === "rejected") state = "failed";
          else if (delivery?.payload.outcome === "unknown") state = "unknown";
        }
      }
      return { requestId, messageId: message.id, state, control: message.control,
        delivery: raw.delivery, notDelivered: raw.notDelivered ?? raw.continuation?.notDeliveredReason };
    }
  };
}

function required(value: string | undefined): string {
  if (!value?.trim()) throw new WebRequestRejected("Input text or exact Turn target is missing.");
  return value;
}
