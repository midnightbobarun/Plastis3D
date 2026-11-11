// tests/node/toggle-visibility.test.ts — H toggles visibility per node
// (Tier 2, Phase 1 E-06, D-PLAN-05).
//
// Covers src/editor/sceneActions.ts toggleNodesVisibility with a stub
// RestFn: all-visible → all hidden; all-hidden → all visible; mixed →
// each flipped; one PATCH, one op per id. The harness test drives the
// H key itself (toggle-visibility.spec.ts).
import { describe, expect, it, vi } from "vitest";

vi.mock("@hermes/plugin-sdk", () => ({
  host: { notify: () => "mock-notify" },
}));

import { toggleNodesVisibility } from "../../src/editor/sceneActions";
import type { RestFn } from "../../src/api";
import type { SceneEnvelope } from "../../src/types";

function makeRest(
  calls: Array<{ path: string; opts: unknown }>,
): RestFn {
  return (async (path: string, opts?: unknown) => {
    calls.push({ path, opts });
    return {
      ok: true,
      scene: { id: "s1", revision: 2, units: "m", upAxis: "Y" },
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

function patchBody(calls: Array<{ path: string; opts: unknown }>): {
  baseRevision: number;
  ops: Array<Record<string, unknown>>;
} {
  expect(calls).toHaveLength(1);
  expect(calls[0].path).toBe("/scenes/s1");
  return (calls[0].opts as { body: unknown }).body as {
    baseRevision: number;
    ops: Array<Record<string, unknown>>;
  };
}

describe("toggleNodesVisibility", () => {
  it("all-visible → all hidden, one PATCH, one op per id", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    await toggleNodesVisibility(
      makeRest(calls),
      { id: "s1", revision: 1 },
      ["a", "b"],
      new Map([
        ["a", true],
        ["b", true],
      ]),
    );
    const body = patchBody(calls);
    expect(body.baseRevision).toBe(1);
    expect(body.ops).toEqual([
      { op: "update_node", id: "a", visible: false },
      { op: "update_node", id: "b", visible: false },
    ]);
  });

  it("all-hidden → all visible", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    await toggleNodesVisibility(
      makeRest(calls),
      { id: "s1", revision: 4 },
      ["a", "b"],
      new Map([
        ["a", false],
        ["b", false],
      ]),
    );
    const body = patchBody(calls);
    expect(body.baseRevision).toBe(4);
    expect(body.ops).toEqual([
      { op: "update_node", id: "a", visible: true },
      { op: "update_node", id: "b", visible: true },
    ]);
  });

  it("mixed → each flipped (H twice restores the exact prior state)", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    await toggleNodesVisibility(
      makeRest(calls),
      { id: "s1", revision: 1 },
      ["a", "b", "c"],
      new Map([
        ["a", true],
        ["b", false],
        ["c", true],
      ]),
    );
    const body = patchBody(calls);
    expect(body.ops).toEqual([
      { op: "update_node", id: "a", visible: false },
      { op: "update_node", id: "b", visible: true },
      { op: "update_node", id: "c", visible: false },
    ]);
  });

  it("an id missing from the map is treated as visible", async () => {
    const calls: Array<{ path: string; opts: unknown }> = [];
    await toggleNodesVisibility(
      makeRest(calls),
      { id: "s1", revision: 1 },
      ["ghost"],
      new Map(),
    );
    expect(patchBody(calls).ops).toEqual([
      { op: "update_node", id: "ghost", visible: false },
    ]);
  });
});
