export const RESIZER_SCRIPT = String.raw`
// A column divider (role="separator") that resizes by pointer drag, arrow /
// Home / End keys and an optional double-click reset. Dragging is a desktop
// gesture: below the narrow breakpoint the columns stack and nothing resizes.
//
// options: narrow (breakpoint px), bodyClass (set on <body> while dragging),
// drag(event), release() after a drag, keyWidth(event) → width or null,
// setWidth(width) for keyboard changes, reset() on double-click.
export function bindResizeHandle(handle, options) {
  let dragging = false;
  handle.addEventListener("pointerdown", function (event) {
    if (event.button !== 0 || window.innerWidth <= options.narrow) return;
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add(options.bodyClass);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", function (event) {
    if (dragging) options.drag(event);
  });
  function finish() {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove(options.bodyClass);
    options.release();
  }
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", function (event) {
    const width = options.keyWidth(event);
    if (width === null) return;
    event.preventDefault();
    options.setWidth(width);
  });
  if (options.reset) handle.addEventListener("dblclick", options.reset);
}
`;
