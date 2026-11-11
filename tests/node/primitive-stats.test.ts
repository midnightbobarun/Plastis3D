// tests/node/primitive-stats.test.ts — analytic primitive counts (Tier 2, PR5).
//
// Extra file beyond the brief's list: src/scene/primitiveStats.ts is the
// pure-TS mirror of plastis3d_scene/primitives.py count_primitive that
// the inspector's Stats section reads, and its sphere formula (352 tris
// for 16x12, not the Python oracle's 384) is exactly the PR4 discrepancy
// the fixture comment says PR5 fixes. Covers countPrimitive and
// primitiveLocalBounds.
import { describe, expect, it } from "vitest";
import {
  countPrimitive,
  primitiveLocalBounds,
} from "../../src/scene/primitiveStats";
import type { PrimitiveSpec } from "../../src/types";

function prim(type: PrimitiveSpec["type"], extra?: Partial<PrimitiveSpec>): PrimitiveSpec {
  return { type, ...extra } as PrimitiveSpec;
}

describe("countPrimitive", () => {
  it("box is 24 verts / 12 tris", () => {
    expect(countPrimitive(prim("box"))).toEqual({ verts: 24, tris: 12 });
  });

  it("sphere 16x12 is 221 verts / 352 tris (three.js, not the 384 oracle)", () => {
    expect(
      countPrimitive(prim("sphere", { widthSegments: 16, heightSegments: 12 })),
    ).toEqual({ verts: 17 * 13, tris: 352 });
  });

  it("cylinder / cone scale with radial segments", () => {
    expect(countPrimitive(prim("cylinder", { radialSegments: 8 }))).toEqual({
      verts: 4 * 8 + 6,
      tris: 4 * 8,
    });
    expect(countPrimitive(prim("cone", { radialSegments: 8 }))).toEqual({
      verts: 3 * 8 + 4,
      tris: 2 * 8,
    });
  });

  it("torus and capsule use both segment counts", () => {
    expect(
      countPrimitive(
        prim("torus", { radialSegments: 8, tubularSegments: 12 }),
      ),
    ).toEqual({ verts: 9 * 13, tris: 8 * 12 * 2 });
    expect(
      countPrimitive(
        prim("capsule", { capSegments: 4, radialSegments: 8 }),
      ),
    ).toEqual({ verts: (2 * 4 + 2) * 9, tris: (2 * 4 + 1) * 8 * 2 });
  });

  it("plane is 4 verts / 2 tris; unknown types are null", () => {
    expect(countPrimitive(prim("plane"))).toEqual({ verts: 4, tris: 2 });
    expect(countPrimitive(prim("unknown" as PrimitiveSpec["type"]))).toBeNull();
  });

  it("segment counts fall back to defaults when missing, non-integer, or out of 3..64", () => {
    // No segments: sphere defaults 16x12.
    expect(countPrimitive(prim("sphere"))).toEqual({ verts: 17 * 13, tris: 352 });
    // Out of range and non-integer fall back too.
    expect(
      countPrimitive(prim("sphere", { widthSegments: 100, heightSegments: 2.5 })),
    ).toEqual({ verts: 17 * 13, tris: 352 });
  });
});

describe("primitiveLocalBounds", () => {
  it("box is centred on the origin with half-dimensions", () => {
    expect(
      primitiveLocalBounds(prim("box", { width: 2, height: 4, depth: 6 })),
    ).toEqual({ min: [-1, -2, -3], max: [1, 2, 3] });
  });

  it("sphere is a cube of the radius; plane is flat in z", () => {
    expect(primitiveLocalBounds(prim("sphere", { radius: 0.5 }))).toEqual({
      min: [-0.5, -0.5, -0.5],
      max: [0.5, 0.5, 0.5],
    });
    expect(primitiveLocalBounds(prim("plane", { width: 2, height: 3 }))).toEqual({
      min: [-1, -1.5, 0],
      max: [1, 1.5, 0],
    });
  });

  it("unknown types are null", () => {
    expect(
      primitiveLocalBounds(prim("unknown" as PrimitiveSpec["type"])),
    ).toBeNull();
  });
});
