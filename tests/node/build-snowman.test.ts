// tests/node/build-snowman.test.ts — the canned snowman spec (Tier 2,
// Phase 0 0-D).
//
// Covers src/editor/buildSnowman.ts: the exact node list, heights
// summing to ~1.8 m, all numbers finite, primitive params in range,
// materials including m_default, and no light/camera in the payload
// (the server re-adds them). The click-flow harness test lands with
// the Phase 2 wiring (E-02), when the shared empty state is mounted.
import { describe, expect, it } from "vitest";
import { buildSnowman } from "../../src/editor/buildSnowman";
import type { NodeSpec } from "../../src/types";

/** The top Y of a node (centre + half its vertical extent). */
function topY(node: NodeSpec): number {
  const t = node.transform.t[1];
  const p = node.primitive;
  if (!p) return t;
  if (p.type === "sphere") return t + (p.radius ?? 0);
  return t + (p.height ?? 0) / 2;
}

function allNumbers(value: unknown): number[] {
  const out: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "number") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

describe("buildSnowman", () => {
  it("returns the exact canned node list", () => {
    const { nodes, materials } = buildSnowman();
    expect(nodes.map((n) => n.id)).toEqual([
      "snow_base",
      "snow_middle",
      "snow_head",
      "snow_scarf",
      "snow_hat",
    ]);
    expect(nodes.map((n) => n.name)).toEqual([
      "Base",
      "Middle",
      "Head",
      "Scarf",
      "Hat",
    ]);
    for (const node of nodes) {
      expect(node.kind).toBe("mesh");
      expect(node.parent).toBeNull();
      expect(node.visible).toBe(true);
      expect(node.materialId).toBe("m_default");
    }
    expect(materials.map((m) => m.id)).toEqual(["m_default"]);
  });

  it("is three spheres, a cone hat, and a cylinder scarf — no cone nose, no cylinder hat", () => {
    const { nodes } = buildSnowman();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("snow_base")?.primitive?.type).toBe("sphere");
    expect(byId.get("snow_middle")?.primitive?.type).toBe("sphere");
    expect(byId.get("snow_head")?.primitive?.type).toBe("sphere");
    expect(byId.get("snow_scarf")?.primitive?.type).toBe("cylinder");
    expect(byId.get("snow_hat")?.primitive?.type).toBe("cone");
  });

  it("stands ~1.8 m tall", () => {
    const { nodes } = buildSnowman();
    const height = Math.max(...nodes.map(topY));
    expect(height).toBeGreaterThanOrEqual(1.7);
    expect(height).toBeLessThanOrEqual(1.9);
    // The spheres stack: each sits on the one below.
    const base = nodes[0];
    const middle = nodes[1];
    const head = nodes[2];
    expect(middle.transform.t[1]).toBeCloseTo(
      topY(base) + (middle.primitive?.radius ?? 0),
      10,
    );
    expect(head.transform.t[1]).toBeCloseTo(
      topY(middle) + (head.primitive?.radius ?? 0),
      10,
    );
  });

  it("has only finite numbers and primitive params in range", () => {
    const { nodes, materials } = buildSnowman();
    for (const n of allNumbers(nodes)) expect(Number.isFinite(n)).toBe(true);
    for (const n of allNumbers(materials)) expect(Number.isFinite(n)).toBe(true);
    for (const node of nodes) {
      const p = node.primitive;
      expect(p).toBeDefined();
      if (!p) continue;
      for (const key of ["radius", "radiusTop", "radiusBottom", "height"] as const) {
        const v = p[key];
        if (v !== undefined) expect(v).toBeGreaterThan(0);
      }
      for (const key of [
        "widthSegments",
        "heightSegments",
        "radialSegments",
      ] as const) {
        const v = p[key];
        if (v !== undefined) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(3);
          expect(v).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  it("materials include m_default, the schema default", () => {
    const { materials } = buildSnowman();
    const def = materials.find((m) => m.id === "m_default");
    expect(def).toBeDefined();
    expect(def?.color).toBe("#c8ccd0");
    expect(def?.metalness).toBe(0);
    expect(def?.roughness).toBe(0.6);
  });

  it("carries no light or camera — the server re-adds them", () => {
    const { nodes } = buildSnowman();
    expect(nodes.some((n) => n.kind === "light" || n.kind === "camera")).toBe(false);
  });
});
