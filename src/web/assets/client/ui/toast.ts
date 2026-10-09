export const TOAST_SCRIPT = String.raw`
// A transient status message; a newer message replaces the current one.
export function createToast(element) {
  let timer = null;
  return function showToast(message) {
    element.textContent = message;
    element.classList.add("show");
    window.clearTimeout(timer);
    timer = window.setTimeout(function () { element.classList.remove("show"); }, 3200);
  };
}
`;
