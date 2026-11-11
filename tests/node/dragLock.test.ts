// tests/node/dragLock.test.ts — G-18 reparent drag guard (Tier 2).
//
// Covers src/state/dragLock.ts (the reparent guard is independent of
// the gizmo guard) and src/editor/sceneActions.ts reparentNode (the
// POST carries the passed SceneRef revision — the pointer-down
// revision the Outliner captured at drag start, not the live scene
// prop). The harness test drives the drag itself
// (reparent-drag.spec.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@hermes/plugin-sdk", () => ({
  host: { notify: () => "mock-notify" },
}));

import {
  isGizmoDragging,
  isReparentDragging,
  setGizmoDragging,
  setReparentDragging,
} from "../../src/state/dragLock";
import { reparentNode } from "../../src/editor/sceneActions";
import type { RestFn } from "../../src/api";
import type { SceneEnvelope } from "../../src/types";

beforeEach(() => {
  setGizmoDragging(false);
  setReparentDragging(false);
});

describe("reparent drag guard", () => {
  it("starts false for both guards", () => {
    expect(isGizmoDragging()).toBe(false);
    expect(isReparentDragging()).toBe(false);
  });

  it("setting the reparent guard does not change the gizmo guard", () => {
    setReparentDragging(true);
    expect(isReparentDragging()).toBe(true);
    expect(isGizmoDragging()).toBe(false);
    setReparentDragging(false);
    expect(isReparentDragging()).toBe(false);
    expect(isGizmoDragging()).toBe(false);
  });

  it("setting the gizmo guard does not change the reparent guard", () => {
    setGizmoDragging(true);
    expect(isGizmoDragging()).toBe(true);
    expect(isReparentDragging()).toBe(false);
    setGizmoDragging(false);
    expect(isGizmoDragging()).toBe(false);
  });

  it("the two guards are independent when both are set", () => {
    setGizmoDragging(true);
    setReparentDragging(true);
    expect(isGizmoDragging()).toBe(true);
    expect(isReparentDragging()).toBe(true);
    setGizmoDragging(false);
    expect(isGizmoDragging()).toBe(false);
    expect(isReparentDragging()).toBe(true);
  });
});

function makeRest(
  calls: Array<{ path: string; opts: unknown }>,
): RestFn {
  return (async (path: string, opts?: unknown) => {
    calls.push({ path, opts });
    return {
      ok: true,
      scene: { id: "s1", revision: 8, units: "m", upAxis: "Y" },
      nodes: [],
      materials: [],
      assets: [],
      stats: { tris: 0, verts: 0, materials: 0, nodes: 0 },
      feedback: {
        canUndo: true,
        canRedo: false,
        defaultsAdded: [],
        historyTruncated: false,
      },
    } as SceneEnvelope;
  }) as unknown as RestFn;
}

describe("reparentNode posts the passed SceneRef revision", () => {
  it("drop on a row: PATCH carries baseRevision 7 and the new parent", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    await reparentNode(makeRest(calls), { id: "s1", revision: 7 }, "a", "b");
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/scenes/s1");
    const body = (calls[0].opts as { body: unknown }).body as {
      baseRevision: number;
      ops: Array<Record<string, unknown>>;
    };
    expect(body.baseRevision).toBe(7);
    expect(body.ops).toEqual([{ op: "update_node", id: "a", parent: "b" }]);
  });

  it("drop on the background: parent null, same revision", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    await reparentNode(makeRest(calls), { id: "s1", revision: 7 }, "a", null);
    expect(calls).toHaveLength(1);
    const body = (calls[0].opts as { body: unknown }).body as {
      baseRevision: number;
      ops: Array<Record<string, unknown>>;
    };
    expect(body.baseRevision).toBe(7);
    expect(body.ops).toEqual([{ op: "update_node", id: "a", parent: null }]);
  });
});
