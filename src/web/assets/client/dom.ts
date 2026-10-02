import { ICON_PATHS } from "../icons.js";

export const DOM_SCRIPT = String.raw`
// Dependency-free DOM helpers shared by every client module.
const ICONS = ${JSON.stringify(ICON_PATHS)};
const SVG = "http://www.w3.org/2000/svg";

export function node(tagName, className, textContent) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (textContent !== undefined && textContent !== null) element.textContent = String(textContent);
  return element;
}

// h("button.btn.btn-primary", { type: "button", onclick }, child, "text", ...)
// Attributes: "class", "dataset", "on<event>" handlers, boolean props and
// plain attributes. Children may be nodes, strings, arrays, null or false.
export function h(spec, attrs) {
  const parts = String(spec).split(".");
  const element = document.createElement(parts[0] || "div");
  if (parts.length > 1) element.className = parts.slice(1).join(" ");
  const children = Array.prototype.slice.call(arguments, 2);
  if (attrs && (attrs instanceof Node || typeof attrs !== "object" || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      const value = attrs[key];
      if (value === undefined || value === null || value === false) return;
      if (key === "class") element.className = (element.className ? element.className + " " : "") + value;
      else if (key === "dataset") Object.assign(element.dataset, value);
      else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
      else if (key in element && typeof value !== "string") element[key] = value;
      else element.setAttribute(key, value === true ? "" : String(value));
    });
  }
  append(element, children);
  return element;
}

function append(element, children) {
  children.forEach(function (child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) append(element, child);
    else element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
}

export function icon(name, className) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "icon" + (className ? " " + className : ""));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  (ICONS[name] || []).forEach(function (d) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  });
  return svg;
}

export function clear(element) {
  element.replaceChildren();
}
`;
