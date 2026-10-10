export const PREVIEW_SCRIPT = String.raw`
import { requestJson, submitMutation } from "/assets/js/lib/api.js";

export function createPreviewController(root, t) {
  let taskId = null, generation = 0, revision = 0, timer = null, selected = null, frame = null, frameUrl = null;
  let list, status;
  function close() {
    generation++;
    clearTimeout(timer);
    taskId = null;
    selected = null;
    frame = null;
    frameUrl = null;
    root.replaceChildren();
  }
  function text(tag, value, parent) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (parent) parent.append(node);
    return node;
  }
  function button(label, action, parent) {
    const node = text("button", label, parent);
    node.type = "button";
    node.className = "btn btn-sm";
    node.addEventListener("click", action);
    return node;
  }
  function clearFrame() {
    if (frame) frame.remove();
    frame = null; frameUrl = null;
  }
  function open(id) {
    if (taskId === id) return;
    close();
    if (!id) return;
    taskId = id;
    const actions = document.createElement("div");
    actions.className = "dock-sub";
    root.append(actions);
    text("strong", t("preview.title"), actions);
    button(t("preview.refresh"), function () { clearFrame(); refresh(generation); }, actions);
    text("p", t("preview.limits"), root).className = "feed-note";
    text("p", t("preview.lifecycle"), root).className = "feed-note";
    list = document.createElement("div");
    list.className = "preview-services";
    root.append(list);
    status = text("p", t("preview.loading"), root);
    status.className = "feed-note";
    refresh(generation);
  }
  async function refresh(expected) {
    clearTimeout(timer);
    const read = ++revision;
    const id = taskId;
    if (!id || expected !== generation) return;
    try {
      const data = await requestJson("/api/tasks/" + encodeURIComponent(id) + "/previews", { signal: AbortSignal.timeout(5000) });
      if (expected !== generation || read !== revision) return;
      const focusKey = document.activeElement?.getAttribute("data-preview-focus");
      list.replaceChildren();
      status.textContent = data.services.length ? (data.complete ? "" : t("preview.more")) : t("preview.empty");
      if (!data.services.some(function (service) { return service.id === selected; })) {
        selected = data.services.find(function (service) { return service.state === "ready"; })?.id || null;
      }
      let activeUrl = null;
      data.services.forEach(function (service) {
        const row = document.createElement("section");
        row.className = "preview-service";
        list.append(row);
        text("strong", service.name + " · " + service.id, row);
        text("span", t("preview.state." + service.state), row);
        text("small", service.detail, row).title = service.readAt;
        if (service.url) {
          button(t("preview.view"), function () { selected = service.id; clearFrame(); refresh(generation); }, row)
            .setAttribute("data-preview-focus", service.id + "-view");
          const link = text("a", t("preview.window"), row);
          link.href = service.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.className = "btn btn-sm";
          link.setAttribute("data-preview-focus", service.id + "-window");
          if (service.id === selected) activeUrl = service.url;
        }
        if (service.canStop) {
          const stop = button(t("preview.stop"), async function () {
            stop.disabled = true;
            try {
              const result = await submitMutation(id + "/preview/" + service.id,
                "/api/tasks/" + encodeURIComponent(id) + "/previews/" + encodeURIComponent(service.id) + "/stop", {});
              if (expected !== generation) return;
              status.textContent = result.stopped ? t("preview.state.stopped") : t("preview.stopRequested");
              if (selected === service.id) clearFrame();
              refresh(expected);
            } catch (error) {
              if (expected === generation) status.textContent = error.message;
            }
          }, row);
          stop.disabled = service.state === "stopping";
          stop.setAttribute("data-preview-focus", service.id + "-stop");
        }
        if (service.receipt) text("small", t("preview.receipt") + ": " + service.receipt.outcome
          + " · " + service.receipt.artifactsLocator, row);
      });
      if (activeUrl !== frameUrl) {
        clearFrame();
        if (activeUrl) {
          frame = document.createElement("iframe");
          frame.title = t("preview.title");
          frame.setAttribute("sandbox", "allow-scripts");
          frame.referrerPolicy = "no-referrer";
          frame.className = "preview-frame";
          frame.src = activeUrl;
          frameUrl = activeUrl;
          root.append(frame);
        }
      }
      if (focusKey) Array.from(root.querySelectorAll("[data-preview-focus]"))
        .find(function (node) { return node.getAttribute("data-preview-focus") === focusKey; })?.focus();
    } catch (error) {
      if (expected !== generation || read !== revision) return;
      clearFrame();
      status.textContent = error.message;
    }
    if (expected === generation && read === revision && taskId) timer = setTimeout(function () { refresh(expected); }, 5000);
  }
  return { open, close };
}
`;
