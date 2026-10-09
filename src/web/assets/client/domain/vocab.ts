import { AGENT_ADAPTER_CATALOG } from "../../../../agent/adapterCatalog.js";
import { AGENT_EXECUTION_COMPONENT_CATALOG } from "../../../../agent/executionComponents.js";

export const VOCAB_SCRIPT = String.raw`
// Domain vocabulary: translated labels, semantic tones and the status badges
// built from them. Unknown values stay visible verbatim, never hidden or
// guessed.
import { h } from "/assets/js/lib/dom.js";
import { badge, chip } from "/assets/js/ui/primitives.js";

// Generated from the server catalogs, not a second product registry.
const adapterLabels = ${JSON.stringify(Object.fromEntries(AGENT_ADAPTER_CATALOG.map(({ id, label }) => [id, label])))};
const componentLabels = ${JSON.stringify(Object.fromEntries(AGENT_EXECUTION_COMPONENT_CATALOG.map(({ id, label }) => [id, label])))};
export function agentLabel(component, adapterId) {
  return component ? componentLabels[component] || component : adapterLabels[adapterId] || adapterId;
}

export function label(t, prefix, value) {
  if (value === undefined || value === null || value === "") return "—";
  return t(prefix + "." + value, String(value).replace(/[-_]/g, " "));
}

const TONES = {
  task: { draft: "warn", active: "info", completed: "ok", cancelled: "idle", archived: "idle" },
  exec: {
    "needs-leader-action": "accent", "waiting-on-agents": "info", "waiting-user": "warn",
    recovering: "warn", attention: "bad", "progressing-with-attention": "warn", blocked: "bad",
    conflicted: "warn", working: "info", completed: "ok", retired: "idle", cancelled: "idle",
    accepted: "ok", open: "info", archived: "idle"
  },
  run: { active: "info", completed: "ok", failed: "bad" },
  work: { open: "info", accepted: "ok", retired: "idle" },
  review: { pending: "idle", running: "info", completed: "ok", failed: "bad" },
  job: { queued: "idle", running: "info", succeeded: "ok", failed: "bad", "timed-out": "bad",
    cancelled: "idle", "unknown-needs-attention": "warn" },
  session: { active: "ok", waiting: "warn", quiet: "idle", diagnostic: "bad", unknown: "idle",
    stopped: "bad", idle: "idle", background: "warn" },
  role: { running: "ok", waiting: "warn", idle: "idle", unknown: "idle", failed: "bad", exited: "idle", detached: "idle" },
  decision: { active: "ok", superseded: "idle" },
  input: { open: "warn", answered: "ok", cancelled: "idle", "auto-resolved": "ok" },
  integration: { running: "info", validating: "info", committed: "ok", conflicted: "warn", blocked: "bad",
    failed: "bad", superseded: "idle" }
};
export function tone(kind, value) {
  return (TONES[kind] && TONES[kind][value]) || "idle";
}

export function statusBadge(t, kind, prefix, value) {
  const element = badge(label(t, prefix, value), tone(kind, value), { dot: true });
  element.dataset.status = value;
  return element;
}

// Native Session groups in display order, and one badge per non-empty group.
export const SESSION_GROUPS = ["active", "waiting", "background", "quiet", "diagnostic", "stopped", "unknown", "idle"];
export function sessionBadges(counts, t) {
  return SESSION_GROUPS.filter(function (group) { return counts && counts[group]; }).map(function (group) {
    return badge(counts[group] + " " + t("session." + group), tone("session", group), { dot: true });
  });
}

export function agentChips(agent) {
  if (!agent) return null;
  const chips = [];
  if (agent.adapterId || agent.component) chips.push(chip(agentLabel(agent.component, agent.adapterId), "chip-strong"));
  if (agent.model) chips.push(chip(agent.model));
  if (agent.effort) chips.push(chip(agent.effort));
  return chips.length ? h("span.chip-row", null, chips) : null;
}
`;
