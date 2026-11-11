import { resetViewPrefsForTests } from "../../src/state/viewPrefs";
import { beforeEach } from "vitest";
beforeEach(resetViewPrefsForTests);
// tests/node/gizmo-mode.test.ts — gizmo-mode store (Stage 5, PR5).
//
// Covers the store contract Viewport.tsx / ViewportPane.tsx rely on:
// defaults, mode/grid/wireframe/frame mutations, and the snapshot
// caching useSyncExternalStore requires (see the selection-store test
// for why: a fresh object per getSnapshot() loops React 19 until
// "Maximum update depth exceeded").

import { describe, expect, it } from "vitest";
import { createGizmoModeStore } from "../../src/gizmos/gizmoMode";

describe("gizmo-mode store", () => {
  it("starts in select mode with the grid on and wireframe off", () => {
    const store = createGizmoModeStore();
    expect(store.getSnapshot()).toEqual({
      mode: "select",
      grid: true,
      wireframe: false,
      frameCounter: 0,
      resetCounter: 0,
    });
  });

  it("setMode / toggles / requestFrame change the snapshot and notify", () => {
    const store = createGizmoModeStore();
    let bumps = 0;
    const unsub = store.subscribe(() => {
      bumps += 1;
    });
    store.setMode("translate");
    store.toggleWireframe();
    store.toggleGrid();
    store.requestFrame();
    expect(store.getSnapshot()).toEqual({
      mode: "translate",
      grid: false,
      wireframe: true,
      frameCounter: 1,
      resetCounter: 0,
    });
    expect(bumps).toBe(4);
    unsub();
  });

  it("requestResetView bumps only the reset counter (G-02)", () => {
    const store = createGizmoModeStore();
    let bumps = 0;
    const unsub = store.subscribe(() => {
      bumps += 1;
    });
    store.requestResetView();
    store.requestResetView();
    expect(store.getSnapshot()).toEqual({
      mode: "select",
      grid: true,
      wireframe: false,
      frameCounter: 0,
      resetCounter: 2,
    });
    expect(bumps).toBe(2);
    unsub();
  });

  it("setMode to the current mode is a no-op", () => {
    const store = createGizmoModeStore();
    let bumps = 0;
    store.subscribe(() => {
      bumps += 1;
    });
    store.setMode("select");
    expect(bumps).toBe(0);
  });

  it("getSnapshot() is referentially stable while unchanged (useSyncExternalStore)", () => {
    const store = createGizmoModeStore();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.setMode("rotate");
    const afterMode = store.getSnapshot();
    expect(afterMode).not.toBe(first);
    expect(store.getSnapshot()).toBe(afterMode);
    store.setMode("rotate");
    expect(store.getSnapshot()).toBe(afterMode);
  });
});
