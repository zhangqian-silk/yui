export const WORK_SCRIPT = String.raw`
// Work items and input requests: what the Task is doing and what it is
// waiting on the user for.
import { h, icon } from "/assets/js/lib/dom.js";
import { relativeTime } from "/assets/js/lib/format.js";
import { badge, chip, dot, mono, note, timeTag } from "/assets/js/ui/primitives.js";
import { richText } from "/assets/js/ui/text.js";
import { label, statusBadge, tone } from "/assets/js/domain/vocab.js";

// --- Input requests ----------------------------------------------------------
export function inputCard(input, t, locale, onAnswer) {
  const policy = input.policy && input.policy.kind;
  const element = h("article.input-card");
  element.append(h("div.input-head", null,
    h("span.input-kicker", null, icon("inbox", "icon-sm"), t("input.kicker")),
    policy ? badge(label(t, "input", policy), policy === "required" ? "bad" : "warn") : null,
    input.policy && input.policy.timeoutAt
      ? h("span.input-timeout", null, icon("clock", "icon-sm"),
        t("input.timeoutAt") + " " + relativeTime(input.policy.timeoutAt, locale, t)) : null,
    timeTag(input.createdAt, locale, t)));
  element.append(h("p.input-question", null, input.question));
  const facts = inputFacts(input, t);
  if (facts.length) element.append(h("p.input-facts", null, facts.join("  ·  ")));
  element.append(input.choices && input.choices.length ? inputChoices(input, t, onAnswer) : inputAnswerForm(input, t, onAnswer));
  element.append(h("p.receipt", { role: "status", dataset: { inputReceipt: input.id } }));
  return element;
}

function inputFacts(input, t) {
  const facts = [];
  if (input.requester) facts.push(t("input.from") + " " + input.requester.roleName
    + " · " + (input.requester.runId || input.requester.nativeSessionId || ""));
  if (input.blockedRefs && input.blockedRefs.length) facts.push(t("input.blocks") + " "
    + input.blockedRefs.map(function (ref) { return ref.type + " " + ref.id; }).join(", "));
  return facts;
}

function inputChoices(input, t, onAnswer) {
  const recommended = input.policy && input.policy.recommendedChoiceKey;
  return h("div.input-choices", null, input.choices.map(function (choice) {
    return h("button.choice" + (choice.key === recommended ? ".is-recommended" : ""), {
      type: "button",
      onclick: function (event) { onAnswer(input, { choiceKey: choice.key }, event.currentTarget); }
    }, h("span", null, choice.label), choice.key === recommended ? badge(t("input.recommended"), "accent") : null);
  }));
}

function inputAnswerForm(input, t, onAnswer) {
  const field = h("input", { type: "text", required: true, placeholder: t("input.freeText"), "aria-label": input.question, maxLength: 8000 });
  const form = h("form.input-form", null, field,
    h("button.btn.btn-primary", { type: "submit" }, icon("send"), h("span", null, t("actions.answer"))));
  form.addEventListener("input", function () { form.dataset.unsent = field.value ? "true" : "false"; });
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    const text = field.value.trim();
    if (text) onAnswer(input, { text: text }, form.querySelector("button"));
  });
  return form;
}

// --- Work items --------------------------------------------------------------
export function workItemCard(item, t, locale, titles) {
  const settled = item.status !== "open";
  const element = h(settled ? "details.work-card.is-settled" : "article.work-card");
  element.dataset.viewKey = "work:" + item.id;
  element.append(h(settled ? "summary.work-head" : "header.work-head", null,
    settled ? icon("chevron", "disclosure-chevron") : null,
    dot(tone("work", item.status)),
    h("span.work-title", null, item.title),
    statusBadge(t, "work", "work", item.status)));
  element.append(h("div.work-body", null, workItemBody(item, t, locale, titles)));
  return element;
}

// The body of one work item, shared by the open card and a lazily read row.
export function workItemBody(item, t, locale, titles) {
  const parts = [];
  parts.push(h("div.meta-line", null,
    item.assignee ? h("span.meta-strong", null, icon("user", "icon-sm"), item.assignee) : null,
    mono(item.id), timeTag(item.updatedAt, locale, t)));
  if (item.objective && item.objective !== item.title) parts.push(richText(t("work.objective"), item.objective, t));
  if (item.acceptance && item.acceptance.length) parts.push(acceptanceList(item, t));
  const deps = (item.dependsOn || []).map(function (id) { return (titles && titles[id]) || id; });
  if (deps.length) parts.push(chipLine(t("work.dependsOn"), deps));
  if (item.writeProjectIds && item.writeProjectIds.length) parts.push(chipLine(t("work.writeProjects"), item.writeProjectIds));
  if (item.candidates && item.candidates.length) parts.push(candidateList(item, t, locale));
  if (item.disposition) {
    parts.push(note(t("work.disposition") + ": " + item.disposition.summary
      + (item.disposition.replacementWorkItemId ? " → " + item.disposition.replacementWorkItemId : "")));
  }
  if (item.outcome) parts.push(richText(t("work.outcome"), item.outcome, t, { className: "callout" }));
  return parts.filter(Boolean);
}

function chipLine(title, values) {
  return h("div.meta-line", null, h("span.meta-label", null, title), values.map(function (value) { return chip(value); }));
}

function acceptanceList(item, t) {
  const done = item.status === "accepted";
  return h("div.prose-block", null, h("h4.prose-label", null, t("work.acceptance")),
    h("ul.checklist", null, item.acceptance.map(function (entry) {
      return h("li" + (done ? ".is-done" : ""), null, icon(done ? "check" : "target", "icon-sm"), h("span", null, entry));
    })));
}

function candidateList(item, t, locale) {
  const newestFirst = item.candidates.slice().sort(function (a, b) { return b.sequence - a.sequence; });
  return h("div.prose-block", null, h("h4.prose-label", null, t("work.candidates")),
    h("ol.candidates", null, newestFirst.map(function (candidate) {
      return h("li", null, h("span.candidate-seq", null, "#" + candidate.sequence), h("span", null, candidate.summary),
        h("span.faint", null, candidate.source && candidate.source.type === "run" ? candidate.source.runId : t("work.direct")),
        timeTag(candidate.createdAt, locale, t));
    })));
}
`;
