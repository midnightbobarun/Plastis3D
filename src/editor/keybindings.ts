// src/editor/keybindings.ts — the editor key map (Stage 5, PR5).
//
// Listeners live on the plugin root (the Editor's root div, attached via
// ctx.addEventListener) — never KEYBINDS_AREA, never window
// (standalone-editor.md decision 14; ui-design-first-draft §"Keys live on
// the plugin root"). The guard is a pure function so Vitest can test it
// without a DOM: typing "water" in an input must not switch gizmo mode.
//
// While a gizmo drag is down every scene chord is ignored, including
// undo; Escape during a drag is the gizmo manager's (it restores the
// pointer-down transform). Escape outside a drag blurs the active field
// and changes nothing.

import { isGizmoDragging } from "../state/dragLock";
import { closeOpenDock } from "../ui/DockShell";
import type { GizmoMode, GizmoModeStore } from "../gizmos/gizmoMode";
import type { SelectionStore } from "../state/selection";
import type { EditModeStore } from "../state/editMode";

/** The key chords the editor handles (ui-design-first-draft §"Keyboard"). */
export const EDITOR_KEYS = {
  select: "q",
  translate: "w",
  rotate: "e",
  scale: "r",
  frame: "f",
  grid: "g",
  hide: "h",
} as const;

/**
 * True when a key event must NOT reach the scene chords: the target is a
 * form field (input / textarea / select / contenteditable) or lives inside
 * a dialog. Duck-typed (tagName / isContentEditable / closest) so the
 * function is testable in Node with fake targets; real DOM elements
 * satisfy the same shape.
 */
export function shouldIgnoreKey(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    closest?: unknown;
  };
  if (el.isContentEditable) return true;
  if (typeof el.tagName === "string") {
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return true;
    }
  }
  if (typeof el.closest === "function") {
    try {
      if (
        (el.closest as (selector: string) => unknown).call(
          target,
          '[role="dialog"]',
        )
      ) {
        return true;
      }
    } catch {
      // A target whose closest() throws is not inside a dialog.
    }
  }
  return false;
}

/**
 * W/E/R are single-node modes: with more than one node selected the
 * gizmo cannot rotate or scale around one pivot in 0.1.0, so a rotate or
 * scale request forces translate. Applies to both the keys and the
 * toolbar buttons (same helper, one rule).
 */
export function resolveModeForSelection(
  mode: GizmoMode,
  selectionCount: number,
): GizmoMode {
  if (selectionCount > 1 && (mode === "rotate" || mode === "scale")) {
    return "translate";
  }
  return mode;
}

export interface EditorKeyDeps {
  /** The mesh edit store (PR24): M, 1/2/3, Delete and Mod+Z mean something else while editing. */
  editMode?: EditModeStore;
  gizmoMode: GizmoModeStore;
  selection: SelectionStore;
  /** The open scene's id + revision, or null when no scene is open. */
  getScene: () => { id: string; revision: number } | null;
  /**
   * Undo/redo gates (N-11): the keyboard path is silent when the
   * history is empty, matching the disabled header buttons. These read
   * from the scene envelope's feedback via a ref in the Editor (NOT
   * sceneRef.current.feedback — sceneRef is {id, revision, nodes} and
   * has no feedback field; and the handler is bound once, so a closure
   * over sceneQuery.data would go stale).
   */
  canUndo: () => boolean;
  canRedo: () => boolean;
  /** Toggle `visible` on every selected node (one PATCH — see D-PLAN-05). */
  onToggleVisibility: () => void;
  /** Open the delete confirm for the selection. */
  onDeleteRequest: () => void;
  /** duplicate_node on the selection. */
  onDuplicate: () => void;
  onUndo: () => void;
  onRedo: () => void;
  /** Mod+S: Save as GLB. Absent in surfaces that cannot save (the viewport pane). */
  onSave?: () => void;
  /** F2: open the scene rename field. */
  onRename?: () => void;
}

/**
 * Build the root keydown handler. The caller attaches it with
 * ctx.addEventListener on the editor root div. Pure except for the store
 * writes and the dep callbacks; safe to call with a fake KeyboardEvent
 * in Node tests (preventDefault/blur are guarded).
 */
