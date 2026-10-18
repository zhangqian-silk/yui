export const JOBS_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";

// One view for two server-fixed scopes. Refresh only reads facts; it never
// admits due work, derives nextDue or replaces a selected exact Run with latest.
export function mountJobs(root, t, taskId) {
  const base = taskId ? "/api/tasks/" + encodeURIComponent(taskId) : "/api/settings";
  const copy = key => t("jobs." + key);
  const receipt = h("p.settings-receipt", { role: "status", "aria-live": "polite" });
  const list = h("div.jobs-list");
  const detail = h("section.jobs-detail", { "aria-label": copy("details") });
  const editor = h("section");
  let jobs = [], schedules = [], selected, selectedRun, generation = 0, pending = false, dirty = false;
  const blocked = new Set();
  const read = (family, input) => requestJson(base + "/" + family + "?" + new URLSearchParams(input));
  const button = (text, action, primary = false) => h("button.btn" + (primary ? ".btn-primary" : ""), {
    type: "button", onclick: action
  }, text);
  const json = value => h("pre.settings-observation", null, JSON.stringify(value, null, 2));
  const fact = (name, value) => h("p.job-fact", null, h("strong", null, name + ": "), String(value ?? "—"));
  const raw = (name, value) => h("details", null, h("summary", null, name), json(value));
  function field(name, control) { return h("label.field", null, h("span", null, name), control); }
  function input(value = "", attrs = {}) { return h("input", { value, ...attrs }); }
  function choose(values, value) {
    const node = h("select", null, values.map(v => h("option", { value: v }, v)));
    node.value = value || values[0]; return node;
  }
  function guardDraft() { return !dirty || window.confirm(copy("discard")); }
  function closeEditor() { editor.replaceChildren(); dirty = false; root.dataset.unsent = "false"; }
  function status(text, error = false) { receipt.textContent = text; receipt.classList.toggle("settings-error", error); }
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
      status(payload.op === "run"
        ? (result.reason === "overlap" ? copy("overlap") : copy("admitted")) + " · " + result.run.id + " · " + result.run.status
        : payload.op === "run-cancel" ? copy("cancelRequested") : copy("saved"));
      if (after) after(result);
      await refresh(false);
    } catch (error) {
      if (error.disposition !== "not-submitted") blocked.add(key);
      status(error.message + (blocked.has(key) ? "\n" + copy("unknown") : ""), true);
    } finally {
      pending = false;
      root.dataset.reading = "false";
      controls.forEach((node, index) => { node.disabled = disabled[index]; });
    }
  }
  function form(title, contents, submit) {
    if (!guardDraft()) return;
    closeEditor();
    const node = h("form.settings-card.settings-stack", null, h("h3", null, title), contents,
      h("div.settings-actions", null, h("button.btn.btn-primary", { type: "submit" }, copy("save")),
        button(copy("close"), () => { if (guardDraft()) closeEditor(); })));
    const markDirty = () => { dirty = true; root.dataset.unsent = "true"; };
    node.addEventListener("input", markDirty);
    node.addEventListener("change", markDirty);
    node.addEventListener("submit", event => {
      event.preventDefault();
      try { submit(); } catch (error) { status(error.message, true); }
    });
    editor.append(node);
    node.querySelector("input,select,textarea")?.focus();
  }
  function editJob(job) {
    const id = input(job?.id || "", { required: true, pattern: "[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}", disabled: !!job });
    const title = input(job?.title || "", { required: true });
    const action = choose(["system.noop", "project.refresh"], job?.configuration.action);
    const project = input(job?.configuration.projectId || "");
    const configuration = h("textarea", { rows: 12, required: true });
    configuration.value = JSON.stringify(job?.configuration || { kind: "shell", owner: { kind: "task" },
      projectId: "", head: "", workspace: "", env: {}, steps: [{ name: "check", command: "true" }] }, null, 2);
    const fields = [field("ID", id), field(copy("name"), title)];
    if (taskId) fields.push(h("p", null, copy("taskConfig")), field(copy("configuration"), configuration));
    else {
      fields.push(field(copy("action"), action), field(copy("project"), project), h("p", null, copy("rebind")));
      const sync = () => { project.disabled = action.value !== "project.refresh"; project.required = !project.disabled; };
      action.addEventListener("change", sync); sync();
    }
    form(job ? copy("editJob") : copy("newJob"), fields, () => {
      const config = taskId ? JSON.parse(configuration.value) : {
        kind: "builtin", action: action.value, input: {},
        ...(action.value === "project.refresh" ? { projectId: project.value.trim() } : {})
      };
      void mutate("jobs", { op: job ? "update" : "define", id: id.value.trim(), title: title.value.trim(),
        configuration: config, ...(job ? { expectedRevision: job.revision } : {}) }, result => {
        selected = result.id; selectedRun = undefined; closeEditor();
      });
    });
  }
  function editSchedule(schedule) {
    const id = input(schedule?.id || "", { required: true, disabled: !!schedule });
    const jobId = choose(jobs.filter(j => !j.builtin || j.id === schedule?.jobId).map(j => j.id), schedule?.jobId || selected);
    jobId.disabled = !!schedule?.builtin;
    const kind = choose(schedule?.builtin ? ["interval", "cron"] : ["once", "interval", "cron"], schedule?.rule.kind || "interval");
    const rule = schedule?.rule;
    const at = input(rule?.at || rule?.anchor || "", { placeholder: "2026-10-17T09:00:00+08:00" });
    const every = input(String(rule?.everyMs || 3600000), { type: "number", min: schedule?.builtin ? 60000 : 1000, step: 1 });
    const expression = input(rule?.expression || "0 9 * * *");
    const timezone = input(rule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
    const when = field(copy("instant"), at), interval = field(copy(schedule?.builtin ? "syncEvery" : "every"), every);
    const cron = field(copy("cron"), expression), zone = field(copy("timezone"), timezone);
    const sync = () => {
      when.hidden = kind.value === "cron"; interval.hidden = kind.value !== "interval";
      cron.hidden = zone.hidden = kind.value !== "cron"; at.required = !when.hidden;
    };
    kind.addEventListener("change", sync); sync();
    form(schedule ? copy("editSchedule") : copy("newSchedule"),
      [field("ID", id), field("Job", jobId), field(copy("rule"), kind), when, interval, cron, zone,
        h("p", null, copy("scheduleHelp"))], () => {
      const rule = kind.value === "once" ? { kind: "once", at: at.value }
        : kind.value === "interval" ? { kind: "interval", anchor: at.value, everyMs: Number(every.value) }
        : { kind: "cron", expression: expression.value, timezone: timezone.value };
      void mutate("schedules", { op: schedule ? "update" : "create", id: id.value.trim(), rule,
        ...(schedule?.builtin ? {} : { jobId: jobId.value, ...(!taskId ? { authorization: "service" } : {}) }),
        ...(schedule ? { expectedRevision: schedule.revision } : {}) }, closeEditor);
    });
  }
  async function showRun(jobId, runId, target) {
    selectedRun = runId;
    target.replaceChildren(h("p", null, copy("loading")));
    try {
      const [run, logs] = await Promise.all([read("jobs", { op: "run-get", id: jobId, runId }),
        read("jobs", { op: "logs", id: jobId, runId })]);
      if (selected !== jobId || selectedRun !== runId) return;
      target.replaceChildren(h("h4", null, run.id), fact(copy("state"), run.status),
        ...(run.businessResult ? [h("div", null, fact(copy("result"), run.businessResult.summary),
          raw(copy("result"), run.businessResult))] : []),
        fact(copy("trigger"), run.trigger.source + " · " + run.trigger.key),
        fact(copy("created"), run.createdAt), fact(copy("finished"), run.terminalAt),
        raw(copy("snapshot"), run),
        h("h4", null, copy("logs")), logs.length ? h("div", null, logs.map(log => h("section", null,
          h("h5", null, log.step + (log.truncated ? " · " + copy("truncated") : "")),
          h("pre.settings-observation", null, log.text)))) : h("p", null, copy("noLogs")));
      if (["queued", "running", "unknown-needs-attention"].includes(run.status)) target.prepend(
        button(copy("cancelRun"), () => void mutate("jobs", { op: "run-cancel", id: jobId, runId })));
    } catch (error) { target.replaceChildren(h("p.settings-error", null, error.message)); }
  }
  async function showDetail(epoch) {
    const job = jobs.find(j => j.id === selected);
    if (!job) { detail.replaceChildren(); return; }
    const [runs, plans] = await Promise.all([
      read("jobs", { op: "runs", id: job.id }),
      Promise.all(schedules.filter(s => s.jobId === job.id).map(s => read("schedules", { op: "show", id: s.id })))
    ]);
    if (epoch !== generation) return;
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const summary = run => run ? (run.id || run.runId) + " · " + run.status + " · "
      + (run.terminalAt || run.finishedAt || run.createdAt || run.attemptedAt) : null;
    const runDetail = h("section.job-run");
    detail.replaceChildren(h("div.settings-stack", null, h("h3", null, job.title), fact("ID", job.id),
      fact(copy("scope"), taskId || "global"), fact(copy("project"), job.configuration.projectId),
      job.builtin ? h("p", null, copy("builtinSync")) : null,
      fact(copy("revision"), job.revision),
      fact(copy("recentRun"), summary(runs[0])),
      job.refresh ? h("div", null,
        fact(copy("refreshAttempt"), summary(job.refresh.lastAttempt)),
        fact(copy("refreshSuccess"), summary(job.refresh.lastSuccessfulRefresh))) : null,
      h("div.settings-actions", null,
        button(copy("runNow"), () => void mutate("jobs", { op: "run", id: job.id, requestId: crypto.randomUUID() }, result => {
          selectedRun = result.run.id;
        }), true),
        !job.builtin ? button(copy("editJob"), () => editJob(job)) : null,
        !job.builtin ? button(copy("newSchedule"), () => editSchedule()) : null),
      raw(copy("configuration"), job.configuration),
      job.refresh ? raw(copy("refreshFacts"), job.refresh) : null,
      h("h3", null, copy("schedules")),
      plans.length ? h("div.settings-stack", null, plans.map(({ schedule: s, lastSuccess }) => h("article.settings-card", null,
        h("h4", null, s.id), fact(copy("state"), s.state),
        s.builtin ? fact(copy("automatic"), copy(s.builtin.enabled ? "enabled" : "disabled")) : null,
        s.state === "completed" ? h("p", null, copy("onceCompleted")) : null,
        fact(copy("rule"), s.rule.kind === "cron" ? s.rule.expression : s.rule.kind === "once" ? s.rule.at : s.rule.anchor + " + " + s.rule.everyMs + " ms"),
        fact(copy("timezone"), s.rule.timezone || "UTC / offset"),
        fact(copy("nextDue"), s.state === "enabled" ? s.nextDue : null), fact(copy("lastAttempt"), s.lastAttempt
          ? s.lastAttempt.at + " · " + s.lastAttempt.outcome + " · " + (s.lastAttempt.runId || s.lastAttempt.reason || "") : null),
        fact(copy("lastSuccess"), lastSuccess ? lastSuccess.id + " · " + (lastSuccess.terminalAt || lastSuccess.updatedAt) : null),
        s.reason ? h("p.settings-error", null, s.reason) : null,
        h("div.settings-actions", null,
          button(copy("editSchedule"), () => editSchedule(s)),
          button(copy((s.builtin ? s.builtin.enabled : s.state === "enabled") ? "disable" : "enable"), () => void mutate("schedules", {
            op: (s.builtin ? s.builtin.enabled : s.state === "enabled") ? "disable" : "enable", id: s.id, expectedRevision: s.revision
          })), s.lastAttempt?.runId ? button(copy("inspectRun"), () => void showRun(job.id, s.lastAttempt.runId, runDetail)) : null),
        raw(copy("details"), s)))) : h("p", null, copy("noSchedules")),
      h("h3", null, copy("history")),
      runs.length ? h("div.jobs-runs", null, runs.map(run =>
        button(run.id + " · " + run.status + " · " + run.trigger.source + " · " + run.createdAt,
          () => void showRun(job.id, run.id, runDetail)))) : h("p", null, copy("noRuns")),
      runDetail));
    if (selectedRun) await showRun(job.id, selectedRun, runDetail);
  }
  async function refresh(announce = true) {
    const epoch = ++generation;
    if (announce) status(copy("loading"));
    try {
      const result = await Promise.all([read("jobs", { op: "list" }), read("schedules", { op: "list" })]);
      if (epoch !== generation) return;
      [jobs, schedules] = result;
      if (!selected && jobs.length) selected = jobs[0].id;
      list.replaceChildren(...(jobs.length ? jobs.map(job => h("button.job-choice", {
        type: "button", "aria-pressed": String(selected === job.id), onclick: () => {
          if (pending || !guardDraft()) return;
          closeEditor(); selected = job.id; selectedRun = undefined; void refresh();
        }
      }, h("strong", null, job.title), h("code", null, job.id),
        h("small", null, job.builtin ? copy("builtinSync") : job.configuration.action || job.configuration.kind),
        h("small", null, job.configuration.projectId || "—"))) : [h("p", null, copy("empty"))]));
      await showDetail(epoch);
      if (announce && epoch === generation) status(copy("observed") + " · " + new Date().toISOString());
    } catch (error) { if (epoch === generation) status(error.message, true); }
  }
  root.classList.add("jobs-manager");
  root.replaceChildren(h("h2", null, copy("heading")),
    h("p", null, copy("help")), fact(copy("scope"), taskId || "global"),
    h("div.settings-actions", null, button(copy("newJob"), () => editJob(), true),
      button(copy("refresh"), () => { if (!pending) void refresh(); })),
    receipt, editor, h("div.jobs-layout", null, list, detail));
  void refresh();
  return { isDirty: () => dirty, isBusy: () => pending, refresh };
}
`;
