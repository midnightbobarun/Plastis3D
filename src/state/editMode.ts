// src/state/editMode.ts — per-surface mesh edit state and command bus (PR24).
//
// One store per editor route (the pane never edits meshes, D-EXT-06). The Viewport owns the
// running EditSession and writes its state here through `patch`; the toolbar, the key map and
// the status line read it and send commands through `dispatch`. No DOM, no SDK import, so the
// key map and the status text are testable in Node.
import { useSyncExternalStore } from "react";
import type { PickMode } from "../scene/meshEdit";
import type { BrushType } from "../scene/sculpt/brushes";

/** Mesh edit, Sculpt (B) and Paint (P) share one session and one bake on leaving (PR29). */
export type EditTool = "mesh" | "sculpt" | "paint";
export interface BrushState { type: BrushType; /** radius in screen pixels, projected to the world at the hit. */ radius: number; strength: number; hardness: number; symmetryX: boolean; color: string }
export const DEFAULT_BRUSH: BrushState = { type: "draw", radius: 48, strength: 0.5, hardness: 0.5, symmetryX: false, color: "#e05a47" };

export type EditCommand =
  | { type: "toggle" }
  | { type: "cancel" }
  | { type: "pick"; mode: PickMode }
  | { type: "extrude" }
  | { type: "delete" }
  | { type: "flip" }
  | { type: "seam" }
  | { type: "tool"; tool: EditTool }
  | { type: "brush"; patch: Partial<BrushState> }
  | { type: "fill" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "restore" }
  | { type: "discard" }
  | { type: "confirm"; ok: boolean };

export interface EditSnapshot {
  active: boolean;
  /** A bake or a draft restore is in flight. */
  busy: boolean;
  pick: PickMode;
  nodeId: string | null;
  nodeName: string;
  /** How many of the current pick type are selected. */
  selected: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** An unsaved draft exists for this node (Restore / Discard offer). */
  restoreOffer: { savedAt: number; changed: boolean } | null;
  /** The node has a generator: ask before ending its settings. */
  confirmGenerator: string | null;
  tool: EditTool;
  brush: BrushState;
}

export const IDLE_EDIT: EditSnapshot = {
  active: false, busy: false, pick: "face", nodeId: null, nodeName: "", selected: 0, dirty: false,
  canUndo: false, canRedo: false, restoreOffer: null, confirmGenerator: null, tool: "mesh", brush: DEFAULT_BRUSH,
};

export interface EditModeStore {
  getSnapshot(): EditSnapshot;
  subscribe(fn: () => void): () => void;
  patch(partial: Partial<EditSnapshot>): void;
  dispatch(command: EditCommand): void;
  /** The Viewport registers its session handler here; returns the unregister function. */
  setHandler(handler: ((command: EditCommand) => void) | null): () => void;
}

export function createEditModeStore(): EditModeStore {
  let snapshot: EditSnapshot = IDLE_EDIT;
  let handler: ((command: EditCommand) => void) | null = null;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    patch(partial) {
      const next = { ...snapshot, ...partial };
      if (Object.keys(partial).every((key) => (snapshot as unknown as Record<string, unknown>)[key] === (partial as Record<string, unknown>)[key])) return;
      snapshot = next;
      for (const fn of [...listeners]) fn();
    },
    dispatch(command) {
      // The pick mode is state the toolbar shows even before a session reads it.
      if (command.type === "pick") this.patch({ pick: command.mode });
      handler?.(command);
    },
    setHandler(next) {
      handler = next;
      return () => { if (handler === next) handler = null; };
    },
  };
}

export function useEditMode(store: EditModeStore): EditSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The save-status text while a session is open (ui-design §Export and save status). */
export function editingStatus(snapshot: EditSnapshot): string | null {
  return snapshot.active ? (snapshot.busy ? "Saving…" : "Editing — saves when you finish") : null;
}
