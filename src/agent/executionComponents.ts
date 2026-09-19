/**
 * Which execution component runs an Agent, stated independently from how Yui
 * reaches it.
 *
 * Yui's adapter id answers one question: the connection plan — the protocol
 * Yui speaks and the transport it speaks over. It deliberately does not answer
 * "which product is running", because several distinct products are reachable
 * through the same plan. The Agent Client Protocol is the clear case: Claude
 * Code's CLI, the Claude Agent SDK bridge and any other ACP Agent all arrive
 * over `acp`, and treating that protocol name as a product identity makes them
 * indistinguishable in registration, display, Role bindings and Session
 * snapshots.
 *
 * So the component is its own axis. Every component names exactly one
 * connection plan it is reachable through, and that mapping is one-way and
 * total: the component determines the plan, never the reverse. There is still
 * exactly one authoritative binding to write, so the two facts cannot drift
 * into disagreement, and no arbitrary component/protocol combination graph
 * exists to be assembled.
 *
 * Naming follows the component that actually executes — a CLI or an SDK — and
 * never "native", which names no product.
 */

import { isAgentAdapterId, type AgentAdapterId } from "./adapterCatalog.js";

export type AgentExecutionComponentId =
  | "codex-cli"
  | "claude-code-cli"
  | "claude-agent-sdk"
  | "unknown-acp-agent";

export type AgentExecutionComponentKind = "cli" | "sdk" | "unknown";

export type AgentExecutionComponentEntry = Readonly<{
  id: AgentExecutionComponentId;
  label: string;
  /** The one connection plan this component is reached through. */
  adapterId: AgentAdapterId;
  kind: AgentExecutionComponentKind;
  /**
   * Whether Yui can name this product from a stored binding alone. False for
   * the generic entry, which exists precisely to record that Yui does not know.
   */
  identified: boolean;
  /** Known unattended mode; absence forbids guessing authority from a mode name. */
  bypassPermissionMode?: string;
}>;

export const AGENT_EXECUTION_COMPONENT_CATALOG:
  readonly AgentExecutionComponentEntry[] = Object.freeze([
    Object.freeze({
      id: "codex-cli",
      label: "Codex CLI",
      adapterId: "codex",
      kind: "cli",
      identified: true
    } as const),
    // Claude Code's own CLI, driven over its stream-json interface. This is a
    // different access implementation from the SDK bridge below: different
    // executable, different startup, different authentication surface and a
    // different set of settings Yui can express. Neither one's configuration
    // may be assumed to work for the other.
    Object.freeze({
      id: "claude-code-cli",
      label: "Claude Code CLI",
      adapterId: "claude",
      kind: "cli",
      identified: true
    } as const),
    // The Claude Agent SDK reached through an ACP bridge process. It speaks the
    // protocol Yui already implements, so it needs no product branch in the
    // codec — only its own identity here, so an operator can see and select it.
    Object.freeze({
      id: "claude-agent-sdk",
      label: "Claude Agent SDK (ACP)",
      adapterId: "acp",
      kind: "sdk",
      identified: true,
      // The bridge exposes Claude Code's own permission modes, where
      // `bypassPermissions` is the documented mode that skips approval
      // prompts. The bridge offers it only when its own preconditions hold, so
      // its presence in a Session's option list is still checked rather than
      // assumed.
      bypassPermissionMode: "bypassPermissions"
    } as const),
    // Every other ACP Agent, and every binding made before components were
    // recorded. Yui does not know which product answers, and a command string
    // is not evidence: an executable named `claude-agent-acp` may be a wrapper,
    // a shim or something else entirely. Guessing a product here would attach a
    // confident label to an unverified fact, so the honest value is this one.
    // It states no bypass mode for the same reason: not knowing the product
    // means not knowing which of its modes, if any, grants that authority.
    Object.freeze({
      id: "unknown-acp-agent",
      label: "ACP Agent (unidentified)",
      adapterId: "acp",
      kind: "unknown",
      identified: false
    } as const)
  ]);

