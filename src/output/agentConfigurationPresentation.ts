import {
  agentModelOptionsSummary, type ResolvedAgentConfigurationCatalog
} from "../executor/agentConfigurationCatalog.js";
import { renderAgentConfigurationResolutionNotice } from "../cli/agentConfigurationPicker.js";
import { agentHandshakeLine } from "./agentRunConfigurationPresentation.js";
import { defaultTableWidth, renderTable } from "./table.js";

export function renderAgentConfigurationCatalog(
  resolved: ResolvedAgentConfigurationCatalog
): string {
  const { catalog } = resolved;
  const version = catalog.cliVersion === undefined ? "" : ` ${catalog.cliVersion}`;
  const modelRows = catalog.models.map((model) => [
    model.label,
    model.isDefault ? "default" : "",
    model.efforts.map((effort) => effort.value).join(", ") || "not configurable",
    model.defaultEffort ?? "",
    model.serviceTiers?.map((tier) => tier.value).join(", ") || "none reported"
  ]);
  const fieldRows = catalog.fields
    .filter((field) => modelRows.length === 0 || (field.key !== "model" && field.key !== "effort"))
    .map((field) => [
      field.key,
      field.choices.map((choice) => choice.value).join(", ") || "none reported",
      // An available field can still carry a reason, and for ACP it always does:
      // the values are enumerated per Session, so the probe deliberately lists
      // none. Dropping that sentence left "none reported" looking like a failed
      // query rather than a deliberate boundary, so it is shown either way.
      field.available === false
        ? `unavailable${field.reason === undefined ? "" : `: ${field.reason}`}`
        : field.reason === undefined ? "available" : `available: ${field.reason}`,
      field.allowCustom ? "yes" : "no"
    ]);
  const sections = [
    modelRows.length === 0
      ? "No runtime models were reported."
      : renderTable(
          `Agent capabilities: ${catalog.agentId} (${catalog.adapterId}${version})`,
          [
            { header: "Model", minWidth: 12, maxWidth: 34 },
            { header: "Default", minWidth: 7, maxWidth: 8 },
            { header: "Efforts", minWidth: 12, maxWidth: 44 },
            { header: "Default effort", minWidth: 14, maxWidth: 18 },
            { header: "Service tiers", minWidth: 13, maxWidth: 24 }
          ],
          modelRows,
          defaultTableWidth()
        ),
    agentModelOptionsSummary(catalog),
    ...(fieldRows.length === 0
      ? []
      : [renderTable(
          "Other runtime configuration",
          [
            { header: "Field", minWidth: 12, maxWidth: 30 },
            { header: "Values", minWidth: 18, maxWidth: 58 },
            { header: "Status", minWidth: 10, maxWidth: 38 },
            { header: "Custom", minWidth: 6, maxWidth: 8 }
          ],
          fieldRows,
          defaultTableWidth()
        )])
  ];
  return `${sections.join("\n\n")}\n${agentHandshakeLine(catalog.handshake)}\n${
    renderAgentConfigurationResolutionNotice(resolved)
  }`;
}
