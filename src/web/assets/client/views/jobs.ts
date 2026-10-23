export const JOBS_SCRIPT = String.raw`
import { h, icon } from "/assets/js/lib/dom.js";
import { formatDateTime } from "/assets/js/lib/format.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";
import { badge, dot } from "/assets/js/ui/primitives.js";
import { drawArtifact } from "/assets/js/views/task/files.js";

// Job definition, Schedule and JobRun are three separate facts and are shown
// as such: a Schedule's on/off state is planning intent, a Run's status is one
// execution, and neither borrows Task lifecycle words.
const SCHEDULE_TONE = { enabled: "ok", disabled: "idle", completed: "idle", "needs-attention": "warn", retired: "idle" };
const RUN_TONE = { queued: "idle", running: "info", succeeded: "ok", failed: "bad", "timed-out": "bad",
  cancelled: "idle", "unknown-needs-attention": "warn" };

// A lossless editor for a deliberately small subset, not a scheduler. Anything
// else remains an exact expression, validated by the existing server parser.
export function cronFields(expression) {
  const p = String(expression).trim().split(/\s+/);
  if (p.length !== 5 || !/^\d{1,2}$/.test(p[0]) || !/^\d{1,2}$/.test(p[1])
    || +p[0] > 59 || +p[1] > 23 || p[3] !== "*") return null;
  const time = p[1].padStart(2, "0") + ":" + p[0].padStart(2, "0");
  if (p[2] === "*" && p[4] === "*") return { frequency: "daily", time };
  if (p[2] === "*" && /^[0-6](,[0-6])*$/.test(p[4]))
    return { frequency: "weekly", time, days: p[4].split(",") };
  if (/^\d{1,2}$/.test(p[2]) && +p[2] >= 1 && +p[2] <= 31 && p[4] === "*")
    return { frequency: "monthly", time, day: +p[2] };
  return null;
}
export function cronExpression(fields) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(fields.time)) throw new Error("cronTime");
  const [hour, minute] = fields.time.split(":").map(Number);
  if (fields.frequency === "daily") return minute + " " + hour + " * * *";
  if (fields.frequency === "weekly" && fields.days?.length && fields.days.every(day => /^[0-6]$/.test(String(day))))
    return minute + " " + hour + " * * " + fields.days.join(",");
  if (fields.frequency === "monthly" && Number.isInteger(+fields.day) && +fields.day >= 1 && +fields.day <= 31)
    return minute + " " + hour + " " + fields.day + " * *";
  throw new Error(fields.frequency === "weekly" ? "cronDays" : "cronDay");
}

// The plan state a reader acts on. A builtin Project sync keeps the user's
// on/off preference separate from its eligibility state; show the preference.
export function scheduleState(schedule) {
  if (schedule.builtin && schedule.state !== "needs-attention" && schedule.state !== "retired")
    return schedule.builtin.enabled ? "enabled" : "disabled";
  return schedule.state;
}

// One server-fixed scope (global, or one owning Task). Refresh only reads
// facts; it never admits due work, derives nextDue or replaces a selected
// exact Run with latest.
//   options.index     separate element for the Job index (the Jobs entry);
//                     without it, the index sits beside the detail (Task tab)
//   options.navigate  ({ job }) a reader picked a Job: the caller records it
//                     in history and calls select(); without it the choice
//                     replaces the current URL
//   options.sync      ({ state, text, at }) the last read, shown by the caller
//                     (the Jobs list head); without it the receipt line says it
//   options.notice    one-time explanatory notice (for example a moved link)
//   options.locale    () => locale for absolute times
//   options.pin       ({ job, jobRun, artifact }, step) the view settled on an exact
//                     selection; the caller records it in its own route.
//                     Without it the selection replaces the current URL
// The returned dispose() retires the view: no later read, write receipt or
// timer of a retired view touches the URL or the page that replaced it.
export function mountJobs(root, t, taskId, options = {}) {
  const base = taskId ? "/api/tasks/" + encodeURIComponent(taskId) : "/api/settings";
  const copy = key => t("jobs." + key);
  const receipt = h("p.settings-receipt", { role: "status", "aria-live": "polite" });
  const list = h("div.jobs-list");
  const locale = () => (options.locale ? options.locale() : undefined);
  const when = iso => iso ? formatDateTime(iso, locale()) : null;
  const indexSearch = h("input", { type: "search", autocomplete: "off", spellcheck: "false",
    placeholder: copy("search"), "aria-label": copy("search") });
  const indexCount = h("p.jobs-index-count", { "aria-live": "polite" });
  let filterText = "";
  indexSearch.addEventListener("input", () => { filterText = indexSearch.value.trim().toLowerCase(); drawIndex(); });
  const detail = h("section.jobs-detail", { "aria-label": copy("details") });
  // Job and plan editors open as a modal dialog, like the workbench's new
  // Task: the page under it keeps its place. Escape asks before discarding.
  const editor = h("dialog.dialog.job-dialog", { "aria-label": copy("newJob") });
  const editorReceipt = h("p.settings-receipt.job-dialog-receipt", { role: "status", "aria-live": "polite" });
  editor.addEventListener("cancel", event => {
    event.preventDefault();
    if (!pending && guardDraft()) closeEditor();
  });
  let readFailed = false;
  const editorOpen = () => !!editor.children?.length;
  const showEditor = () => { if (editorOpen() && !editor.open && typeof editor.showModal === "function" && root.isConnected !== false) editor.showModal(); };
  const params = new URLSearchParams(location.search);
  let jobs = [], schedules = [], selected = params.get("job") || undefined,
    selectedRun = params.get("jobRun") || undefined, generation = 0, runGeneration = 0, pending = false, dirty = false,
    disposed = false;
  const artifactState = { reference: parseArtifact(params.get("artifact")) };
  // The exact selection is written only by a live view, and in the Jobs entry
  // only through its owner (which also knows whether Jobs is still shown).
  // step: the reader opened or closed a Run in place; the Jobs entry records
  // it as a history step so Back and Forward walk the Runs read.
  function pinSelection(step = false) {
    if (disposed || (!options.pin && root.isConnected === false)) return;
    const artifact = artifactState.reference ? JSON.stringify(artifactState.reference) : null;
    if (options.pin) { options.pin({ job: selected || null, jobRun: selectedRun || null, artifact }, step); return; }
    const url = new URL(location.href);
    if (selected) url.searchParams.set("job", selected); else url.searchParams.delete("job");
    if (selectedRun) url.searchParams.set("jobRun", selectedRun); else url.searchParams.delete("jobRun");
    if (artifact) url.searchParams.set("artifact", artifact); else url.searchParams.delete("artifact");
    history.replaceState(history.state, "", url);
  }
  const blocked = new Set();
  const read = (family, input) => requestJson(base + "/" + family + "?" + new URLSearchParams(input));
  const button = (text, action, primary = false) => h("button.btn" + (primary ? ".btn-primary" : ""), {
    type: "button", onclick: action
  }, text);
  const json = value => h("pre.settings-observation", null, JSON.stringify(value, null, 2));
  // The exact record stays one disclosure away: an advanced, copyable view,
  // never the default body of a section.
  const raw = (name, value) => h("details.job-raw", null, h("summary", null, h("span", null, name),
    h("span.job-raw-hint", null, "JSON")), h("div.job-raw-body", null,
      h("div.job-raw-tools", null, copyButton(JSON.stringify(value, null, 2), copy("copyJson"), true)), json(value)));
  const ago = iso => relative(iso, locale());
  // ---- Small readers shared by the detail, the Run panel and the editor ----
  const isEmpty = value => value === undefined || value === null || value === ""
    || (Array.isArray(value) && !value.length) || (isPlain(value) && !Object.keys(value).length);
  // A JSON object, as opposed to a rendered node (DOM, or a test double).
  const isPlain = value => !!value && typeof value === "object" && !Array.isArray(value) && value.nodeType === undefined && !value.spec;
  function relative(iso, loc) {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return "";
    const seconds = (at - Date.now()) / 1000, size = Math.abs(seconds);
    const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    try {
      const format = new Intl.RelativeTimeFormat(loc || undefined, { numeric: "auto", style: "short" });
      const unit = units.find(entry => size >= entry[1]);
      return unit ? format.format(Math.round(seconds / unit[1]), unit[0]) : format.format(Math.round(seconds), "second");
    } catch { return ""; }
  }
  // A copy control never moves focus or selection; a refused clipboard falls
  // back to a prompt the reader can copy from by hand.
  function copyButton(text, name, withText = false) {
    const node = h("button.job-copy" + (withText ? ".job-copy-text" : ""), { type: "button", title: name,
      "aria-label": withText ? null : name, onclick: async event => {
        event.stopPropagation();
        try { await navigator.clipboard.writeText(text); node.classList.add("is-copied"); node.title = copy("copied");
          setTimeout(() => { node.classList.remove("is-copied"); node.title = name; }, 1400); }
        catch { window.prompt(copy("copyManual"), text); }
      } }, icon("copy"), withText ? h("span", null, name) : null);
    return node;
  }
  function shortId(id) {
    const value = String(id ?? "");
    return value.length > 22 ? value.slice(0, 12) + "…" + value.slice(-6) : value;
  }
  function idChip(id, copyable = true) {
    if (!id) return "—";
    return h("span.job-id", null, h("code.id", { title: String(id) }, shortId(id)),
      copyable ? copyButton(String(id), copy("copy") + " · " + id) : null);
  }
  function stamp(iso) {
    if (!iso) return "—";
    return h("time.job-time", { dateTime: iso, title: iso }, when(iso), h("span.job-time-ago", null, ago(iso)));
  }
  function duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return null;
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return minutes + "m " + Math.round((ms % 60000) / 1000) + "s";
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? hours + "h " + (minutes % 60) + "m" : Math.floor(hours / 24) + "d " + (hours % 24) + "h";
  }
  function runSpan(run) {
    const start = Date.parse(run.startedAt || run.attempts?.[0]?.createdAt || run.createdAt);
    const end = Date.parse(run.terminalAt || run.finishedAt || "");
    return Number.isFinite(start) && Number.isFinite(end) ? end - start : null;
  }
  // A plain period in the reader's language ("6 小时", "6 hours").
  function period(ms) {
    const units = [["day", 86400000], ["hour", 3600000], ["minute", 60000], ["second", 1000]];
    const unit = units.find(([, size]) => ms >= size && ms % size === 0) || ["millisecond", 1];
    try { return new Intl.NumberFormat(locale() || undefined, { style: "unit", unit: unit[0], unitDisplay: "long" }).format(ms / unit[1]); }
    catch { return ms + " ms"; }
  }
  function kvList(rows, className = "") {
    const items = rows.filter(Boolean);
    return h("dl.job-kv" + className, null, items.map(([name, value]) => h("div.job-kv-row", null,
      h("dt", null, name), h("dd", null, isEmpty(value) || value === "—" ? h("span.job-empty", null, "—") : isPlain(value) ? valueView(value) : value))));
  }
  function section(title, body, extra) {
    return h("section.job-section", null, h("header.job-section-head", null, h("h4", null, title), extra || null), body);
  }
  // Any JSON value, readable: scalars inline, arrays as lists, objects as
  // nested label/value rows. Nothing is dropped; deep nesting folds.
  function valueView(value, depth = 0) {
    if (value === null || value === undefined) return h("span.job-empty", null, "null");
    if (typeof value === "boolean") return h("code.job-bool", null, String(value));
    if (typeof value === "number") return h("code", null, String(value));
    if (typeof value === "string") return value === "" ? h("span.job-empty", null, copy("cfg.emptyText"))
      : value.length > 80 || value.includes("\n") ? h("pre.job-prose", null, value) : h("span.job-text", null, value);
    if (Array.isArray(value)) {
      if (!value.length) return h("span.job-empty", null, copy("cfg.emptyList"));
      if (value.every(item => item === null || typeof item !== "object"))
        return h("span.job-chips", null, value.map(item => h("code.job-chip", null, String(item))));
      return h("ol.job-list", null, value.map(item => h("li", null, valueView(item, depth + 1))));
    }
    const keys = Object.keys(value);
    if (!keys.length) return h("span.job-empty", null, copy("cfg.noParams"));
    const rows = keys.map(key => [h("code.job-key", null, key), valueView(value[key], depth + 1)]);
    if (depth < 2) return kvList(rows, ".is-nested");
    return h("details.job-fold", null, h("summary", null, fill(copy("cfg.fields"), { count: keys.length })), kvList(rows, ".is-nested"));
  }
  function envView(env) {
    const keys = env && typeof env === "object" ? Object.keys(env) : [];
    if (!keys.length) return h("span.job-empty", null, copy("cfg.noEnv"));
    return h("span.job-chips", null, keys.map(key => h("code.job-chip", { title: key + "=" + env[key] },
      h("span.job-chip-key", null, key), "=", String(env[key]))));
  }
  // Friendly names for the documented nested fields; anything else keeps its key.
  const FIELD = { title: "name", description: "cfg.description", projectBindings: "cfg.bindings", taskId: "cfg.task",
    workItemId: "cfg.workItem", roleName: "cfg.role", agentId: "cfg.agent", ownerRunId: "cfg.ownerRun",
    revision: "revision", type: "type", integrationAttemptId: "cfg.attempt" };
  function fieldRows(object, skip = []) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return [[copy("cfg.value"), valueView(object)]];
    return Object.keys(object).filter(key => !skip.includes(key)).map(key => [FIELD[key] ? copy(FIELD[key]) : h("code.job-key", null, key),
      key === "taskId" && typeof object[key] === "string" ? h("a", { href: "/?task=" + encodeURIComponent(object[key]) }, object[key])
        : valueView(object[key], 1)]);
  }
  function stepsView(steps) {
    if (!Array.isArray(steps)) return section(copy("steps"), valueView(steps));
    return section(copy("steps") + " · " + steps.length, h("ol.job-steps", null, steps.map((step, index) => {
      const s = step && typeof step === "object" ? step : { command: String(step) };
      const known = ["name", "command", "timeoutMs", "cwd", "env", "argv"];
      const extra = Object.keys(s).filter(key => !known.includes(key));
      const chips = [
        s.timeoutMs !== undefined ? h("span.job-tag", null, copy("cfg.timeout") + " " + (Number.isFinite(s.timeoutMs) ? period(s.timeoutMs) : String(s.timeoutMs))) : null,
        s.cwd ? h("span.job-tag", { title: s.cwd }, copy("cfg.cwd") + " " + s.cwd) : null,
        s.argv ? h("span.job-tag", null, "argv · " + (Array.isArray(s.argv) ? s.argv.length : "?")) : null
      ].filter(Boolean);
      return h("li.job-step", null,
        h("div.job-step-head", null, h("span.job-step-index", null, String(index + 1)),
          h("code.job-step-name", null, s.name || copy("cfg.unnamed")), chips),
        s.command !== undefined ? h("div.job-command", null, h("pre", null, String(s.command)), copyButton(String(s.command), copy("copyCommand"))) : null,
        s.env && !isEmpty(s.env) ? h("div.job-step-env", null, h("span.job-step-label", null, copy("cfg.env")), envView(s.env)) : null,
        s.argv && !isEmpty(s.argv) ? h("div.job-step-env", null, h("span.job-step-label", null, "argv"), valueView(s.argv)) : null,
        extra.length ? kvList(extra.map(key => [h("code.job-key", null, key), valueView(s[key], 1)]), ".is-nested") : null);
    })));
  }
  // The configuration as a reader needs it: per-type names and key fields
  // first, steps and parameters grouped, unknown fields kept.
  // lifted: the description is already shown above it (see purpose()).
  function configView(config, lifted = false) {
    const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
    const used = new Set(["kind"]);
    const has = key => Object.prototype.hasOwnProperty.call(c, key);
    const take = key => { used.add(key); return c[key]; };
    const rows = [[copy("executor"), h("span.job-kind", null, label("jobs.kind", c.kind))]];
    const blocks = [];
    if (c.kind === "builtin") {
      rows.push([copy("action"), label("jobs.action", take("action"))]);
      if (has("projectId")) rows.push([copy("project"), take("projectId")]);
      if (has("input")) { const value = take("input"); if (!isEmpty(value)) rows.push([copy("cfg.input"), valueView(value)]); }
    } else if (c.kind === "shell") {
      if (has("projectId")) rows.push([copy("project"), take("projectId")]);
      if (has("owner")) rows.push([copy("cfg.owner"), ownerText(take("owner"))]);
      if (has("workspace")) rows.push([copy("cfg.workspace"), c.workspace ? h("span.job-path", null, h("code", { title: c.workspace }, take("workspace")),
        copyButton(String(c.workspace), copy("copy"))) : take("workspace")]);
      if (has("head")) rows.push([copy("cfg.head"), c.head ? idChip(take("head")) : take("head")]);
      if (has("env")) rows.push([copy("cfg.env"), envView(take("env"))]);
      if (has("steps")) blocks.push(stepsView(take("steps")));
      if (has("files")) blocks.push(section(copy("form.scripts"), take("files").map(file =>
        h("details.job-raw", null, h("summary", null, file.path), h("div.job-command", null, h("pre", null, file.content))))));
    } else if (c.kind === "task") {
      if (has("goal")) rows.push([copy("cfg.goal"), label("jobs.goal", take("goal"))]);
      if (has("target")) {
        const target = take("target");
        rows.push([copy("cfg.target"), label("jobs.target", target?.kind)], ...fieldRows(target, lifted ? ["kind", "description"] : ["kind"]));
      }
    } else if (c.kind === "agent") {
      if (has("target")) {
        const target = take("target");
        rows.push([copy("cfg.target"), label("jobs.target", target?.kind)], ...fieldRows(target, ["kind"]));
      }
      if (has("concurrency")) rows.push([copy("cfg.concurrency"), label("jobs.concurrency", take("concurrency"))]);
      if (has("input") && lifted && typeof c.input === "string") take("input");
      else if (has("input")) blocks.push(section(copy("cfg.agentInput"), typeof c.input === "string"
        ? h("div.job-command.is-prose", null, h("pre", null, take("input") || "—"), copyButton(String(c.input), copy("copy")))
        : valueView(take("input"))));
    }
    const rest = Object.keys(c).filter(key => !used.has(key));
    if (rest.length) blocks.push(section(copy("cfg.other"), kvList(rest.map(key => [h("code.job-key", null, key), valueView(c[key], 1)]))));
    return h("div.job-config", null, kvList(rows), blocks);
  }
  function ownerText(owner) {
    if (!owner || typeof owner !== "object") return valueView(owner);
    if (owner.kind === "task") return copy("cfg.ownerTask");
    if (owner.kind === "work-item") return h("span", null, "WorkItem ", h("code", null, String(owner.workItemId ?? "—")));
    return valueView(owner);
  }
  function stepBadge(step) {
    const tone = step.timedOut ? "bad" : step.exitCode === 0 ? "ok" : step.signal ? "warn" : step.exitCode === null || step.exitCode === undefined ? "idle" : "bad";
    const name = step.timedOut ? label("job", "timed-out") : step.exitCode === 0 ? label("job", "succeeded")
      : step.signal ? String(step.signal) : step.exitCode === null || step.exitCode === undefined ? "—" : label("job", "failed");
    return badge(name, tone, { dot: true });
  }
  // Schedule rules in words when they are simple; the exact rule stays visible.
  function ruleText(rule) {
    if (!rule) return "—";
    if (rule.kind === "interval") return fill(copy("ruleEvery"), { period: period(Number(rule.everyMs)) });
    if (rule.kind === "once") return fill(copy("ruleOnce"), { at: when(rule.at) || "—" });
    const visual = cronFields(rule.expression);
    if (visual?.frequency === "monthly") return fill(copy("form.monthRule"), { day: visual.day, time: visual.time });
    const parts = String(rule.expression || "").trim().split(/\s+/);
    if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1]) && parts[2] === "*" && parts[3] === "*") {
      const time = parts[1].padStart(2, "0") + ":" + parts[0].padStart(2, "0");
      if (parts[4] === "*") return fill(copy("ruleDaily"), { time });
      if (/^[0-7](?:-[0-7])?(?:,[0-7](?:-[0-7])?)*$/.test(parts[4])) {
        const values = parts[4].split(",").flatMap(part => {
          const [first, last = first] = part.split("-").map(Number);
          return last >= first ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [];
        });
        if (!values.length) return copy("form.customCron");
        const days = [...new Set(values.map(day => day % 7))].map(day => {
          try { return new Intl.DateTimeFormat(locale() || undefined, { weekday: "short", timeZone: "UTC" })
            .format(new Date(Date.UTC(2026, 9, 18 + (Number(day) % 7)))); } catch { return day; }
        });
        return fill(copy("ruleWeekly"), { days: days.join(" "), time });
      }
    }
    return copy("form.customCron");
  }
  function field(name, control) { return h("label.field", null, h("span", null, name), control); }
  function input(value = "", attrs = {}) { return h("input", { value, ...attrs }); }
  function choose(values, value, name = v => v) {
    const node = h("select", null, values.map(v => h("option", { value: v }, name(v))));
    node.value = value || values[0]; return node;
  }
  function guardDraft() { return !dirty || window.confirm(copy("discard")); }
  function closeEditor() {
    if (editor.open && typeof editor.close === "function") editor.close();
    editor.replaceChildren(); dirty = false; root.dataset.unsent = "false";
  }
  function status(text, error = false) {
    const node = editorOpen() ? editorReceipt : receipt;
    node.textContent = text; node.classList.toggle("settings-error", error);
  }
  // The routine read state (loading, last read, stale) belongs to the caller's
  // sync indicator when it has one; a failure also stays on the page.
  function observe(state, text) {
    if (!options.sync) { status(text, state === "error"); return; }
    options.sync({ state, text, at: state === "ok" ? new Date().toISOString() : null });
    if (state === "error") { readFailed = true; status(text, true); }
  }
  async function mutate(family, payload, after) {
    const key = base + "/" + family + "/" + payload.id;
    if (pending || blocked.has(key)) { status(copy("unknown"), true); return; }
    pending = true;
    root.dataset.reading = "true";
    const controls = [...root.querySelectorAll("button,input,select,textarea")];
    const disabled = controls.map(node => node.disabled);
    controls.forEach(node => { node.disabled = true; });
    status(copy("submitting"));
    try {
      const result = await submitMutation(key, base + "/" + family, payload);
      // A retired view's receipt has no page left to update; the shared
      // submission layer still remembers an unresolved write by its key.
      if (disposed) return;
      if (result.status === "saved-unregistered") {
        status(copy("registerHelp") + "\n" + result.error, true);
        await refresh(false);
        return;
      }
      status(payload.op === "run"
        ? (result.reason === "overlap" ? copy("overlap") : copy("admitted")) + " · " + result.run.id + " · " + result.run.status
        : payload.op === "run-cancel" ? copy("cancelRequested") : copy("saved"));
      if (after) after(result);
      await refresh(false);
    } catch (error) {
      if (error.disposition !== "not-submitted") blocked.add(key);
      readFailed = false;
      status(error.message + (blocked.has(key) ? "\n" + copy("unknown") : ""), true);
    } finally {
      pending = false;
      root.dataset.reading = "false";
      controls.forEach((node, index) => { node.disabled = disabled[index]; });
    }
  }
  function form(title, contents, submit, saveButton = h("button.btn.btn-primary", { type: "submit" }, copy("save"))) {
    if (!guardDraft()) return;
    closeEditor();
    receipt.textContent = ""; receipt.classList.toggle("settings-error", false);
    editorReceipt.textContent = ""; editorReceipt.classList.toggle("settings-error", false);
    const node = h("form.dialog-body.job-form", null,
      h("header.dialog-head", null, h("div", null, h("h2", null, title),
        h("p.dialog-sub", null, copy("ownerShort") + " · " + (taskId ? copy("ownerTask") + " " + taskId : copy("ownerGlobal")))),
        h("button.icon-btn", { type: "button", title: copy("close"), "aria-label": copy("close"),
          onclick: () => { if (!pending && guardDraft()) closeEditor(); } }, icon("close"))),
      contents, editorReceipt,
      h("div.dialog-actions", null, button(copy("close"), () => { if (!pending && guardDraft()) closeEditor(); }),
        saveButton));
    const markDirty = () => { dirty = true; root.dataset.unsent = "true"; clearEditorError(); };
    node.addEventListener("input", markDirty);
    node.addEventListener("change", markDirty);
    node.addEventListener("submit", event => {
      event.preventDefault();
      try { submit(); } catch (error) { status(error.message, true); }
    });
    editor.setAttribute?.("aria-label", title);
    editor.append(node);
    showEditor();
    node.querySelector("input:not([disabled]),select:not([disabled]),textarea")?.focus();
  }
  function clearEditorError() {
    editorReceipt.textContent = ""; editorReceipt.classList.toggle("settings-error", false);
  }
  function editJob(job) {
    const id = input(job?.id || newId("job"), { required: true, pattern: "[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", disabled: !!job });
    const title = input(job?.title || "", { required: true });
    const kind = choose(taskId ? ["shell", "task", "agent"] : ["shell", "builtin", "task", "agent"], job?.configuration.kind, v => label("jobs.kind", v));
    const newDefinitionId = newId("job");
    const kindNotice = h("p.job-note", { role: "status", "aria-live": "polite" });
    const saveButton = h("button.btn.btn-primary", { type: "submit" });
    const changesKind = () => !!job && kind.value !== job.configuration.kind;
    const seeds = {
      builtin: { kind: "builtin", action: "system.noop", input: {} },
      shell: taskId ? { kind: "shell", owner: { kind: "task" }, projectId: "", head: "", workspace: "", env: {},
        steps: [{ name: "check", command: "" }] } : { kind: "shell", env: {}, files: [], steps: [{ name: "run", command: "" }] },
      task: { kind: "task", goal: "delivery", target: { kind: "new", title: "", description: "", projectBindings: [] } },
      agent: { kind: "agent", target: { kind: "job", agentId: "" }, input: "", concurrency: "serial" }
    };
    const drafts = new Map();
    const configured = h("div.job-field-stack");
    let active;
    function selectKind() {
      active = drafts.get(kind.value);
      if (!active) {
        const original = job?.configuration.kind === kind.value ? job.configuration : seeds[kind.value];
        active = configurationForm(original);
        drafts.set(kind.value, active);
      }
      // Keep each type's actual controls, including invalid drafts, when switching.
      configured.replaceChildren(active.node);
      kindNotice.textContent = changesKind() ? copy("kindCopyHelp") : "";
      kindNotice.hidden = !changesKind();
      saveButton.textContent = changesKind() ? copy("saveAsNew") : copy("save");
    }
    kind.addEventListener("change", selectKind); selectKind();
    form(job ? copy("editJob") : copy("newJob"), [
      h("div.job-field-grid", null, field(copy("name"), title), field(copy("executor"), kind)),
      kindNotice,
      configured,
      h("p.job-note", null, copy("taskConfig"))
    ], () => {
      const update = !!job && !changesKind();
      void mutate("jobs", { op: update ? "update" : "define", id: changesKind() ? newDefinitionId : id.value.trim(), title: title.value.trim(),
        configuration: active.read(), ...(update ? { expectedRevision: job.revision } : {}) }, result => {
        selected = result.id; selectedRun = undefined; pinSelection(); closeEditor();
      });
    }, saveButton);
  }
  // Explicit field editors patch a clone of the original, never reconstruct a
  // saved configuration from only the visible keys. Optional untouched fields
  // keep their exact presence/value. Backend validation remains authoritative.
  function configurationForm(original) {
    const c = JSON.parse(JSON.stringify(original));
    const node = h("div.job-field-stack"), readers = [];
    function text(target, key, name, options = {}) {
      const control = options.multiline ? h("textarea", { rows: 4, required: options.required })
        : input(target[key] ?? "", { required: options.required, ...(options.number ? { type: "number", min: 1, step: 1 } : {}) });
      if (options.multiline) control.value = target[key] ?? "";
      let touched = false;
      control.addEventListener("input", () => { touched = true; });
      readers.push(() => {
        if (!touched) return;
        if (!options.required && control.value === "") { delete target[key]; return; }
        if (options.number && (!Number.isSafeInteger(+control.value) || +control.value < 1))
          throw new Error(name + ": " + copy("form.positiveInteger"));
        target[key] = options.number ? +control.value : control.value;
      });
      return field(name, control);
    }
    function collection(items, create, draw, addLabel, commit) {
      const list = h("div.job-field-stack"), rows = [];
      function add(item, focus = false) {
        const edit = draw(item);
        const row = h("div.job-edit-row", null, edit.node, button(copy("form.remove"), () => {
          rows.splice(rows.indexOf(record), 1); row.remove(); dirty = true; root.dataset.unsent = "true";
        }));
        const record = { row, read: edit.read }; rows.push(record); list.append(row);
        if (focus) row.querySelector("input,textarea")?.focus();
      }
      items.forEach(item => add(item));
      readers.push(() => commit(rows.map(row => row.read())));
      return h("div.job-field-stack", null, list, button(addLabel, () => {
        add(create(), true); dirty = true; root.dataset.unsent = "true";
      }));
    }
    function environment(target) {
      const existing = target.env;
      return collection(Object.entries(existing || {}), () => ["", ""], ([key, value]) => {
        const name = input(key, { required: true }), val = input(value);
        return { node: h("div.job-field-grid", null, field(copy("form.envName"), name), field(copy("form.envValue"), val)),
          read: () => [name.value, val.value] };
      }, copy("form.addEnv"), entries => {
        if (entries.some(([name], index) => !name || entries.findIndex(e => e[0] === name) !== index))
          throw new Error(copy("form.duplicateEnv"));
        if (existing !== undefined || entries.length) target.env = Object.fromEntries(entries);
      });
    }
    function stepForm(step) {
      const nested = configurationForm({ kind: "_step", ...step });
      return { node: nested.node, read: () => { const value = nested.read(); delete value.kind; return value; } };
    }
    if (c.kind === "builtin") {
      const action = choose(["system.noop", "project.refresh"], c.action, v => label("jobs.action", v));
      const project = text(c, "projectId", copy("project"));
      const sync = () => { project.hidden = action.value !== "project.refresh"; };
      action.addEventListener("change", sync); sync();
      readers.push(() => { c.action = action.value; });
      node.append(field(copy("action"), action), project, h("p.job-note", null, copy("rebind")));
      if (!isEmpty(c.input)) node.append(section(copy("cfg.input"), valueView(c.input)), h("p.job-note", null, copy("form.unchanged")));
    } else if (c.kind === "shell") {
      if (taskId) node.append(h("div.job-field-grid", null, text(c, "projectId", copy("project"), { required: true }),
        text(c, "workspace", copy("cfg.workspace"), { required: true }), text(c, "head", "HEAD", { required: true })));
      else node.append(h("p.job-note", null, copy("form.shellHome")));
      if (taskId) node.append(section(copy("cfg.env"), environment(c)));
      node.append(section(copy("steps"), collection(c.steps || [], () => ({ name: "", command: "" }), stepForm, copy("form.addStep"), steps => {
          if (!steps.length) throw new Error(copy("form.needStep")); c.steps = steps;
        })));
      if (!taskId) node.append(section(copy("form.scripts"), collection(c.files || [], () => ({ path: "scripts/run.sh", content: "" }), file => {
        const path = input(file.path, { required: true, placeholder: "scripts/run.sh" });
        const content = h("textarea", { rows: 8, spellcheck: "false" }); content.value = file.content;
        return { node: h("div.job-field-stack", null, field(copy("form.scriptPath"), path), field(copy("form.scriptContent"), content)),
          read: () => ({ path: path.value.trim(), content: content.value }) };
      }, copy("form.addScript"), files => { c.files = files; })));
      if (!taskId) node.append(h("details.job-raw", null, h("summary", null, copy("cfg.env")), environment(c)));
    } else if (c.kind === "_step") {
      node.append(text(c, "name", copy("name"), { required: true }),
        text(c, "command", copy("form.command"), { required: true, multiline: true }));
      if (taskId) node.append(
        h("div.job-field-grid", null, text(c, "timeoutMs", copy("form.timeout"), { number: true }), text(c, "cwd", copy("cfg.cwd"))),
        environment(c));
      else node.append(h("details.job-raw", null, h("summary", null, copy("form.stepOptions")),
        text(c, "timeoutMs", copy("form.timeout"), { number: true }), environment(c)));
      if (c.argv) node.append(h("p.job-note", null, copy("form.argvHelp")),
        collection(c.argv, () => "", value => {
          const control = input(value);
          return { node: field("argv", control), read: () => control.value };
        }, copy("form.addArgument"), values => { c.argv = values; }));
    } else if (c.kind === "task" || c.kind === "agent") {
      const isTask = c.kind === "task";
      const targetKind = choose(isTask ? ["new", "work-item"] : ["job", "operator", "task"], c.target.kind, v => copy("form." + v));
      const targetDrafts = new Map(), targetArea = h("div.job-field-stack");
      let targetEdit, currentTarget;
      function drawTarget() {
        currentTarget = targetKind.value;
        if (!targetDrafts.has(currentTarget)) {
          const seed = c.target.kind === currentTarget ? c.target
            : currentTarget === "new" ? { kind: "new", title: "", description: "", projectBindings: [] }
            : currentTarget === "work-item" ? { kind: "work-item", taskId: taskId || "", workItemId: "", revision: 1 }
            : currentTarget === "job" ? { kind: "job", agentId: "" }
            : currentTarget === "task" ? { kind: "task", taskId: taskId || "", roleName: "leader" } : { kind: "operator" };
          targetDrafts.set(currentTarget, configurationForm({ ...seed, kind: "_target", targetKind: seed.kind }));
        }
        targetEdit = targetDrafts.get(currentTarget); targetArea.replaceChildren(targetEdit.node);
        if (isTask) goalField.hidden = currentTarget === "work-item";
        else concurrencyField.hidden = currentTarget !== "job";
      }
      const goal = choose(["delivery", "task-created"], c.goal === "work-item" ? "delivery" : c.goal, v => copy("form." + v));
      const goalField = field(copy("form.goal"), goal);
      const concurrency = choose(["serial", "isolated"], c.concurrency || "serial", v => copy("form." + v));
      const concurrencyField = field(copy("form.concurrency"), concurrency);
      targetKind.addEventListener("change", drawTarget); drawTarget();
      readers.push(() => {
        const value = targetEdit.read(); delete value.targetKind; value.kind = currentTarget; c.target = value;
        if (isTask) c.goal = currentTarget === "work-item" ? "work-item" : goal.value;
        else if (c.concurrency !== undefined || concurrency.value !== "serial") c.concurrency = currentTarget === "job" ? concurrency.value : "serial";
      });
      node.append(field(copy("form.target"), targetKind), targetArea, isTask ? goalField : concurrencyField);
      if (!isTask) node.append(text(c, "input", copy("cfg.agentInput"), { required: true, multiline: true }));
    } else if (c.kind === "_target") {
      if (c.targetKind === "new") node.append(text(c, "title", copy("name"), { required: true }),
        text(c, "description", copy("cfg.description"), { required: true, multiline: true }), text(c, "type", copy("type")),
        section(copy("cfg.bindings"), collection(c.projectBindings, () => ({ projectId: "", directory: "", baseRef: "" }), binding => {
          const nested = configurationForm({ kind: "_binding", ...binding });
          return { node: nested.node, read: () => { const b = nested.read(); delete b.kind; return b; } };
        }, copy("form.addBinding"), values => { c.projectBindings = values; })));
      if (c.targetKind === "work-item" || c.targetKind === "task") node.append(text(c, "taskId", copy("cfg.task"), { required: true }));
      if (c.targetKind === "work-item") node.append(text(c, "workItemId", copy("cfg.workItem"), { required: true }),
        text(c, "revision", copy("revision"), { required: true, number: true }));
      if (c.targetKind === "task") node.append(text(c, "roleName", copy("cfg.role"), { required: true }), text(c, "ownerRunId", copy("cfg.ownerRun")));
      if (c.targetKind === "job") node.append(text(c, "agentId", copy("cfg.agent"), { required: true }));
    } else if (c.kind === "_binding") {
      node.append(h("div.job-field-grid", null, text(c, "projectId", copy("project"), { required: true }),
        text(c, "directory", copy("form.directory"), { required: true }), text(c, "baseRef", copy("form.baseRef"))));
    }
    return { node, read: () => { readers.forEach(read => read()); return JSON.parse(JSON.stringify(c)); } };
  }
  function editSchedule(schedule) {
    const boundJob = jobs.find(j => j.id === (schedule?.jobId || selected));
    const id = input(schedule?.id || newId("plan"), { required: true, disabled: !!schedule,
      pattern: "[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}" });
    const kind = choose(schedule?.builtin ? ["interval", "cron"] : ["cron", "interval", "once"], schedule?.rule.kind || "cron",
      value => copy("form." + value));
    const rule = schedule?.rule;
    const at = input(rule?.at || rule?.anchor || new Date().toISOString());
    const every = input(String(rule?.everyMs || 3600000), { type: "number", min: schedule?.builtin ? 60000 : 1000, step: 1 });
    const expression = input(rule?.expression || "0 9 * * *", { placeholder: "0 9 * * *", spellcheck: "false", autocomplete: "off" });
    const timezone = rule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const parsed = cronFields(expression.value);
    const mode = choose(["daily", "weekly", "monthly", "advanced"], parsed?.frequency || "advanced", value => copy("form." + (value === "advanced" ? "customCron" : value)));
    const time = input(parsed?.time || "09:00", { type: "text", placeholder: "HH:mm",
      pattern: "([01][0-9]|2[0-3]):[0-5][0-9]", maxlength: 5, inputmode: "text", autocomplete: "off" });
    const day = input(String(parsed?.day || 1), { type: "number", min: 1, max: 31, step: 1 });
    // Retain original weekday order (and the complete expression until edited).
    let days = parsed?.days?.slice() || ["1"], visualChanged = false;
    const weekdays = h("div.job-weekdays", { role: "group", "aria-label": copy("form.weekdays") });
    const weekdayButtons = [1, 2, 3, 4, 5, 6, 0].map(n => {
      const name = new Intl.DateTimeFormat(locale() || undefined, { weekday: "short", timeZone: "UTC" })
        .format(new Date(Date.UTC(2026, 9, 18 + n)));
      const b = button(name, () => {
        const value = String(n); days = days.includes(value) ? days.filter(d => d !== value) : [...days, value];
        b.setAttribute("aria-pressed", String(days.includes(value)));
        visualChanged = true; dirty = true; root.dataset.unsent = "true"; clearEditorError(); updateSummary();
      });
      b.setAttribute("aria-pressed", String(days.includes(String(n)))); weekdays.append(b); return b;
    });
    const when = field(copy("instant"), at), interval = field(copy(schedule?.builtin ? "syncEvery" : "every"), every);
    const quickTimes = h("div.job-time-shortcuts", { role: "group", "aria-label": copy("form.quickTime") },
      ["09:00", "12:00", "18:00"].map(value => button(value, () => {
        time.value = value; visualChanged = true; dirty = true; root.dataset.unsent = "true";
        clearEditorError(); updateSummary(); time.focus?.();
      })));
    const clock = h("div.job-field-stack.job-clock", null, field(copy("form.time24"), time), quickTimes);
    const month = h("div.job-field-stack", null, field(copy("form.day"), day), h("p.job-note", null, copy("form.monthHelp")));
    const guide = h("dl.job-cron-guide");
    const exact = h("div.job-field-stack", null, field(copy("cron"), expression), guide,
      h("p.job-note", null, copy("form.cronSymbols")));
    const summary = h("div.job-rule-preview", { "aria-live": "polite" });
    function expressionValue() {
      if (mode.value === "advanced") {
        if (!expression.value.trim()) throw new Error(copy("form.cronRequired"));
        return expression.value;
      }
      if (!visualChanged) return expression.value;
      try { return cronExpression({ frequency: mode.value, time: time.value, day: +day.value, days }); }
      catch (error) { throw new Error(copy("form." + error.message)); }
    }
    function updateSummary() {
      const parts = expression.value.trim().split(/\s+/);
      guide.replaceChildren(...["minute", "hour", "date", "month", "weekday"].map((name, i) =>
        h("div", null, h("dt", null, copy("form.cron." + name)), h("dd", null,
          h("code", null, parts[i] || "—"), h("span", null, copy("form.cron." + name + "Range"))))));
      try {
        const value = expressionValue(), description = ruleText({ kind: "cron", expression: value, timezone });
        summary.hidden = mode.value === "advanced" && description === copy("form.customCron");
        summary.replaceChildren(...(mode.value === "advanced" ? [] : [h("code", null, value)]), h("span", null, description));
        summary.classList.toggle("is-error", false);
      } catch (error) {
        summary.hidden = false;
        summary.replaceChildren(error.message); summary.classList.toggle("is-error", true);
      }
    }
    const cron = h("div.job-field-stack", null, h("div.job-field-grid", null, field(copy("form.frequency"), mode), clock),
      weekdays, month, exact, summary);
    const sync = () => {
      when.hidden = kind.value === "cron"; interval.hidden = kind.value !== "interval";
      cron.hidden = kind.value !== "cron"; at.required = !when.hidden; every.required = !interval.hidden;
      time.required = !cron.hidden && mode.value !== "advanced";
      clock.hidden = mode.value === "advanced"; weekdays.hidden = mode.value !== "weekly";
      month.hidden = mode.value !== "monthly"; exact.hidden = mode.value !== "advanced";
      day.required = !cron.hidden && !month.hidden; expression.required = !cron.hidden && !exact.hidden;
      at.disabled = when.hidden; every.disabled = interval.hidden;
      time.disabled = cron.hidden || clock.hidden; day.disabled = cron.hidden || month.hidden;
      expression.disabled = cron.hidden || exact.hidden;
      updateSummary();
    };
    let previousMode = mode.value;
    mode.addEventListener("change", () => {
      if (mode.value === "advanced") {
        const chosen = mode.value; mode.value = previousMode;
        try { expression.value = expressionValue(); }
        // The incomplete visual draft remains in its controls. Let the user
        // write a rule instead; never invent weekdays or reuse a stale rule.
        catch { expression.value = ""; }
        mode.value = chosen;
      } else {
        const value = cronFields(expression.value);
        if (previousMode === "advanced" && expression.value.trim() && !value && !window.confirm(copy("form.replaceComplex"))) {
          mode.value = previousMode; return;
        }
        if (previousMode === "advanced" && value) {
          time.value = value.time; day.value = String(value.day || 1); days = value.days || ["1"];
          weekdayButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(days.includes(String([1, 2, 3, 4, 5, 6, 0][i])))));
        }
        visualChanged = true;
      }
      previousMode = mode.value; clearEditorError(); sync();
    });
    [time, day].forEach(control => control.addEventListener("input", () => { visualChanged = true; updateSummary(); }));
    expression.addEventListener("input", updateSummary);
    kind.addEventListener("change", sync); sync();
    form(schedule ? copy("editSchedule") : copy("newSchedule"),
      [h("p.job-bound-target", null, copy("form.forJob"), h("strong", null, boundJob?.title || schedule?.jobId || selected)),
        field(copy("rule"), kind), h("div.job-field-grid", null, when, interval), cron,
        h("p.job-note", null, copy("scheduleHelp"))], () => {
      const rule = kind.value === "once" ? { kind: "once", at: at.value }
        : kind.value === "interval" ? { kind: "interval", anchor: at.value, everyMs: Number(every.value) }
        : { kind: "cron", expression: expressionValue(), timezone };
      void mutate("schedules", { op: schedule ? "update" : "create", id: id.value.trim(), rule,
        ...(schedule?.builtin ? {} : { jobId: schedule?.jobId || selected, ...(!taskId ? { authorization: "service" } : {}) }),
        ...(schedule ? { expectedRevision: schedule.revision } : {}) }, closeEditor);
    });
  }
  function newId(prefix) {
    // getRandomValues is also available on the authorized HTTP LAN preview.
    const suffix = crypto.randomUUID ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
    return prefix + "-" + suffix;
  }
  async function showRun(jobId, runId, target) {
    const epoch = ++runGeneration;
    // An artifact belongs to one Run; picking another Run drops it.
    if (selectedRun !== runId) artifactState.reference = null;
    selectedRun = runId;
    pinSelection();
    detail.querySelectorAll(".job-run-row").forEach(row => row.setAttribute("aria-current", String(row.dataset.run === runId)));
    target.replaceChildren(h("p.job-loading", null, copy("loading")));
    try {
      const run = await read("jobs", { op: "run-get", id: jobId, runId });
      if (epoch !== runGeneration || selected !== jobId || selectedRun !== runId) return;
      const evidence = h("section.job-run-evidence"), artifacts = h("section.job-run-artifacts"), session = h("section");
      const steps = run.result?.steps || [];
      const exit = run.result ? [run.result.exitCode === null || run.result.exitCode === undefined ? null : String(run.result.exitCode),
        run.result.signal].filter(Boolean).join(" · ") : null;
      const cancel = ["queued", "running", "unknown-needs-attention"].includes(run.status) ? button(copy("cancelRun"), () => {
        if (window.confirm(copy("cancelBoundary") + "\n" + runId))
          void mutate("jobs", { op: "run-cancel", id: jobId, runId });
      }) : null;
      const reason = run.result?.unknownReason;
      target.replaceChildren(h("div.job-run-panel", null,
        h("header.job-run-head", null, h("div.job-run-title", null, h("h4", null, copy("runDetail")), idChip(run.id), runBadge(run.status)),
          h("div.job-badges", null, cancel, h("button.icon-btn.job-run-close", { type: "button", title: copy("closeRun"),
            "aria-label": copy("closeRun"), onclick: () => closeRun(target, true) }, icon("close")))),
        run.businessResult ? h("p.job-result.tone-" + (RUN_TONE[run.status] || "idle"), null,
          h("span.job-result-label", null, copy("result")), run.businessResult.summary) : null,
        reason && reason !== run.businessResult?.summary ? h("p.job-result.tone-warn", null, reason) : null,
        run.delegation ? h("a.btn", { href: "/?task=" + encodeURIComponent(run.delegation.taskId) },
          copy("executionTask") + " · " + run.delegation.taskId) : null,
        kvList([
          [copy("trigger"), h("span", null, label("trigger", run.trigger.source), " ", h("code.id", { title: run.trigger.key }, shortId(run.trigger.key)))],
          [copy("executor"), label("jobs.kind", run.executor || (run.delegation ? "task" : "process"))],
          [copy("created"), stamp(run.createdAt)],
          run.startedAt ? [copy("started"), stamp(run.startedAt)] : null,
          [copy("finished"), stamp(run.terminalAt)],
          [copy("duration"), duration(runSpan(run))],
          exit ? [copy("exit"), h("code", null, exit)] : null,
          run.result?.failedStep ? [copy("failedStep"), h("code", null, run.result.failedStep)] : null,
          run.cancelRequestedAt ? [copy("cancelRequested"), stamp(run.cancelRequestedAt)] : null,
          run.retryOf ? [copy("retryOf"), h("code.id", { title: run.retryOf }, shortId(run.retryOf))] : null,
          run.definitionRevision ? [copy("revision"), String(run.definitionRevision)] : null
        ]),
        steps.length ? h("section.job-section", null, h("h5.job-section-title", null, copy("steps") + " · " + steps.length),
          h("ol.job-run-steps", null, steps.map(step => h("li.job-run-step", null,
            stepBadge(step), h("code.job-run-step-name", null, step.name), h("span.job-run-step-meta", null,
              [duration(step.durationMs), step.exitCode !== null && step.exitCode !== undefined ? "exit " + step.exitCode : step.signal]
                .filter(Boolean).join(" · ")))))) : null,
        evidence, artifacts, session,
        h("div.job-advanced", null, run.businessResult ? raw(copy("result"), run.businessResult) : null, raw(copy("snapshot"), run))));
      drawArtifacts(artifacts, jobId, run, epoch);
      if (run.executor === "agent" && run.configuration.target.kind === "job") drawSession(session, jobId, runId);
      try {
        const value = await read("jobs", { op: "run-evidence", id: jobId, runId });
        if (epoch !== runGeneration) return;
        if (run.executor !== "agent" && !run.delegation) {
          const logs = await read("jobs", { op: "logs", id: jobId, runId });
          if (epoch !== runGeneration) return;
          const failed = run.result?.failedStep;
          evidence.append(h("h5.job-section-title", null, copy("logs")), logs.length ? h("div.job-logs", null, logs.map((log, i) => h("details.job-log", {
            open: log.step === failed || (!failed && i === logs.length - 1 && run.status !== "succeeded") }, h("summary", null,
              h("code", null, log.step), log.truncated ? h("span.job-raw-hint", null, copy("truncated")) : null),
            h("pre.job-log-text", null, log.text)))) : h("p.job-note", null, copy("noLogs")));
        }
        evidence.append(raw(copy("diagnostics"), value));
      } catch (error) { if (epoch === runGeneration) evidence.append(h("p.settings-error", null, copy("diagnostics") + ": " + error.message)); }
    } catch (error) { if (epoch === runGeneration) target.replaceChildren(h("p.settings-error", null, error.message)); }
  }
  function closeRun(target, focusRow = false) {
    const closed = selectedRun;
    runGeneration++;
    selectedRun = undefined; artifactState.reference = null;
    pinSelection(focusRow);
    target.replaceChildren();
    placeRun(focusRow ? closed : null);
  }
  function drawArtifacts(target, jobId, run, epoch) {
    const refs = run.artifacts || [];
    const viewer = h("div.file-viewer");
    const readRef = async (ref, offset = 0) => {
      const value = await read("jobs", { op: "artifact-preview", id: jobId, runId: run.id,
        reference: JSON.stringify(ref), offset: String(offset) });
      return { ...value, relativePath: ref.relativePath, commit: ref.version };
    };
    const select = async (ref, offset = 0) => {
      artifactState.reference = ref;
      pinSelection();
      const key = JSON.stringify(ref);
      viewer.replaceChildren(h("p", null, copy("loading")));
      try {
        const value = await readRef(ref, offset);
        if (epoch !== runGeneration || JSON.stringify(artifactState.reference) !== key) return;
        drawArtifact(viewer, value, JSON.stringify(ref.owner), t, {
          compare: false,
          readArtifact: async (_owner, path, commit, page) => {
            const exact = refs.find(r => r.relativePath === path && r.version === commit
              && JSON.stringify(r.owner) === JSON.stringify(ref.owner));
            if (!exact) throw new Error(copy("registeredOnly"));
            return readRef(exact, page);
          }
        }, (_path, _commit, page) => void select(ref, page), artifactState);
      } catch (error) { if (epoch === runGeneration && JSON.stringify(artifactState.reference) === key)
        viewer.replaceChildren(h("p.settings-error", null, error.message)); }
    };
    target.append(...[h("h5.job-section-title", null, copy("artifacts") + " · " + refs.length),
      refs.length ? h("p.job-note", null, copy("registeredOnly")) : null,
      refs.length ? h("div.job-artifact-list", null, refs.map(ref => button(ref.relativePath + " · " + ref.version.slice(0, 12), () => void select(ref)))) : null,
      viewer].filter(Boolean));
    if (artifactState.reference && refs.some(ref => JSON.stringify(ref) === JSON.stringify(artifactState.reference)))
      void select(artifactState.reference);
    const recovery = h("div");
    target.append(h("button.btn.btn-ghost.job-inline-action", { type: "button", onclick: async () => {
      recovery.replaceChildren();
      try {
        const result = await read("jobs", { op: "artifact-list", id: jobId, runId: run.id });
        const missing = result.repository.saved.filter(ref => !result.artifacts.some(r => JSON.stringify(r) === JSON.stringify(ref)));
        recovery.append(raw(copy("artifacts"), result), h("p", null, copy("registerHelp")),
          ...missing.map(ref => button(copy("register") + " · " + ref.relativePath, () => {
            if (window.confirm(copy("registerHelp") + "\n" + ref.version))
              void mutate("jobs", { op: "artifact-register", id: jobId, runId: run.id, reference: ref });
          })));
      } catch (error) { recovery.append(h("p.settings-error", null, error.message)); }
    } }, copy("inspectSaved")), recovery);
  }
  function drawSession(target, jobId, runId) {
    target.append(button(copy("inspectSession"), async () => {
      try {
        const value = await read("jobs", { op: "session-inspect", id: jobId, runId });
        const set = value.sessions, current = set?.sessions?.[set.activeAgentId];
        target.replaceChildren(raw(copy("inspectSession"), value), h("p", null, copy("sessionBoundary")));
        if (current) target.append(...["session-stop", "session-new"].map(op =>
          button(copy(op === "session-stop" ? "stopSession" : "newSession"), () => {
            if (window.confirm(copy("sessionBoundary") + "\n" + current.nativeSessionId))
              void mutate("jobs", { op, id: jobId, runId, expectedSessionId: current.nativeSessionId });
          })));
      } catch (error) { target.append(h("p.settings-error", null, error.message)); }
    }));
  }
  // Run history filters, in the order a reader scans for trouble.
  const RUN_FILTERS = [["all", null], ["succeeded", ["succeeded"]], ["failed", ["failed"]], ["timed-out", ["timed-out"]],
    ["cancelled", ["cancelled"]], ["active", ["queued", "running"]], ["unknown-needs-attention", ["unknown-needs-attention"]]];
  let runFilter = "all", runLimit = 15, shownJob = null, rowNodes = new Map(), placeRun = () => {};
  // A route-driven Run (deep link, refresh, Back/Forward, run now, a plan's
  // link) is brought into view with its detail once it has loaded.
  let revealRun = !!selectedRun;
  const runPanelId = "job-run-" + Math.random().toString(36).slice(2, 10);
  function runSummary(run) { return run.businessResult?.summary || run.summary || run.result?.unknownReason || ""; }
  function runRow(job, run, panel) {
    const started = run.startedAt || run.createdAt;
    const span = duration(runSpan(run));
    const open = selectedRun === run.id;
    // One control per Run: it opens the detail right under itself, and
    // closes it again. Its expanded state is the single selection.
    return h("button.job-run-row", {
      type: "button", "aria-current": String(open), "aria-expanded": String(open),
      "aria-controls": open ? runPanelId : null, dataset: { run: run.id }, title: run.id,
      onclick: () => { if (selectedRun === run.id) closeRun(panel, true); else void openRun(job.id, run.id, panel); }
    }, h("span.job-run-status", null, runBadge(run.status)),
    h("span.job-run-main", null, h("span.job-run-summary", null, runSummary(run) || label("job", run.status)),
      h("span.job-run-sub", null, h("code", null, shortId(run.id)), h("span", null, label("trigger", run.trigger && run.trigger.source)))),
    h("span.job-run-when", { title: when(started) || "" }, ago(started) || when(started) || "—"),
    h("span.job-run-span", null, span || (["queued", "running"].includes(run.status) ? "…" : "—")),
    h("span.job-run-caret", { "aria-hidden": "true" }, icon("chevron")));
  }
  async function openRun(jobId, runId, panel) {
    const keep = focusedRun();
    selectedRun = runId; artifactState.reference = null;
    pinSelection(true);
    placeRun(keep ? runId : null);
    await showRun(jobId, runId, panel);
    if (selected === jobId && selectedRun === runId) revealSelectedRun(panel, true);
  }
  function focusedRun() {
    const active = typeof document === "undefined" ? null : document.activeElement;
    return active && active.dataset && active.dataset.run && rowNodes.get(active.dataset.run) === active ? active.dataset.run : null;
  }
  // Bring the selected row and as much of its detail as fits into view; the
  // row stays on screen so the list context is never lost.
  function revealSelectedRun(panel, smooth) {
    const row = rowNodes.get(selectedRun);
    if (!row || typeof row.getBoundingClientRect !== "function" || row.isConnected === false) return;
    const top = row.getBoundingClientRect().top, bottom = panel.getBoundingClientRect?.().bottom ?? top;
    const height = typeof window !== "undefined" && window.innerHeight ? window.innerHeight : 0;
    if (top < 64 || (height && (bottom > height || top > height - 80)))
      row.scrollIntoView?.({ block: "start", behavior: smooth ? "smooth" : "auto" });
  }
  function historyView(job, runs, panel) {
    const counts = Object.fromEntries(RUN_FILTERS.map(([key, set]) => [key, set ? runs.filter(r => set.includes(r.status)).length : runs.length]));
    if (!counts[runFilter]) runFilter = "all";
    // A Run chosen by the route (deep link, Back/Forward, a plan's link, Run
    // now) wins over an earlier filter that would hide it: the filter returns
    // to all so the Run opens in place. A filter the reader picks afterwards
    // still closes a Run it hides (see the filter buttons below).
    const routed = selectedRun && runs.find(run => run.id === selectedRun);
    const filterSet = RUN_FILTERS.find(([key]) => key === runFilter)[1];
    if (routed && filterSet && !filterSet.includes(routed.status)) runFilter = "all";
    const body = h("div.job-history-body");
    const visible = () => {
      const set = RUN_FILTERS.find(([key]) => key === runFilter)[1];
      return set ? runs.filter(run => set.includes(run.status)) : runs;
    };
    const draw = focusRun => {
      const shown = visible();
      // The selected Run stays visible even past the page limit, with its
      // detail directly under its row. A selected Run missing from the
      // history read (just admitted, or older than it) opens above the list.
      const index = shown.findIndex(run => run.id === selectedRun);
      const limit = Math.max(runLimit, index + 1);
      rowNodes = new Map();
      const items = [];
      for (const run of shown.slice(0, limit)) {
        const row = runRow(job, run, panel);
        rowNodes.set(run.id, row); items.push(row);
        if (run.id === selectedRun) items.push(panel);
      }
      const orphan = selectedRun && !runs.some(run => run.id === selectedRun);
      body.replaceChildren(h("div.job-runs-head", { "aria-hidden": "true" }, h("span", null, copy("col.status")),
        h("span", null, copy("col.run")), h("span", null, copy("col.started")), h("span", null, copy("duration")), h("span")),
      h("div.jobs-runs", null, orphan ? panel : null, items),
      ...(shown.length > limit ? [h("button.job-more", { type: "button", onclick: () => { runLimit += 30; draw(); } },
        fill(copy("showMore"), { count: shown.length - limit }))] : []));
      if (focusRun) rowNodes.get(focusRun)?.focus?.();
    };
    placeRun = draw;
    const tabs = h("div.chip-tabs.job-filters", { role: "group", "aria-label": copy("filterRuns") },
      RUN_FILTERS.filter(([key]) => key === "all" || counts[key]).map(([key]) => h("button.chip-tab", {
        type: "button", "aria-pressed": String(runFilter === key), dataset: { filter: key },
        onclick: event => { runFilter = key; runLimit = 15;
          for (const tab of tabs.children) tab.setAttribute("aria-pressed", String(tab === event.currentTarget));
          // A filter that hides the open Run closes its detail rather than
          // leaving it detached from any row.
          if (selectedRun && runs.some(run => run.id === selectedRun) && !visible().some(run => run.id === selectedRun)) closeRun(panel);
          else draw(); }
      }, key === "all" ? copy("filter.all") : key === "active" ? copy("filter.active") : label("job", key), h("span.count", null, String(counts[key])))));
    draw();
    return section(copy("history"), runs.length ? h("div.job-history", null, overviewView(job, runs), tabs, body)
      : h("div.job-history", null, selectedRun ? h("div.jobs-runs", null, panel) : null, h("p.job-empty-block", null, copy("noRuns"))),
      h("span.job-section-count", null, fill(copy("runCount"), { count: runs.length })));
  }
  function overviewView(job, runs) {
    const terminal = runs.filter(run => !["queued", "running"].includes(run.status));
    const ok = terminal.filter(run => run.status === "succeeded");
    const spans = ok.map(runSpan).filter(Number.isFinite);
    const recent = runs.slice(0, 30).reverse();
    const latest = runs[0], success = runs.find(run => run.businessResult?.outcome === "succeeded");
    const stat = (name, value, sub) => h("div.job-stat", null, h("span.job-stat-label", null, name),
      h("span.job-stat-value", null, value), sub ? h("span.job-stat-sub", null, sub) : null);
    const runRef = run => run ? h("span.job-stat-run", null, h("code", { title: run.id || run.runId }, shortId(run.id || run.runId)),
      runBadge(run.status), h("span.job-stat-sub", null, ago(run.terminalAt || run.createdAt))) : h("span.job-empty", null, "—");
    const refreshRef = item => item ? h("span.job-stat-run", null, h("code", { title: item.runId || item.id || "" }, shortId(item.runId || item.id || "—")),
      item.status ? runBadge(item.status) : null, h("span.job-stat-sub", null, ago(item.finishedAt || item.terminalAt || item.attemptedAt || item.at || item.createdAt))) : h("span.job-empty", null, "—");
    return h("section.job-overview", { "aria-label": copy("overview") },
      h("div.job-stats", null,
        stat(copy("successRate"), terminal.length ? Math.round(ok.length * 100 / terminal.length) + "%" : "—",
          terminal.length ? ok.length + " / " + terminal.length : null),
        stat(copy("avgDuration"), spans.length ? duration(spans.reduce((a, b) => a + b, 0) / spans.length) : "—"),
        h("div.job-stat", null, h("span.job-stat-label", null, copy("recentRun")), runRef(latest)),
        h("div.job-stat", null, h("span.job-stat-label", null, copy("recentSuccess")), runRef(success)),
        job.refresh ? h("div.job-stat", null, h("span.job-stat-label", null, copy("refreshAttempt")), refreshRef(job.refresh.lastAttempt)) : null,
        job.refresh ? h("div.job-stat", null, h("span.job-stat-label", null, copy("refreshSuccess")), refreshRef(job.refresh.lastSuccessfulRefresh)) : null),
      recent.length ? h("div.job-spark", { role: "img", "aria-label": fill(copy("sparkLabel"), { count: recent.length,
        ok: recent.filter(run => run.status === "succeeded").length }) },
        recent.map(run => h("span.job-spark-bar.tone-" + (RUN_TONE[run.status] || "idle"), { title: label("job", run.status) + " · " + when(run.createdAt) })))
        : null);
  }
  function plansView(job, plans) {
    const items = plans.map(({ schedule: s, lastSuccess }) => {
      const on = s.builtin ? s.builtin.enabled : s.state === "enabled";
      const attempt = s.lastAttempt;
      const routinePause = s.state === "disabled" && (!s.reason
        || s.reason === "Explicitly disabled; no future admission. Existing Runs are unchanged."
        || s.reason === "Project sync disabled by user.");
      return h("li.job-plan", null,
        h("div.job-plan-main", null,
          h("div.job-plan-line", null, scheduleBadge(s), h("strong.job-plan-rule", null, ruleText(s.rule)),
            s.rule?.kind === "cron" ? h("code.job-plan-expression", null, s.rule.expression) : null),
          h("div.job-plan-line.job-plan-sub", null,
            s.state === "enabled" && s.nextDue ? h("span", { title: when(s.nextDue) }, copy("nextShort") + " " + when(s.nextDue) + " · " + ago(s.nextDue)) : null,
            attempt ? h("span", { title: attempt.reason || "" }, copy("lastAttemptShort") + " " + ago(attempt.at) + " · " + label("admission", attempt.outcome)) : null,
            lastSuccess ? h("span", null, copy("lastSuccessShort") + " " + ago(lastSuccess.terminalAt || lastSuccess.updatedAt)) : null),
          s.state === "completed" ? h("p.job-note", null, copy("onceCompleted")) : null,
          routinePause ? h("p.job-note", null, copy("form.paused"))
            : s.reason ? h("p.job-note.is-error", null, s.reason) : null),
        h("div.job-plan-actions", null,
          button(copy(on ? "disable" : "enable"), () => void mutate("schedules", { op: on ? "disable" : "enable", id: s.id, expectedRevision: s.revision })),
          button(copy("editSchedule"), () => editSchedule(s))));
    });
    const add = !job.builtin && !["agent", "task"].includes(job.configuration.kind)
      ? h("button.job-section-action", { type: "button", onclick: () => editSchedule() }, icon("plus"), copy("newSchedule")) : null;
    return section(copy("schedules"), items.length ? h("ul.job-plans", null, items) : h("p.job-empty-block", null, copy("noSchedules")), add);
  }
  // The Job's own description, when its configuration really has one: a
  // delegated Task's description or an Agent's instruction. Never invented.
  function purpose(config) {
    if (config.kind === "task" && typeof config.target?.description === "string" && config.target.description.trim())
      return { name: copy("cfg.description"), text: config.target.description };
    if (config.kind === "agent" && typeof config.input === "string" && config.input.trim())
      return { name: copy("cfg.agentInput"), text: config.input };
    return null;
  }
  async function showDetail(epoch) {
    const job = jobs.find(j => j.id === selected);
    if (!job) {
      detail.replaceChildren(...(selected ? [h("p.settings-error", null, copy("unavailable") + " · " + selected)]
        : jobs.length ? [] : [h("div.job-blank", null, icon("clock", "icon-xl"), h("p", null, copy("empty")))]));
      return;
    }
    const [runs, plans] = await Promise.all([
      read("jobs", { op: "runs", id: job.id }),
      Promise.all(schedules.filter(s => s.jobId === job.id).map(s => read("schedules", { op: "show", id: s.id })))
    ]);
    if (epoch !== generation) return;
    if (shownJob !== job.id) { shownJob = job.id; runFilter = "all"; runLimit = 15; }
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const runDetail = h("div.job-run-inline", { id: runPanelId, role: "region", "aria-label": copy("runDetail") });
    runDetail.addEventListener("keydown", event => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); closeRun(runDetail, true);
    });
    const own = schedules.filter(s => s.jobId === job.id);
    const config = job.configuration || {};
    const about = purpose(config);
    // Scope is named once, by the shell (list head and crumb); the header
    // keeps what identifies this Job.
    // Reading order: what the Job is and does (description, configuration,
    // plans, definition), then how it has run (overview and history).
    detail.replaceChildren(h("article.job-page", null,
      h("header.job-header", null,
        h("div.job-title", null,
          h("h2", null, job.title),
          h("div.job-badges", null, own.length ? own.map(s => scheduleBadge(s)) : badge(copy("noSchedule"), "idle"),
            runs[0] ? runBadge(runs[0].status) : badge(copy("noRunsShort"), "idle"))),
        h("div.job-actions", null,
          !job.builtin ? button(copy("editJob"), () => editJob(job)) : null,
          button(copy("runNow"), () => void mutate("jobs", { op: "run", id: job.id, requestId: crypto.randomUUID() }, result => {
            selectedRun = result.run.id; revealRun = true; pinSelection();
          }), true))),
      h("div.job-about", null,
        h("div.job-primary", null,
          job.builtin ? h("p.job-purpose.is-note", null, copy("builtinSync")) : null,
          about ? section(about.name, h("div.job-purpose", null, h("pre.job-prose", null, about.text),
            copyButton(about.text, copy("copy")))) : null,
          section(copy("configuration"), configView(config, !!about))),
        h("aside.job-aside", null,
          plansView(job, plans),
          job.refresh ? raw(copy("refreshFacts"), job.refresh) : null)),
      historyView(job, runs, runDetail)));
    if (selectedRun) {
      const reveal = revealRun;
      revealRun = false;
      await showRun(job.id, selectedRun, runDetail);
      if (reveal && epoch === generation && selected === job.id) revealSelectedRun(runDetail, false);
    }
  }
  async function refresh(announce = true) {
    const epoch = ++generation;
    if (announce) observe("syncing", copy("loading"));
    try {
      const result = await Promise.all([read("jobs", { op: "list" }), read("schedules", { op: "list" })]);
      if (epoch !== generation) return;
      [jobs, schedules] = result;
      if (!selected && jobs.length) selected = jobs[0].id;
      loaded = true; loadError = null;
      drawIndex();
      await showDetail(epoch);
      if (announce && epoch === generation) {
        // A manual or first read settles the page: an old write receipt
        // (never an unresolved one, which stays blocked) gives way to it.
        if (options.sync && (readFailed || !receipt.classList.contains?.("settings-error"))) status("");
        readFailed = false;
        observe("ok", copy("observed") + " · " + when(new Date().toISOString()));
      }
    } catch (error) {
      if (epoch !== generation) return;
      loadError = error.message;
      drawIndex();
      observe("error", copy("stale") + " " + error.message);
    }
  }
  // The Job index. Its count, search and empty state describe exactly the
  // Jobs of this one scope as returned by its list read; nothing else.
  let loaded = false, loadError = null;
  function pick(job) {
    if (pending || !guardDraft()) return;
    closeEditor();
    if (options.navigate) { options.navigate({ job: job.id }); return; }
    selected = job.id; selectedRun = undefined; pinSelection(); void refresh();
  }
  function matches(job) {
    if (!filterText) return true;
    return [job.title, job.id, job.configuration.action, job.configuration.kind, job.configuration.projectId]
      .some(value => typeof value === "string" && value.toLowerCase().includes(filterText));
  }
  function jobRow(job) {
    const own = schedules.filter(s => s.jobId === job.id);
    const states = own.map(scheduleState);
    const state = states.includes("needs-attention") ? "needs-attention" : states.includes("enabled") ? "enabled"
      : states[0] || null;
    const latest = job.results && job.results.latest;
    const next = own.filter(s => s.state === "enabled" && s.nextDue).map(s => s.nextDue).sort()[0];
    const planText = state ? label("schedule", state) + (next ? " · " + copy("nextShort") + " " + (ago(next) || when(next)) : "") : copy("noSchedule");
    return h("button.job-row", {
      type: "button", dataset: { job: job.id }, "aria-current": String(selected === job.id),
      title: job.title + " · " + job.id, onclick: () => pick(job)
    }, dot(state ? SCHEDULE_TONE[state] || "idle" : "idle", planText),
    h("span.job-row-body", null,
      h("span.job-row-line", null, h("span.job-row-name", null, job.title),
        // Plan (on/off) and the latest Run's status are separate facts, side by side.
        latest ? runBadge(latest.status) : h("span.job-row-none", null, copy("noRunsShort"))),
      h("span.job-row-line.job-row-sub", null, h("span.job-row-type", null, typeLabel(job)),
        h("span.job-row-plan", null, planText))));
  }
  function drawIndex() {
    if (!loaded && !loadError) { list.replaceChildren(h("p.jobs-index-empty", null, copy("loading"))); indexCount.textContent = ""; return; }
    if (loadError && !loaded) {
      list.replaceChildren(h("p.jobs-index-empty.is-error", null, copy("stale") + " " + loadError));
      indexCount.textContent = "";
      return;
    }
    const shown = jobs.filter(matches);
    indexCount.textContent = filterText ? fill(copy("countFiltered"), { shown: shown.length, total: jobs.length })
      : fill(copy("count"), { total: jobs.length });
    // Redrawing must not drop a keyboard reader's place in the list.
    const active = typeof document === "undefined" ? null : document.activeElement;
    const focused = active && list.contains && list.contains(active) ? active.dataset.job : null;
    list.replaceChildren(...(shown.length ? shown.map(jobRow)
      : [h("p.jobs-index-empty", null, copy(jobs.length ? "noMatch" : "empty"))]));
    if (focused) list.querySelector('.job-row[data-job="' + CSS.escape(focused) + '"]')?.focus();
  }
  function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => values[key] === undefined ? match : String(values[key]));
  }
  function label(kind, value) {
    if (value === undefined || value === null || value === "") return "—";
    return t(kind + "." + value, String(value).replace(/[-_]/g, " "));
  }
  function runBadge(value) {
    const node = badge(label("job", value), RUN_TONE[value] || "idle", { dot: true });
    node.dataset.status = value;
    return node;
  }
  function scheduleBadge(schedule) {
    const state = scheduleState(schedule);
    const node = badge(copy("plan") + " · " + label("schedule", state), SCHEDULE_TONE[state] || "idle", { dot: true });
    node.dataset.schedule = state;
    return node;
  }
  function typeLabel(job) {
    const config = job.configuration;
    if (job.builtin || (config.kind === "builtin" && config.action === "project.refresh")) return copy("type.projectSync");
    return config.kind === "builtin" ? label("jobs.action", config.action) : label("jobs.kind", config.kind);
  }
  function ownerValue() {
    return taskId ? h("a", { href: "/?task=" + encodeURIComponent(taskId) }, copy("ownerTask") + " · " + taskId)
      : copy("ownerGlobal");
  }
  root.classList.add("jobs-manager");
  // In the Jobs entry the shell already names the area and scope (list head,
  // crumb) and owns "new" and refresh, as on the workbench; the page starts
  // with the Job itself. Embedded in a Task page, one quiet bar carries them.
  const head = options.index ? null : h("header.jobs-bar", null,
    h("div.jobs-bar-title", null, h("h2", { title: copy("help") }, copy("heading")), h("p.sr-only", null, copy("help"))),
    h("div.jobs-bar-actions", null, receipt,
      h("button.btn.btn-ghost.jobs-bar-refresh", { type: "button", title: copy("refresh"), onclick: () => { if (!pending) void refresh(); } },
        icon("refresh"), h("span", null, copy("refresh"))),
      taskId ? h("a.btn.btn-ghost", { href: jobLink(taskId) }, copy("openInJobs")) : null,
      h("button.btn.btn-primary", { type: "button", onclick: () => editJob() }, icon("plus"), copy("newJob"))));
  const indexTools = h("div.jobs-index-tools", null,
    h("label.search-field", null, icon("search"), h("span.sr-only", null, copy("search")), indexSearch), indexCount);
  if (options.index) options.index.replaceChildren(indexTools, list);
  root.replaceChildren(...[head, options.notice ? h("p.job-notice", { role: "status" }, options.notice) : null,
    options.index ? h("div.jobs-receipt", null, receipt) : null,
    options.index ? detail : h("div.jobs-layout", null, h("div.jobs-index", null, indexTools, list), detail), editor].filter(Boolean));
  drawIndex();
  void refresh();
  // Route-driven selection (history navigation in the Jobs entry). The
  // owner has already resolved a draft through leave(); an editor never
  // outlives the Job it was opened on.
  function select(jobId, runId, artifact) {
    const reference = parseArtifact(artifact);
    if (selected === (jobId || undefined) && selectedRun === (runId || undefined)
      && JSON.stringify(artifactState.reference) === JSON.stringify(reference)) return;
    if (selected !== (jobId || undefined)) closeEditor();
    if (runId && (selectedRun !== runId || selected !== (jobId || undefined))) revealRun = true;
    selected = jobId || undefined; selectedRun = runId || undefined; artifactState.reference = reference;
    void refresh(false);
  }
  // May the owner move this view to another selection (replace: another Job
  // or scope, which closes any editor)? A write in flight keeps its view so
  // its receipt stays observable; a draft is discarded only on confirmation.
  function leave(replace) {
    if (pending) { status(copy("leaveBusy"), true); return false; }
    if (!replace) return true;
    if (!guardDraft()) return false;
    closeEditor();
    return true;
  }
  function dispose() { disposed = true; generation++; runGeneration++; closeEditor(); }
  // A hidden page must not hold a modal open; its draft waits for the return.
  function suspend() { if (editor.open && typeof editor.close === "function") editor.close(); }
  return { isDirty: () => dirty, isBusy: () => pending, refresh, select, leave, dispose,
    create: () => editJob(), suspend, resume: showEditor };
}

function parseArtifact(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// The one address of a Job and optionally an exact Run: the Jobs entry,
// scoped to its owning Task when it has one.
export function jobLink(taskId, jobId, runId) {
  const query = new URLSearchParams({ ...(taskId ? { task: taskId } : {}), ...(jobId ? { job: jobId } : {}),
    ...(runId ? { jobRun: runId } : {}) });
  return "/jobs" + (query.size ? "?" + query : "");
}
`;
