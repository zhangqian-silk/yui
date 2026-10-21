import { BREAKPOINTS } from "../shared/geometry.js";
import { motionKeyframes } from "../shared/motion.js";

/*
 * MOTION — the shared animation library. Timings, curves and layers are the
 * tokens generated from shared/motion.ts; this sheet holds the keyframes and
 * the component motion that is the same everywhere:
 *   dialogs      scale + fade in, quicker fade out; the backdrop fades
 *                (@starting-style + allow-discrete, as Radix Dialog does)
 *   popovers     <details> menus pop in from their anchor
 *   press        buttons settle slightly under the pointer
 *   pages        cross-document View Transitions between Workbench, Models
 *                and Settings; the rail stays put
 *   layout       same-document View Transitions for column changes (the
 *                client wraps sidebar collapse and dock open/close)
 * Everything honours prefers-reduced-motion (base.ts turns it all off).
 */
export const MOTION_STYLES = `
${motionKeyframes()}
.dialog{opacity:0;transform:scale(.96);transition:opacity var(--t-exit) var(--ease-exit),transform var(--t-exit) var(--ease-exit),overlay var(--t-exit) allow-discrete,display var(--t-exit) allow-discrete}
.dialog[open]{opacity:1;transform:none;transition-duration:var(--t-base);transition-timing-function:var(--ease-standard)}
.dialog::backdrop{opacity:0;transition:opacity var(--t-exit) var(--ease-exit),overlay var(--t-exit) allow-discrete,display var(--t-exit) allow-discrete}
.dialog[open]::backdrop{opacity:1;transition-duration:var(--t-base)}
@starting-style{.dialog[open]{opacity:0;transform:scale(.96)}.dialog[open]::backdrop{opacity:0}}
details[open]>.cv-popbody,details[open]>.dock-target-menu{animation:m-pop var(--t-base) var(--ease-standard)}
.cv-attach>.cv-popbody,.cv-model>.cv-popbody{transform-origin:bottom left}
.cv-model>.cv-popbody{transform-origin:bottom right}
.cv-menu>.cv-popbody{transform-origin:top right}
.dock-target-menu{transform-origin:top left}
.icon-btn:active:not(:disabled),.rail-item:active{transform:scale(.94)}
/* Workbench ⇄ Models ⇄ Settings are separate documents: the browser
   cross-fades them (no blank frame) and the rail stays put between them. */
@view-transition{navigation:auto}
::view-transition-old(root),::view-transition-new(root){animation-duration:var(--t-page);animation-timing-function:var(--ease-sheet)}
@media(prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation:none!important}}
/* Page content entering after an explicit navigation (client/lib/motion). */
.m-enter{animation:m-rise var(--t-base) var(--ease-standard)}
@media(min-width:${BREAKPOINTS.narrow + 1}px){
  .app-rail{view-transition-name:app-rail}
  /* Column changes: client/lib/motion sets .vt-layout for the transition
     only. Each column glides between its old and new box showing its new
     content (no double image); a column that appears or leaves fades. */
  .vt-layout .sidebar{view-transition-name:sidebar}
  .vt-layout .center{view-transition-name:center}
  .vt-layout .dock{view-transition-name:dock}
  ::view-transition-group(sidebar),::view-transition-group(center),::view-transition-group(dock){animation-duration:var(--t-layout);animation-timing-function:var(--ease-sheet);overflow:clip}
  ::view-transition-old(sidebar),::view-transition-new(sidebar),::view-transition-old(center),::view-transition-new(center),::view-transition-old(dock),::view-transition-new(dock){width:100%;height:100%;object-fit:none;object-position:0 0;animation:none}
  ::view-transition-old(sidebar),::view-transition-old(center),::view-transition-old(dock){opacity:0}
  ::view-transition-old(sidebar):only-child,::view-transition-old(dock):only-child{opacity:1;animation:m-fade var(--t-exit) var(--ease-exit) reverse both}
  ::view-transition-new(sidebar):only-child,::view-transition-new(dock):only-child{animation:m-fade var(--t-layout) var(--ease-standard) both}
}
`;
