// src/state/editorOpen.ts — is the full editor route mounted right now?
//
// The viewport pane and the editor route are two surfaces of one plugin
// bundle. When the editor is open, a second live 3D view in the pane only
// costs space and a WebGL context, so the pane shows a slim pointer instead.
// The harness mock host renders every route and pane at once, so it opts out
// (window.__plastis3dMock present and not asking for collapse).
import { useSyncExternalStore } from "react";

let openCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Called by the editor route on mount; returns the unmount cleanup. */
export function markEditorOpen(): () => void {
  openCount += 1;
  emit();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    openCount -= 1;
    emit();
  };
}

/** False in the harness mock host (which renders every surface at once) unless a test opts in. */
export function collapseAllowed(): boolean {
  const mock = (globalThis as { __plastis3dMock?: { collapsePane?: boolean } }).__plastis3dMock;
  return !mock || mock.collapsePane === true;
}

function snapshot(): boolean {
  return openCount > 0 && collapseAllowed();
}

/** True while the editor route is open and the pane should stand down. */
export function useEditorOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
    () => false,
  );
}