/**
 * The component recorded when a connection plan is selected without naming one.
 *
 * A plan with a single possible component resolves to it. The ACP plan carries
 * many products, so it resolves to the unidentified entry rather than to
 * whichever product happens to be most common.
 */
const DEFAULT_COMPONENT_BY_ADAPTER:
  Readonly<Record<AgentAdapterId, AgentExecutionComponentId>> = Object.freeze({
    codex: "codex-cli",
    claude: "claude-code-cli",
    acp: "unknown-acp-agent"
  });

export function supportedAgentExecutionComponentIds(): AgentExecutionComponentId[] {
  return AGENT_EXECUTION_COMPONENT_CATALOG.map(({ id }) => id).sort();
}

export function isAgentExecutionComponentId(
  value: unknown
): value is AgentExecutionComponentId {
  return AGENT_EXECUTION_COMPONENT_CATALOG.some(({ id }) => id === value);
}

export function agentExecutionComponent(
  componentId: AgentExecutionComponentId
): AgentExecutionComponentEntry {
  const entry = AGENT_EXECUTION_COMPONENT_CATALOG.find(({ id }) => id === componentId);
  if (entry === undefined) {
    throw new Error(`Agent execution component is unsupported: ${componentId}.`);
  }
  return entry;
}

/**
 * The component's display label, falling back to the raw id.
 *
 * As with adapters, a stored binding may name a component this build no longer
 * ships; showing that id is more useful than hiding it.
 */
export function agentExecutionComponentLabel(componentId: string): string {
  return AGENT_EXECUTION_COMPONENT_CATALOG.find(({ id }) => id === componentId)?.label
    ?? componentId;
}

/** The connection plan a component is reached through. */
export function adapterIdForExecutionComponent(
  componentId: AgentExecutionComponentId
): AgentAdapterId {
  return agentExecutionComponent(componentId).adapterId;
}

/** Components reachable through one connection plan, in catalog order. */
export function executionComponentsForAdapter(
  adapterId: AgentAdapterId
): readonly AgentExecutionComponentEntry[] {
  return AGENT_EXECUTION_COMPONENT_CATALOG.filter((entry) => entry.adapterId === adapterId);
}

export function defaultExecutionComponentForAdapter(
  adapterId: AgentAdapterId
): AgentExecutionComponentId {
  return DEFAULT_COMPONENT_BY_ADAPTER[adapterId];
}

/**
 * The component to show for a record that was parsed rather than constructed.
 *
 * Display surfaces read values back over the wire, where neither field is
 * guaranteed to be a value this build knows. Refusing to render is the wrong
 * answer there, so this never throws: a recognised component wins, an absent
 * one falls back to its plan's default, and anything unrecognised is shown
 * verbatim rather than replaced with a guess.
 */
export function displayExecutionComponent(
  adapterId: string,
  componentId: string | undefined
): string {
  if (componentId !== undefined) return componentId;
  return isAgentAdapterId(adapterId)
    ? defaultExecutionComponentForAdapter(adapterId)
    : adapterId;
}

/**
 * Resolve the component for a connection plan, given what the caller stated.
 *
 * Creation may name only a connection plan. Resolve its default before
 * persistence; current stored Agents and bindings require an explicit component.
 * ACP defaults to the unidentified entry, never a product inferred from command,
 * arguments or environment.
 */
export function resolveAgentExecutionComponent(
  adapterId: AgentAdapterId,
  componentId: string | undefined
): AgentExecutionComponentId {
  if (componentId === undefined) return defaultExecutionComponentForAdapter(adapterId);
  if (!isAgentExecutionComponentId(componentId)) {
    throw new Error(`Agent execution component is unsupported: ${componentId}.`);
  }
  const expected = adapterIdForExecutionComponent(componentId);
  if (expected !== adapterId) {
    throw new Error(
      `Agent execution component ${componentId} is reached over the ${expected} `
      + `connection plan, not ${adapterId}.`
    );
  }
  return componentId;
}
