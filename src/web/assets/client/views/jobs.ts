export const JOBS_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { requestJson, submitMutation } from "/assets/js/lib/api.js";
import { drawArtifact } from "/assets/js/views/task/files.js";

// One view for two server-fixed scopes. Refresh only reads facts; it never
// admits due work, derives nextDue or replaces a selected exact Run with latest.
export function mountJobs(root, t, taskId) {
  const base = taskId ? "/api/tasks/" + encodeURIComponent(taskId) : "/api/settings";
  const copy = key => t("jobs." + key);
  const receipt = h("p.settings-receipt", { role: "status", "aria-live": "polite" });
  const list = h("div.jobs-list");
  const detail = h("section.jobs-detail", { "aria-label": copy("details") });
  const editor = h("section");
  const params = new URLSearchParams(location.search);
  let jobs = [], schedules = [], selected = params.get("job") || undefined,
    selectedRun = params.get("jobRun") || undefined, generation = 0, runGeneration = 0, pending = false, dirty = false;
  const artifactState = {};
  try { artifactState.reference = JSON.parse(params.get("artifact") || "null"); } catch {}
  function pinSelection() {
    const url = new URL(location.href);
    if (selected) url.searchParams.set("job", selected); else url.searchParams.delete("job");
    if (selectedRun) url.searchParams.set("jobRun", selectedRun); else url.searchParams.delete("jobRun");
    history.replaceState(history.state, "", url);
  }
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
    const kind = choose(taskId ? ["shell", "task", "agent"] : ["builtin", "task", "agent"], job?.configuration.kind);
    kind.disabled = !!job;
    const action = choose(["system.noop", "project.refresh"], job?.configuration.action);
    const project = input(job?.configuration.projectId || "");
    const configuration = h("textarea", { rows: 12, required: true });
    configuration.value = JSON.stringify(job?.configuration || { kind: "shell", owner: { kind: "task" },
      projectId: "", head: "", workspace: "", env: {}, steps: [{ name: "check", command: "true" }] }, null, 2);
    const controlled = h("div", null, field(copy("action"), action), field(copy("project"), project), h("p", null, copy("rebind")));
    const configured = h("div", null, h("p", null, copy("taskConfig")), field(copy("configuration"), configuration));
    const fields = [field("ID", id), field(copy("name"), title), field(copy("executor"), kind), controlled, configured];
    const sync = () => {
      controlled.hidden = kind.value !== "builtin"; configured.hidden = !controlled.hidden;
      project.disabled = controlled.hidden || action.value !== "project.refresh"; project.required = !project.disabled;
      configuration.required = !configured.hidden;
    };
    kind.addEventListener("change", () => {
      configuration.value = JSON.stringify(kind.value === "agent"
        ? { kind: "agent", target: { kind: "job", agentId: "" }, input: "", concurrency: "serial" }
        : kind.value === "task" ? { kind: "task", goal: "delivery", target: {
          kind: "new", title: "", description: "", projectBindings: [] } }
        : { kind: "shell", owner: { kind: "task" }, projectId: "", head: "", workspace: "", env: {},
          steps: [{ name: "check", command: "true" }] }, null, 2);
      sync();
    });
    action.addEventListener("change", sync); sync();
    form(job ? copy("editJob") : copy("newJob"), fields, () => {
      const config = kind.value !== "builtin" ? JSON.parse(configuration.value) : {
        kind: "builtin", action: action.value, input: {},
        ...(action.value === "project.refresh" ? { projectId: project.value.trim() } : {})
      };
      void mutate("jobs", { op: job ? "update" : "define", id: id.value.trim(), title: title.value.trim(),
        configuration: config, ...(job ? { expectedRevision: job.revision } : {}) }, result => {
          selected = result.id; selectedRun = undefined; pinSelection(); closeEditor();
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
    const epoch = ++runGeneration;
    selectedRun = runId;
    pinSelection();
    target.replaceChildren(h("p", null, copy("loading")));
    try {
      const run = await read("jobs", { op: "run-get", id: jobId, runId });
      if (epoch !== runGeneration || selected !== jobId || selectedRun !== runId) return;
      const evidence = h("section"), artifacts = h("section"), session = h("section");
      target.replaceChildren(h("div.settings-stack", null, h("h4", null, run.id), fact(copy("state"), run.status),
        fact(copy("executor"), run.executor || (run.delegation ? "task" : "process")),
        run.delegation ? h("a.btn", { href: "/?task=" + encodeURIComponent(run.delegation.taskId) },
          copy("executionTask") + " · " + run.delegation.taskId) : null,
        ...(run.businessResult ? [h("div", null, fact(copy("result"), run.businessResult.summary),
          raw(copy("result"), run.businessResult))] : []),
        run.cancelRequestedAt ? fact(copy("cancelRequested"), run.cancelRequestedAt) : null,
        fact(copy("trigger"), run.trigger.source + " · " + run.trigger.key),
        fact(copy("created"), run.createdAt), fact(copy("finished"), run.terminalAt),
        raw(copy("snapshot"), run), artifacts, evidence, session));
      if (["queued", "running", "unknown-needs-attention"].includes(run.status)) target.prepend(
        button(copy("cancelRun"), () => {
          if (window.confirm(copy("cancelBoundary") + "\n" + runId))
            void mutate("jobs", { op: "run-cancel", id: jobId, runId });
        }));
      drawArtifacts(artifacts, jobId, run, epoch);
      if (run.executor === "agent" && run.configuration.target.kind === "job") drawSession(session, jobId, runId);
      try {
        const value = await read("jobs", { op: "run-evidence", id: jobId, runId });
        if (epoch !== runGeneration) return;
        evidence.append(raw(copy("diagnostics"), value));
        if (run.executor !== "agent" && !run.delegation) {
          const logs = await read("jobs", { op: "logs", id: jobId, runId });
          if (epoch !== runGeneration) return;
          evidence.append(h("h4", null, copy("logs")), logs.length ? h("div", null, logs.map(log => h("section", null,
            h("h5", null, log.step + (log.truncated ? " · " + copy("truncated") : "")),
            h("pre.settings-observation", null, log.text)))) : h("p", null, copy("noLogs")));
        }
      } catch (error) { if (epoch === runGeneration) evidence.append(h("p.settings-error", null, copy("diagnostics") + ": " + error.message)); }
    } catch (error) { if (epoch === runGeneration) target.replaceChildren(h("p.settings-error", null, error.message)); }
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
      const url = new URL(location.href);
      url.searchParams.set("artifact", JSON.stringify(ref));
      history.replaceState(history.state, "", url);
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
    target.append(h("h4", null, copy("artifacts")), h("p", null, copy("registeredOnly")),
      ...refs.map(ref => button(ref.relativePath + " · " + ref.version.slice(0, 12), () => void select(ref))), viewer);
    if (artifactState.reference && refs.some(ref => JSON.stringify(ref) === JSON.stringify(artifactState.reference)))
      void select(artifactState.reference);
    const recovery = h("div");
    target.append(button(copy("inspectSaved"), async () => {
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
    }), recovery);
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
  async function showDetail(epoch) {
    const job = jobs.find(j => j.id === selected);
    if (!job) {
      detail.replaceChildren(...(selected ? [h("p.settings-error", null, copy("unavailable") + " · " + selected)] : []));
      return;
    }
    const [runs, plans] = await Promise.all([
      read("jobs", { op: "runs", id: job.id }),
      Promise.all(schedules.filter(s => s.jobId === job.id).map(s => read("schedules", { op: "show", id: s.id })))
    ]);
    if (epoch !== generation) return;
    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const summary = run => run ? (run.id || run.runId) + " · " + run.status + " · "
      + (run.terminalAt || run.finishedAt || run.createdAt || run.attemptedAt)
      + (run.summary || run.businessResult?.summary ? " · " + (run.summary || run.businessResult.summary) : "") : null;
    const runDetail = h("section.job-run");
    detail.replaceChildren(h("div.settings-stack", null, h("h3", null, job.title), fact("ID", job.id),
      fact(copy("scope"), taskId || "global"), fact(copy("project"), job.configuration.projectId),
      job.builtin ? h("p", null, copy("builtinSync")) : null,
      fact(copy("revision"), job.revision),
      fact(copy("executor"), job.configuration.kind),
      fact(copy("recentRun"), summary(runs[0])),
      fact(copy("recentSuccess"), summary(runs.find(run => run.businessResult?.outcome === "succeeded"))),
      job.refresh ? h("div", null,
        fact(copy("refreshAttempt"), summary(job.refresh.lastAttempt)),
        fact(copy("refreshSuccess"), summary(job.refresh.lastSuccessfulRefresh))) : null,
      h("div.settings-actions", null,
        button(copy("runNow"), () => void mutate("jobs", { op: "run", id: job.id, requestId: crypto.randomUUID() }, result => {
          selectedRun = result.run.id; pinSelection();
        }), true),
        !job.builtin ? button(copy("editJob"), () => editJob(job)) : null,
        !job.builtin && !["agent", "task"].includes(job.configuration.kind) ? button(copy("newSchedule"), () => editSchedule()) : null),
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
          })), s.lastAttempt?.runId ? h("a.btn", { href: jobLink(taskId, s.lastAttempt.jobId || job.id, s.lastAttempt.runId) }, copy("inspectRun")) : null),
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
          closeEditor(); selected = job.id; selectedRun = undefined; pinSelection(); void refresh();
        }
      }, h("strong", null, job.title), h("code", null, job.id),
        h("small", null, job.builtin ? copy("builtinSync") : job.configuration.action || job.configuration.kind),
        h("small", null, job.configuration.projectId || "—"))) : [h("p", null, copy("empty"))]));
      await showDetail(epoch);
      if (announce && epoch === generation) status(copy("observed") + " · " + new Date().toISOString());
    } catch (error) { if (epoch === generation) status(copy("stale") + " " + error.message, true); }
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

export function jobLink(taskId, jobId, runId) {
  const query = new URLSearchParams({ job: jobId, ...(runId ? { jobRun: runId } : {}),
    ...(taskId ? { task: taskId, section: "jobs" } : {}) });
  return (taskId ? "/" : "/settings/jobs") + "?" + query;
}
`;
