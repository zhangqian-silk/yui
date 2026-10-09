export const CREATE_TASK_SCRIPT = String.raw`
import { h } from "/assets/js/lib/dom.js";
import { button } from "/assets/js/ui/primitives.js";
import { field, receiptLine, setReceipt, submitWrite } from "/assets/js/ui/forms.js";
import { renderSubmissionFacets } from "/assets/js/domain/taskForms.js";

export function bindCreateTask(options) {
  const t = options.t;
  let dialog = null;
  window.addEventListener("beforeunload", function (event) {
    if (dialog && dialog.querySelector('[data-unsent="true"]')) {
      event.preventDefault(); event.returnValue = "";
    }
  });
  document.querySelector("#create-task").addEventListener("click", async function () {
    if (dialog && dialog.dataset.saved === "true") { dialog.remove(); dialog = null; }
    if (dialog) { dialog.showModal(); return; }
    dialog = h("dialog.dialog", { "aria-label": t("create.title") });
    const creationDialog = dialog;
    const form = h("form.dialog-body");
    const title = h("input", { required: true, maxLength: 200 });
    const requirements = h("textarea", { required: true, rows: 6, maxLength: 8000 });
    const projects = h("fieldset.stack", null, h("legend", null, t("create.projects")));
    const plan = h("input", { type: "checkbox", checked: true });
    const receipt = receiptLine(t("receipt.notSubmitted"));
    const facets = h("div");
    const submit = button(t("create.plan"), { type: "submit", variant: "primary", disabled: true });
    const close = button(t("actions.close"), { onClick: function () { dialog.close(); } });
    form.append(h("h2", null, t("create.title")), field(t("create.name"), title),
      field(t("goal.requirements"), requirements), projects, field(t("create.plan"), plan, t("create.hint")),
      submit, close, receipt, facets);
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    const choices = [];
    let projectsReady = false;
    let cursor;
    const more = button(t("catalog.next"), { onClick: function () { loadProjects(); } });
    projects.append(more);
    async function loadProjects() {
      more.disabled = true;
      try {
        const result = await options.api.projects(cursor);
        result.projects.forEach(function (project) {
          const control = h("input", { type: "checkbox", value: project.id, disabled: creationDialog.dataset.saved === "true" });
          choices.push(control);
          projects.insertBefore(field(project.name + " · " + project.id, control), more);
        });
        cursor = result.nextCursor;
        more.hidden = !cursor;
        more.disabled = creationDialog.dataset.saved === "true";
        if (!projectsReady) { submit.disabled = false; projectsReady = true; }
      } catch (error) { setReceipt(receipt, error.message, "bad"); more.disabled = creationDialog.dataset.saved === "true"; }
    }
    await loadProjects();
    plan.addEventListener("change", function () { submit.textContent = t(plan.checked ? "create.plan" : "create.only"); });
    form.addEventListener("input", function () { form.dataset.unsent = "true"; });
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (submit.disabled) return;
      submitWrite({
        control: submit, receipt: receipt, form: form, t: t,
        send: function (requestId) {
          return options.api.createTask({ title: title.value.trim(), requirements: requirements.value.trim(),
            projectIds: choices.filter(function (control) { return control.checked; }).map(function (control) { return control.value; }),
            plan: plan.checked, requestId: requestId });
        },
        saved: function (result) {
          creationDialog.dataset.saved = "true";
          [title, requirements, plan, more].concat(choices).forEach(function (control) { control.disabled = true; });
          setReceipt(receipt, t("receipt.saved") + " · " + result.task.id, "ok");
          renderSubmissionFacets(facets, result.submission, t);
          facets.append(button(t("create.open"), { onClick: function () {
            dialog.close(); dialog.remove(); dialog = null;
            options.selectTask(result.task.id);
          } }));
          options.afterWrite();
          return true;
        },
        rejectedKey: "receipt.notSubmittedBecause", unknownKey: "workbench.unknown"
      });
    });
  });
}
`;
