import type { TrustedCallContext } from "../kernel/callAuthority.js";
import type {
  CapabilityDescriptor, CapabilityRegistry, CapabilityResult
} from "../kernel/capabilityRegistry.js";
import type { ImplementationRef } from "../kernel/instanceHost.js";
import type { AccessAssessment } from "../kernel/accessAssessment.js";

/** Presentation data only. No entrypoint, HTML, script, activation or instance
 * ownership: T09 owns extension packaging and activation. */
export type SurfacePanelDescriptor =
  | Readonly<{ kind: "text"; title: string; text: string }>
  | Readonly<{ kind: "link"; title: string; href: string }>
  | Readonly<{ kind: "data"; title: string; renderer: "json" }>;
export type SurfaceDescriptors = Readonly<{
  cli?: Readonly<{ name: string; help: string }>;
  panel?: SurfacePanelDescriptor;
}>;
export type SurfaceContributionRef = Readonly<{
  capability: string;
  contractVersion: string;
  provider: ImplementationRef;
}>;
export type SurfaceCommandContribution = SurfaceContributionRef & Readonly<{
  name: string;
  help: string;
  effect: CapabilityDescriptor["effect"];
  unavailable?: string;
  access?: AccessAssessment;
}>;
export type SurfacePanelContribution = SurfaceContributionRef & Readonly<{
  panel: SurfacePanelDescriptor;
  inputSchema: CapabilityDescriptor["inputSchema"];
  unavailable?: string;
}>;

/** A fresh authorized view, not a second directory or instance ledger.
 * Capabilities naturally contribute CLI commands; queries also get the known
 * JSON renderer unless the provider supplies a controlled panel descriptor. */
export class SurfaceContributions {
  constructor(private readonly registry: CapabilityRegistry) {}

  listCommands(context: TrustedCallContext): readonly SurfaceCommandContribution[] {
    return this.registry.search(context).map((entry) => ({
      ...reference(entry), name: entry.surfaces?.cli?.name ?? entry.name,
      help: entry.surfaces?.cli?.help ?? entry.summary, effect: entry.effect,
      ...(entry.access === undefined ? {} : { access: entry.access }),
      ...(entry.unavailable === undefined ? {} : { unavailable: entry.unavailable })
    }));
  }

  listPanels(context: TrustedCallContext): readonly SurfacePanelContribution[] {
    return this.registry.search(context).flatMap((entry) => {
      if (entry.access?.state === "requestable") return [];
      const panel: SurfacePanelDescriptor | undefined = entry.surfaces?.panel
        ?? (entry.effect === "query" ? { kind: "data", title: entry.summary, renderer: "json" } : undefined);
      return panel ? [{
        ...reference(entry), panel, inputSchema: entry.inputSchema,
        ...(entry.unavailable === undefined ? {} : { unavailable: entry.unavailable })
      }] : [];
    });
  }

  /** Query entry used by the Controller-owned Web server. Resolve the current
   * descriptor and exact generation again; the browser never supplies code. */
  readPanel(context: TrustedCallContext, selected: SurfaceContributionRef, input: unknown): Promise<CapabilityResult> {
    const resolved = this.registry.describe(context, {
      name: selected.capability, contractVersion: selected.contractVersion, providerId: selected.provider.id
    });
    if (resolved.kind !== "value") return Promise.resolve(resolved);
    const descriptor = resolved.value as CapabilityDescriptor;
    if (descriptor.provider.generation !== selected.provider.generation || descriptor.effect !== "query") {
      return Promise.resolve({ kind:"unavailable", effect:"none", operations:[],
        detail:"Panel changed or is not a query. Reload current panels." });
    }
    const panel = descriptor.surfaces?.panel;
    if (panel !== undefined && panel.kind !== "data") return Promise.resolve({ ...resolved, value: panel });
    return this.registry.call(context, {
      name: descriptor.name, contractVersion: descriptor.contractVersion,
      providerId: descriptor.provider.id, input
    });
  }
}

/** Called before a complete capability generation is published. Restrict the
 * entire accepted shape so unchecked HTML or executable fields cannot sneak
 * into the browser's descriptor payload. */
export function checkSurfaceDescriptors(entry: CapabilityDescriptor): void {
  if (entry.surfaces === undefined) return;
  const surfaces = record(entry.surfaces, ["cli", "panel"]);
  if (surfaces.cli !== undefined) {
    const cli = record(surfaces.cli, ["name", "help"]);
    // Command names are the capability's existing namespace, not root commands
    // or a second alias-resolution policy.
    if (cli.name !== entry.name || !text(cli.help)) throw new Error("Invalid CLI contribution.");
  }
  if (surfaces.panel !== undefined) {
    const panel = record(surfaces.panel, ["kind", "title", "text", "href", "renderer"]);
    if (!text(panel.title)) throw new Error("Invalid panel title.");
    switch (panel.kind) {
      case "text":
        record(panel, ["kind", "title", "text"]);
        if (typeof panel.text !== "string") throw new Error("Invalid text panel.");
        break;
      case "link": {
        record(panel, ["kind", "title", "href"]);
        if (!text(panel.href)) throw new Error("Invalid link panel.");
        const url = new URL(panel.href);
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
          throw new Error("Panel links require an HTTP(S) URL without credentials.");
        }
        break;
      }
      case "data":
        record(panel, ["kind", "title", "renderer"]);
        if (entry.effect !== "query" || panel.renderer !== "json") throw new Error("Invalid data panel.");
        break;
      default: throw new Error("Unknown panel kind.");
    }
  }
}

function reference(entry: CapabilityDescriptor): SurfaceContributionRef {
  return { capability: entry.name, contractVersion: entry.contractVersion, provider: entry.provider };
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid surface descriptor.");
  return value as Record<string, unknown>;
}
