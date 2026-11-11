// src/state/activeScene.ts — the active scene per source (Stage 5, PR5;
// split in two by the E-12 re-plan, D-REPLAN-02).
//
// FORMAL RULE (E-12 re-plan; UI doc :270 as amended): the active scene
// is the editor selection when the editor route is mounted (written by
// ?scene=, the editor picker, scene creation, handleFocus, and the
// mount-write, which seeds it from the pane selection / first in list),
// else the pane selection (written by the Scenes-pane click and the
// pane picker, and locked to the first scene of the list when it first
// loads, so a later re-ordering never moves it), else first in list
// order, per sourceKey. No scenes -> null.
//
// The two selections are stored separately per source so a Scenes-pane
// click changes the viewport pane's scene only and never steals the
// editor's scene: the resolver falls through editor -> pane -> first
// -> null, and each branch requires the id to still be in the list.
// ?scene= naming an unknown id does NOT set a selection — the editor
// route shows an ErrorState for it (see Editor.tsx);
// setEditorSceneIdFromQuery returns false in that case.

import { useSyncExternalStore } from "react";

/** The editor route's selection per source (null while unmounted). */
const editorSelection = new Map<string, string>();
/** The viewport pane's selection per source. */
const paneSelection = new Map<string, string>();
/** The current list order per source (set by whichever pane loaded it). */
const available = new Map<string, string[]>();

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
  version += 1;
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The active scene id for a source, or null when there is no scene.
 * Fall-through: editor selection if non-null AND in the list; else
 * pane selection if non-null AND in the list; else first in list
 * order; else null.
 */
export function getActiveSceneId(sourceKey: string): string | null {
  const ids = available.get(sourceKey) ?? [];
  const editor = editorSelection.get(sourceKey);
  if (editor !== undefined && ids.includes(editor)) return editor;
  const pane = paneSelection.get(sourceKey);
  if (pane !== undefined && ids.includes(pane)) return pane;
  return ids.length > 0 ? ids[0] : null;
}

/** React hook: the active scene id for a source. */
export function useActiveSceneId(sourceKey: string): string | null {
  return useSyncExternalStore(subscribe, () => getActiveSceneId(sourceKey));
}

/**
 * The pane's scene id for a source: pane selection if non-null and in
 * the list, else first in list, else null. The pane's render read.
 */
export function getPaneSceneId(sourceKey: string): string | null {
  const ids = available.get(sourceKey) ?? [];
  const pane = paneSelection.get(sourceKey);
  if (pane !== undefined && ids.includes(pane)) return pane;
  return ids.length > 0 ? ids[0] : null;
}

/** React hook: the pane's scene id for a source. */
export function usePaneSceneId(sourceKey: string): string | null {
  return useSyncExternalStore(subscribe, () => getPaneSceneId(sourceKey));
}

/** The raw stored editor selection (no fallback) — mount-write only. */
export function getEditorSceneId(sourceKey: string): string | null {
  return editorSelection.get(sourceKey) ?? null;
}

/** Record the current list order for a source (list order = default order). */
export function setAvailableScenes(sourceKey: string, ids: string[]): void {
  // The list is newest-edit-first, so "first in list" moves whenever any scene is edited. Lock the pane's
  // default the first time the list loads (and again if its scene is deleted): the pane then keeps showing
  // the scene it opened on instead of jumping to whichever scene an agent edited last.
  const lockedPane = paneSelection.get(sourceKey);
  if (ids.length > 0 && (lockedPane === undefined || !ids.includes(lockedPane))) {
    paneSelection.set(sourceKey, ids[0]);
  }
  const prev = available.get(sourceKey);
  if (
    prev !== undefined &&
    prev.length === ids.length &&
    prev.every((id, i) => id === ids[i])
  ) {
    return;
  }
  available.set(sourceKey, [...ids]);
  bump();
}

/** The editor route's selection: make `sceneId` the editor selection. */
export function setEditorSceneId(sourceKey: string, sceneId: string): void {
  if (editorSelection.get(sourceKey) === sceneId) return;
  editorSelection.set(sourceKey, sceneId);
  bump();
}

/** Clear the editor selection (Editor unmount — the foreground signal). */
export function clearEditorSceneId(sourceKey: string): void {
  if (!editorSelection.has(sourceKey)) return;
  editorSelection.delete(sourceKey);
  bump();
}

/** The Scenes pane / viewport pane picker: make `sceneId` the pane selection. */
export function setPaneSceneId(sourceKey: string, sceneId: string): void {
  if (paneSelection.get(sourceKey) === sceneId) return;
  paneSelection.set(sourceKey, sceneId);
  bump();
}

/**
 * The editor route's `?scene=` handling: make `sceneId` the editor
 * selection for a source, but ONLY when that id is in the current list
 * (`availableIds`). Returns true when the selection was set; false when
 * the id is unknown — the caller shows an ErrorState for it instead of
 * inventing a selection.
 */
export function setEditorSceneIdFromQuery(
  sourceKey: string,
  sceneId: string,
  availableIds: string[],
): boolean {
  if (!availableIds.includes(sceneId)) return false;
  setEditorSceneId(sourceKey, sceneId);
  return true;
}
