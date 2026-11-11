// src/state/announcer.ts — shared live-region announcer store (Phase 0, 0-B).
//
// ONE shared module store for both surfaces (the pane and the editor
// route each render a LiveRegion, but they read this same store), so a
// broadcast-driven revision change is announced ONCE across surfaces
// even when both are mounted (round-3 Issue 9 erratum).
//
// Same useSyncExternalStore + cached-snapshot pattern as selection.ts /
// gizmoMode.ts (PR5's merge fix: a fresh object per getSnapshot() loops
// React 19, so the snapshot is cached and dropped on change).
//
// Announce only broadcast-driven revision changes ("Scene updated to
// revision N"), toast-worthy events, and loading states — never poll
// ticks, never the 4 s refetch. The announce() call sites land with
// G-06 (Phase 4); this module + LiveRegion are the infrastructure.
// Pure TS + react: no DOM, no SDK import, so Vitest can test it directly.

import { useSyncExternalStore } from "react";

export interface AnnouncerSnapshot {
  /** The current announcement text (empty before the first announce). */
  message: string;
  /**
   * Increments on every announcement, so an identical message still
   * re-announces: the snapshot reference changes and React re-renders
   * the region with the same text.
   */
  seq: number;
}

let message = "";
let seq = 0;
/** The dedup key of the last keyed announcement, or null. */
let lastDedupKey: string | null = null;
const listeners = new Set<() => void>();

// Cached snapshot (PR5 pattern — see selection.ts): getSnapshot() must
// return the SAME reference while the data is unchanged.
let cached: AnnouncerSnapshot | null = null;

function bump(): void {
  cached = null;
  for (const fn of [...listeners]) fn();
}

export function getAnnouncerSnapshot(): AnnouncerSnapshot {
  if (cached === null) {
    cached = { message, seq };
  }
  return cached;
}

export function subscribeAnnouncer(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Announce `text` through the live region. An identical message
 * re-announces (the seq bumps, so React re-renders the region).
 *
 * When `dedupKey` is given and equals the last announced key, the call
 * is a no-op: each (scene, revision) is announced once across surfaces,
 * even when both surfaces' announce paths fire for the same broadcast.
 * An unkeyed announcement clears the last key, so a later keyed
 * announcement with the same key announces again (the region showed
 * something else in between).
 */
export function announce(text: string, opts?: { dedupKey?: string }): void {
  const key = opts?.dedupKey ?? null;
  if (key !== null && key === lastDedupKey) return;
  lastDedupKey = key;
  message = text;
  seq += 1;
  bump();
}

/**
 * Announce a broadcast-driven revision change: "Scene updated to
 * revision N", deduped per (scene, revision) across surfaces.
 */
export function announceRevision(sceneId: string, revision: number): void {
  announce(`Scene updated to revision ${revision}.`, {
    dedupKey: `scene:${sceneId}:rev:${revision}`,
  });
}

/**
 * Announce a scene load: "Loading scene…", deduped per (source,
 * scene) so two mounted surfaces announce the same load once
 * (round-3 Issue 9, same principle as the revision dedup). A
 * revision announcement in between changes the key, so a later load
 * of the same scene announces again; two loads of the same scene
 * with no other announcement between them announce once (the region
 * already says it is loading).
 */
export function announceLoadingScene(
  sourceKey: string,
  sceneId: string,
): void {
  announce("Loading scene…", {
    dedupKey: `loading:${sourceKey}:${sceneId}`,
  });
}

/** React hook: the announcer snapshot for the shared store. */
export function useAnnouncer(): AnnouncerSnapshot {
  return useSyncExternalStore(subscribeAnnouncer, getAnnouncerSnapshot);
}
