// src/state/selection.ts — per-surface node selection (Stage 5, PR5).
//
// One store instance per surface (the editor route and the viewport
// pane each own one; selection is NOT global — ui-design-first-draft
// §"Selection is single and per surface"). The store holds an ordered
// list of selected node ids; the primary is the most recently selected
// id (the gizmo attaches to it). Multi-select (PR5 decision, stage-5
// §4.4):
//   - plain click: replace the selection with that node;
//   - Ctrl/Cmd-click: toggle that node in the selection;
//   - Shift-click: range-select from the anchor to that node in the
//     given visible order (outliner rows or canvas pick order).
// No marquee in 0.1.0 (deferred; recorded in the PR5 report).
// The store is plain TS + useSyncExternalStore: no DOM, no SDK import,
// so Vitest can test it directly.

import { useSyncExternalStore } from "react";

export interface SelectionSnapshot {
  /** Selected node ids in selection order; the primary is last. */
  ids: string[];
  /** The primary (most recently selected) id, or null. */
  primary: string | null;
}

export interface SelectionStore {
  getSnapshot(): SelectionSnapshot;
  subscribe(fn: () => void): () => void;
  /** Replace the selection with one node (plain click). */
  select(id: string): void;
  /** Toggle one node (Ctrl/Cmd-click). */
  toggle(id: string): void;
  /** Range-select from the anchor to `id` in `orderedIds` (Shift-click). */
  selectRange(anchorId: string | null, id: string, orderedIds: string[]): void;
  /** Replace the whole selection (restore by node id, or clear). */
  set(ids: string[]): void;
  /** Drop one id (e.g. the node was deleted). */
  remove(id: string): void;
  /** Clear the selection. */
  clear(): void;
  /** The anchor for the next Shift-click range (last plain selection). */
  anchor(): string | null;
}

export function createSelectionStore(): SelectionStore {
  let ids: string[] = [];
  let anchorId: string | null = null;
  const listeners = new Set<() => void>();

  // Cached snapshot (merge fix, PR5 report): useSyncExternalStore
  // requires getSnapshot() to return the SAME reference while the data
  // is unchanged — a fresh object on every call makes React 19 loop
  // until "Maximum update depth exceeded" (proven by the gizmos agent:
  // the ViewportPane crashed on mount before this cache existed).
  // The cache is dropped by bump(), i.e. on every real change.
  let cached: SelectionSnapshot | null = null;

  function bump(): void {
    cached = null;
    for (const fn of [...listeners]) fn();
  }

  function snapshot(): SelectionSnapshot {
    if (cached === null) {
      cached = {
        ids: [...ids],
        primary: ids.length > 0 ? ids[ids.length - 1] : null,
      };
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
    select(id: string): void {
      if (ids.length === 1 && ids[0] === id) return;
      ids = [id];
      anchorId = id;
      bump();
    },
    toggle(id: string): void {
      const at = ids.indexOf(id);
      if (at >= 0) {
        ids = ids.filter((x) => x !== id);
        if (anchorId === id) anchorId = ids.length > 0 ? ids[ids.length - 1] : null;
      } else {
        ids = [...ids, id];
        anchorId = id;
      }
      bump();
    },
    selectRange(
      anchor: string | null,
      id: string,
      orderedIds: string[],
    ): void {
      const from = anchor !== null ? orderedIds.indexOf(anchor) : -1;
      const to = orderedIds.indexOf(id);
      if (to < 0) {
        // Unknown id: treat as a plain select.
        ids = [id];
        anchorId = id;
        bump();
        return;
      }
      if (from < 0) {
        ids = [id];
        anchorId = id;
        bump();
        return;
      }
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const range = orderedIds.slice(lo, hi + 1);
      // Keep any selection outside the range, then append the range in
      // order (primary ends up the clicked id when the range runs
      // forward; when it runs backward the anchor stays primary — the
      // clicked id is still in the set, which is what the gizmo needs).
      const outside = ids.filter((x) => !range.includes(x));
      ids = [...outside, ...range];
      bump();
    },
    set(next: string[]): void {
      if (next.length === ids.length && next.every((x, i) => x === ids[i])) {
        return;
      }
      ids = [...next];
      anchorId = ids.length > 0 ? ids[ids.length - 1] : null;
      bump();
    },
    remove(id: string): void {
      if (!ids.includes(id)) return;
      ids = ids.filter((x) => x !== id);
      if (anchorId === id) anchorId = ids.length > 0 ? ids[ids.length - 1] : null;
      bump();
    },
    clear(): void {
      if (ids.length === 0) return;
      ids = [];
      anchorId = null;
      bump();
    },
    anchor(): string | null {
      return anchorId;
    },
  };
}

/** React hook: the selection snapshot for a store instance. */
export function useSelection(store: SelectionStore): SelectionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
