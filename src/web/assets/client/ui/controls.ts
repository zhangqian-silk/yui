export const CONTROLS_SCRIPT = String.raw`
// Selection controls: the segmented radio group and the scrollable tab row.
import { h, markSelected } from "/assets/js/lib/dom.js";

export function segmented(name, options, value, onChange) {
  const group = h("div.seg.seg-sm", { role: "radiogroup" });
  options.forEach(function (option) {
    const item = h("button.seg-btn", {
      type: "button", role: "radio", title: option.title || null,
      "aria-checked": String(option.value === value),
      dataset: { value: option.value },
      onclick: function () {
        markSelected(group.querySelectorAll(".seg-btn"), "aria-checked", function (other) { return other === item; });
        onChange(option.value);
      }
    }, option.label);
    group.append(item);
  });
  group.dataset.name = name;
  return group;
}

// A tab row that keeps its horizontal scroll position across updates. When
// it is too narrow for every tab, the clipped edge fades out (data-fade), the
// wheel scrolls it sideways and revealTab() brings a tab into view.
export function scrollableTabRow(row) {
  row.addEventListener("scroll", function () { syncTabsOverflow(row); }, { passive: true });
  row.addEventListener("wheel", function (event) {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || row.scrollWidth <= row.clientWidth) return;
    event.preventDefault();
    row.scrollLeft += event.deltaY;
  }, { passive: false });
  new ResizeObserver(function () { syncTabsOverflow(row); }).observe(row);
  return row;
}

export function syncTabsOverflow(row) {
  const max = row.scrollWidth - row.clientWidth;
  const before = row.scrollLeft > 1;
  const after = row.scrollLeft < max - 1;
  row.dataset.fade = before && after ? "both" : after ? "end" : before ? "start" : "none";
}

export function revealTab(row, tab) {
  const margin = 28;
  const left = tab.offsetLeft - margin;
  const right = tab.offsetLeft + tab.offsetWidth + margin;
  if (left < row.scrollLeft) row.scrollLeft = Math.max(0, left);
  else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
}
`;
