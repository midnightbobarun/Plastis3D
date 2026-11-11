// src/gizmos/gizmoMode.ts — per-surface gizmo mode state (Stage 5, PR5).
//
// One store instance per surface (the editor route and the viewport
// pane each own one; mode is NOT global — ui-design-first-draft
// §"Selection is single and per surface"). The store holds the
// TransformControls mode, the grid toggle, the wireframe toggle, and
// frame/reset-view request counters. The toolbar rows (Editor.tsx and
// ViewportPane.tsx render their own — there is no shared Toolbar.tsx
// in 0.1.0; see the PR5 report) and the keybinding handler write to
// it; Viewport.tsx reads it and drives the gizmo, the grid, and the
// wireframe rendering. Frame is a request counter, not state: the
// viewport frames on change and the counter is never reset by the
// toolbar. No DOM, no SDK import, so Vitest can test it directly.

import { getViewPrefs, setViewPrefs, useViewPrefs } from "../state/viewPrefs";
import { useSyncExternalStore } from "react";

export type GizmoMode = "select" | "translate" | "rotate" | "scale";

export interface GizmoModeSnapshot {
  mode: GizmoMode;
  grid: boolean;
  wireframe: boolean;
  /** Bumps on every frame request (F key or Frame button). */
  frameCounter: number;
  /** Bumps on every reset-view request (Reset view button). */
  resetCounter: number;
}

export interface GizmoModeStore {
  getSnapshot(): GizmoModeSnapshot;
  subscribe(fn: () => void): () => void;
  setMode(mode: GizmoMode): void;
  toggleGrid(): void;
  toggleWireframe(): void;
  /** Ask the viewport to frame the selection (or the whole scene). */
  requestFrame(): void;
  /** Ask the viewport to reset to the default orbit pose (4, 3, 6) / (0, 0, 0). */
  requestResetView(): void;
}

export function createGizmoModeStore(): GizmoModeStore {
  let mode: GizmoMode = "select";
  let grid = true;
  let wireframe = false;
  let frameCounter = 0;
  let resetCounter = 0;
  const listeners = new Set<() => void>();

  // Cached snapshot (merge fix, PR5 report): same requirement as
  // selection.ts — useSyncExternalStore needs a stable reference
  // while the data is unchanged, or React 19 loops until
  // "Maximum update depth exceeded". Dropped by bump() on every change.
  let cached: GizmoModeSnapshot | null = null;

  function bump(): void {
    cached = null;
    for (const fn of [...listeners]) fn();
  }

  function snapshot(): GizmoModeSnapshot {
    if (cached === null || cached.grid !== getViewPrefs().grid) {
      cached = { mode, grid: getViewPrefs().grid, wireframe, frameCounter, resetCounter };
    }
    return cached;
  }

  return {
    getSnapshot: snapshot,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setMode(next: GizmoMode): void {
      if (next === mode) return;
      mode = next;
      bump();
    },
    toggleGrid(): void {
      grid = !getViewPrefs().grid;
      setViewPrefs({ grid });
      bump();
    },
    toggleWireframe(): void {
      wireframe = !wireframe;
      bump();
    },
    requestFrame(): void {
      frameCounter += 1;
      bump();
    },
    requestResetView(): void {
      resetCounter += 1;
      bump();
    },
  };
}

/** React hook: the gizmo-mode snapshot for a store instance. */
export function useGizmoMode(store: GizmoModeStore): GizmoModeSnapshot {
  useViewPrefs();
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
