export const TEXT_SCRIPT = String.raw`
// Agent and user prose: rendered Markdown that collapses when long.
import { h } from "/assets/js/lib/dom.js";
import { renderMarkdown } from "/assets/js/lib/markdown.js";

function shouldCollapse(text, threshold) {
  const value = String(text);
  if (value.length > (threshold || 700)) return true;
  let lines = 0;
  for (let index = 0; index < value.length; index += 1) if (value[index] === "\n") lines += 1;
  return lines > 12;
}

export function richText(title, text, t, options) {
  if (!text) return null;
  const opts = options || {};
  const block = h("div.prose-block" + (opts.className ? "." + opts.className : ""));
  if (title) block.append(h("h4.prose-label", null, title));
  const body = h("div.md" + (opts.muted ? ".muted" : ""));
  body.innerHTML = renderMarkdown(text);
  block.append(body);
  if (shouldCollapse(text, opts.threshold)) {
    block.classList.add("is-collapsed");
    const toggle = h("button.link-btn", { type: "button" }, t("actions.showMore"));
    toggle.addEventListener("click", function () {
      const collapsed = block.classList.toggle("is-collapsed");
      toggle.textContent = t(collapsed ? "actions.showMore" : "actions.showLess");
    });
    block.append(toggle);
  }
  return block;
}
`;
