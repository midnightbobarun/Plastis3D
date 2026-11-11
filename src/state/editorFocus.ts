// src/state/editorFocus.ts — deferred editor.focus handling (Stage 5, PR5).
//
// Both the editor route and the viewport subscribe to
// `plugin.plastis3d.editor.focus`. On focus the surface sets the
// source-scoped scene, navigates to `/plastis3d?scene=<id>`, and
// refetches — but NOT while a gizmo drag is down: the pointer-up POST
// goes out first with the pointer-down baseRevision, and navigation
// runs only after that POST settles. So a focus that arrives mid-drag
// is DEFERRED here, not dropped: the gizmo manager calls
// flushDeferredFocus() on drag end (pointer-up completion and Escape
// cancel), which runs the flusher the plugin registered in register().
// No React state, no SDK import.

export interface EditorFocusPayload {
  sceneId: string;
  sourceKey: string;
}

let deferred: EditorFocusPayload | null = null;
let flusher: ((payload: EditorFocusPayload) => void) | null = null;

/** The plugin registers its focus handler (navigate + set + refetch). */
export function registerFocusFlusher(
  fn: (payload: EditorFocusPayload) => void,
): void {
  flusher = fn;
}

/** Hold a focus payload until the current gizmo drag ends. */
export function deferEditorFocus(payload: EditorFocusPayload): void {
  deferred = payload;
}

/** Take the deferred payload (once — it is cleared by taking). */
export function takeDeferredFocus(): EditorFocusPayload | null {
  const taken = deferred;
  deferred = null;
  return taken;
}

/**
 * Called by the gizmo manager on drag end: run the deferred focus,
 * if any, through the registered flusher. No-op when nothing is
 * deferred or no flusher is registered.
 */
export function flushDeferredFocus(): void {
  if (!deferred || !flusher) return;
  const payload = deferred;
  deferred = null;
  flusher(payload);
}
