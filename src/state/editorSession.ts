// src/state/editorSession.ts — what the editor route shares with the side panel.
//
// Layout (owner request, 2026-11-10): the full editor route is the 3D view and
// its tools; the pane docked beside it carries the Scene outline and the
// Properties inspector. The two live in one plugin bundle, so they share:
//   - ONE selection store and ONE gizmo-mode store (so a click in the view
//     selects in the outline and the reverse), and
//   - the open scene (spec + stats), published by the editor while it is
//     mounted and cleared when it unmounts.
// When the pane is not visible the editor falls back to showing its own
// panels, so nothing is ever unreachable.
import { useSyncExternalStore } from "react";
import { createGizmoModeStore } from "../gizmos/gizmoMode";
import type { GizmoModeStore } from "../gizmos/gizmoMode";
import { createSelectionStore } from "./selection";
import type { SelectionStore } from "./selection";
import type { SceneSpec, SceneStats } from "../types";

export interface EditorPanelsState {
  scene: SceneSpec;
  stats: SceneStats | null;
  pulseIds?: string[];
  sourceKey: string;
  /** The editor's own shortcut handler, so keys work with focus in the side panel too. */
  onKeyDown?: (event: KeyboardEvent) => void;
}

let selection: SelectionStore | null = null;
let gizmoMode: GizmoModeStore | null = null;
let panels: EditorPanelsState | null = null;
const listeners = new Set<() => void>();

/** The one selection store the editor and its side panel share. */
export function sharedSelection(): SelectionStore {
  return (selection ??= createSelectionStore());
}

/** The one gizmo-mode store the editor and its side panel share. */
export function sharedGizmoMode(): GizmoModeStore {
  return (gizmoMode ??= createGizmoModeStore());
}

/** Editor -> side panel: the open scene, or null when the editor closes. */
export function publishEditorPanels(next: EditorPanelsState | null): void {
  panels = next;
  for (const fn of listeners) fn();
}

export function useEditorPanels(): EditorPanelsState | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => panels,
    () => null,
  );
}
