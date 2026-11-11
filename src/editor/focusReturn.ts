// src/editor/focusReturn.ts — focus restore after a dialog closes
// (0-C re-plan, D-REPLAN-09).
//
// After every dialog closes, focus returns to the control that opened
// it (G-07). The closer calls restoreFocusDeferred: the dialog
// unmounts synchronously with the state commit, so a
// requestAnimationFrame callback runs after React commits the unmount.
// Never focuses BODY, never throws.

/**
 * Focus the invoker if it is still connected; else the fallback if it
 * is still connected; else do nothing.
 */
export function restoreFocus(
  invoker: HTMLElement | null,
  fallback: HTMLElement | null,
): void {
  if (invoker !== null && invoker.isConnected) {
    invoker.focus();
    return;
  }
  if (fallback !== null && fallback.isConnected) {
    fallback.focus();
  }
}

/** The same restore, deferred one frame (after the dialog unmounts). */
export function restoreFocusDeferred(
  invoker: HTMLElement | null,
  fallback: HTMLElement | null,
): void {
  requestAnimationFrame(() => restoreFocus(invoker, fallback));
}
