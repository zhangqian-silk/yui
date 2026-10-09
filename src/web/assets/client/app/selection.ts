export const SELECTION_SCRIPT = String.raw`
// Which Task is selected and its loaded detail: selecting one, leaving it,
// following the URL, and reading the Context snapshot (the only input to core
// rendering) plus the optional runtime observation. This module is the only
// writer of state.selected, state.detail and state.detailKey; app/taskView
// draws the result. Leaving a Task with an unsent draft asks first; the page
// itself warns before unload.
import { applyUrl, readQuery, syncUrl, urlTaskId } from "/assets/js/layout/router.js";

// Fingerprint of the rendered payload. Quiet polling skips identical reads so
// local view state (open blocks, list pages, drafts) survives.
function fingerprint(value) {
  const text = JSON.stringify(value);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return text.length + ":" + hash;
}

// deps: { state, t, api, toast, workspace, taskView, renderTaskList }
//   state      writes selected, detail, detailKey
//   api        context, inspect and observation reads
//   workspace  layout/workspace: layout and the dock on entering/leaving
//   taskView   app/taskView: draws the selected Task and the overview
//   renderTaskList()  redraw the sidebar list's selection (app/catalog)
export function createSelection(deps) {
  window.addEventListener("beforeunload", function (event) {
    if (!deps.taskView.hasUnsent()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  return {
    selectTask: function (taskId) { return selectTask(deps, taskId); },
    clearSelection: function () { clearSelection(deps); },
    followUrl: function (params) { followUrl(deps, params); },
    // Quietly re-read the selected Task; rejects when the read fails.
    reload: function () { return load(deps, deps.state.selected, false); }
  };
}

function canLeave(deps) {
  return !deps.taskView.hasUnsent() || window.confirm(deps.t("confirm.leave"));
}

async function selectTask(deps, taskId) {
  const state = deps.state;
  // Re-selecting the visible Task is not navigation.
  if (state.selected === taskId && state.detail) return;
  if (state.selected !== taskId && !canLeave(deps)) { syncUrl(state, true); return; }
  if (urlTaskId() !== taskId) {
    const params = readQuery();
    params.delete("section");
    applyUrl(params, true);
  }
  // Show taskId as selected before its detail arrives.
  state.selected = taskId;
  state.detail = null;
  deps.workspace.enterTask();
  deps.taskView.enterTask();
  syncUrl(state, state.selected === urlTaskId());
  deps.workspace.updateLayout();
  deps.renderTaskList();
  try {
    await load(deps, taskId, true);
  } catch {
    if (state.selected !== taskId) return;
    deps.taskView.showDetailError();
    deps.toast(deps.t("errors.detail"));
  }
}

function clearSelection(deps) {
  if (!canLeave(deps)) return;
  dropSelection(deps);
  syncUrl(deps.state, !urlTaskId());
  deps.workspace.updateLayout();
  deps.taskView.showOverview();
  deps.renderTaskList();
  deps.taskView.updateSessionTargets();
}

// Drop the selected Task and its dock discussion; callers redraw.
function dropSelection(deps) {
  deps.state.selected = null;
  deps.state.detail = null;
  deps.taskView.leaveTask();
  deps.workspace.leaveTask();
}

// The Task and section named by the URL, on load and on back/forward.
function followUrl(deps, params) {
  const state = deps.state;
  const taskId = params.get("task");
  if (taskId) {
    if (taskId === state.selected && state.detail) deps.taskView.applySection(params.get("section"));
    else selectTask(deps, taskId);
    return;
  }
  if (state.selected && !canLeave(deps)) { syncUrl(state, true); return; }
  dropSelection(deps);
  deps.workspace.updateLayout();
  deps.taskView.showOverview();
}

async function load(deps, taskId, navigate) {
  const state = deps.state;
  if (navigate) deps.taskView.showLoading();
  // Rendering consumes the current Context snapshot, not event pages.
  const core = await deps.api.context(taskId);
  const taskEntry = core.records.find(function (entry) { return entry.ref.store === "task"; });
  if (!taskEntry) throw new Error("Task reference unavailable.");
  const task = taskEntry.omitted ? (await deps.api.inspect(taskId, taskEntry.ref)).value : taskEntry.value;
  if (state.selected !== taskId) return;
  const previous = state.detail && state.detail.task.id === taskId ? state.detail : null;
  const detail = {
    task: task, core: core,
    viewState: previous ? previous.viewState : {},
    runtime: previous ? previous.runtime : null,
    runtimeStatus: previous ? previous.runtimeStatus : "waiting",
    runtimeObservedAt: previous ? previous.runtimeObservedAt : new Date().toISOString()
  };
  state.detail = detail;
  state.detailKey = fingerprint(core);
  deps.taskView.render(navigate);
  if (navigate) deps.taskView.applySection(readQuery().get("section"));
  observe(deps, taskId, detail);
}

// The optional observation never participates in core readiness.
function observe(deps, taskId, detail) {
  function settle(runtime, status) {
    if (deps.state.detail !== detail) return;
    detail.runtime = runtime;
    detail.runtimeStatus = status;
    detail.runtimeObservedAt = new Date().toISOString();
    deps.taskView.observationArrived(detail);
  }
  deps.api.observation(taskId).then(function (runtime) { settle(runtime, "available"); })
    .catch(function () { settle(null, "unavailable"); });
}
`;