export function createEditorKeyHandler(
  deps: EditorKeyDeps,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    // A gizmo drag owns every key until it ends (its manager handles
    // Escape); no scene chord runs while the pointer is down.
    if (isGizmoDragging()) return;

    const target = event.target as EventTarget | null;
    const editing = deps.editMode?.getSnapshot().active === true;
    if (event.key === "Escape" && editing && !shouldIgnoreKey(target)) {
      // Leaving the mode (M or Escape) bakes once (PR24).
      if (typeof event.preventDefault === "function") event.preventDefault();
      deps.editMode?.dispatch({ type: "toggle" });
      return;
    }
    if (event.key === "Escape" && closeOpenDock()) {
      // A narrow-stage tool dock was open: Escape only folds it.
      if (typeof event.preventDefault === "function") event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      // Blur the field and change nothing. A field's own Escape handler
      // reverts its draft first; this only moves focus away.
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      const el = target as { blur?: unknown } | null;
      if (el && typeof el.blur === "function") {
        (el.blur as () => void).call(target);
      } else if (
        typeof document !== "undefined" &&
        document.activeElement instanceof HTMLElement
      ) {
        document.activeElement.blur();
      }
      return;
    }

    if (shouldIgnoreKey(target)) return;
    if (event.altKey) return;

    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (mod && key === "z") {
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      if (editing) {
        // Inside the mode, undo steps the local edit; outside it, one undo reverses the session.
        deps.editMode?.dispatch({ type: event.shiftKey ? "redo" : "undo" });
        return;
      }
      // N-11: empty history is a silent no-op on the keyboard path —
      // no call, no toast — matching the disabled header buttons. (A
      // genuine HISTORY_EMPTY from a race still toasts in doUndo's
      // catch; that path is unchanged.)
      if (event.shiftKey) {
        if (deps.canRedo()) deps.onRedo();
      } else {
        if (deps.canUndo()) deps.onUndo();
      }
      return;
    }
    if (mod && key === "d" && editing) return;
    if (mod && key === "d") {
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      deps.onDuplicate();
      return;
    }
    if (mod && key === "s") {
      // Mod+S is Save as GLB. The browser's own "save page" never runs; while a mesh is being edited
      // the export would miss the unsaved edit, so nothing is saved until Done.
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (!editing) deps.onSave?.();
      return;
    }
    // Any other modified chord is not a scene chord.
    if (mod) return;

    const selectionCount = deps.selection.getSnapshot().ids.length;
    if (key === "m" && deps.editMode) {
      deps.editMode.dispatch({ type: "toggle" });
      return;
    }
    // B is Sculpt and P is Paint (PR29): they start a session, or switch the tool inside one.
    if ((key === "b" || key === "p") && deps.editMode) {
      deps.editMode.dispatch({ type: "tool", tool: key === "b" ? "sculpt" : "paint" });
      return;
    }
    if (editing && (key === "[" || key === "]") && deps.editMode) {
      const snap = deps.editMode.getSnapshot();
      if (snap.tool !== "mesh") deps.editMode.dispatch({ type: "brush", patch: { radius: Math.min(400, Math.max(4, Math.round(snap.brush.radius * (key === "]" ? 1.2 : 1 / 1.2)))) } });
      return;
    }
    if (editing && (key === "1" || key === "2" || key === "3")) {
      deps.editMode?.dispatch({ type: "pick", mode: key === "1" ? "vertex" : key === "2" ? "edge" : "face" });
      return;
    }
    if (editing && (key === "delete" || key === "backspace")) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      deps.editMode?.dispatch({ type: "delete" });
      return;
    }
    switch (key) {
      case "q":
        deps.gizmoMode.setMode("select");
        break;
      case "w":
      case "e":
      case "r": {
        const mode: GizmoMode =
          key === "w" ? "translate" : key === "e" ? "rotate" : "scale";
        deps.gizmoMode.setMode(resolveModeForSelection(mode, selectionCount));
        break;
      }
      case "f":
        deps.gizmoMode.requestFrame();
        break;
      case "g":
        deps.gizmoMode.toggleGrid();
        break;
      case "h":
        deps.onToggleVisibility();
        break;
      case "f2":
        if (!editing && deps.onRename) {
          if (typeof event.preventDefault === "function") event.preventDefault();
          deps.onRename();
        }
        break;
      case "delete":
      case "backspace":
        if (typeof event.preventDefault === "function") {
          event.preventDefault();
        }
        deps.onDeleteRequest();
        break;
      default:
        break;
    }
  };
}
