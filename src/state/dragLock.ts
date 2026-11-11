// src/state/dragLock.ts — gizmo-drag guard (Stage 5, PR5).
//
// While a gizmo drag is down, surfaces drop incoming `scene.changed`
// payloads and `editor.focus` events instead of applying them: the
// pointer-up POST goes out first with the pointer-down baseRevision.
// The focus handler (plugin.tsx / Editor.tsx) reads this flag; the
// gizmo manager (src/gizmos/GizmoManager.ts) sets it on drag start
// and clears it on drag end / cancel. Module-level booleans are the
// whole mechanism — no React state, no SDK import. A second boolean
// (G-18) guards outliner reparent drags separately: the reparent
// guard is read only by the scene arrival paths and the editor.focus
// handler, never by keybindings or the Viewport rebuild effect.

let dragging = false;
const dragListeners = new Set<() => void>();
export function subscribeDragLock(fn: () => void): () => void { dragListeners.add(fn); return () => { dragListeners.delete(fn); }; }

/** True while a gizmo handle is held down. */
export function isGizmoDragging(): boolean {
  return dragging;
}

/** Set by the gizmo manager on drag start / end / cancel. */
export function setGizmoDragging(value: boolean): void {
  dragging = value;
  for (const listener of dragListeners) listener();
}

let reparentDragging = false;

/**
 * True while an outliner reparent drag is down (G-18). Separate from
 * the gizmo guard: the reparent guard is read only by the two scene
 * arrival paths (sceneQuery) and the editor.focus handler — it must
 * NOT disable keybindings, hold Viewport rebuilds, or defer focus the
 * way the gizmo guard does.
 */
export function isReparentDragging(): boolean {
  return reparentDragging;
}

/** Set by the Outliner on reparent drag start / settlement. */
export function setReparentDragging(value: boolean): void {
  reparentDragging = value;
}
