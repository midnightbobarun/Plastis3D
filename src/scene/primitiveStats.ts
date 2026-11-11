// src/scene/primitiveStats.ts — analytic triangle/vertex counts for a
// primitive (Stage 5, PR5).
//
// A pure-TS mirror of plastis3d_scene/primitives.py count_primitive
// (same formulas, same defaults, no allocation). The inspector's Stats
// section reads these; the scene-level stats in the envelope come from
// the server. Sphere uses 2*ws*(hs-1): pole rows emit one triangle per
// column (three.js SphereGeometry emits 352 for 16x12, not 384 — PR4
// report). Segment counts fall back to the schema defaults when they
// are missing, non-integer, or out of 3..64, matching the builder's
// finiteness guards (build.ts).

import type { PrimitiveSpec } from "../types";

/** Schema-default segment counts (mirror PRIMITIVE_DEFAULTS). */
const DEFAULT_SEGMENTS: Record<string, number> = {
  widthSegments: 16,
  heightSegments: 12,
  radialSegments: 16,
  tubularSegments: 24,
  capSegments: 4,
};

function segments(value: number | undefined, key: string): number {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 3 &&
    value <= 64
  ) {
    return value;
  }
  return DEFAULT_SEGMENTS[key] ?? 16;
}

/** Local-space axis-aligned bounds of a primitive, or null for unknown types. */
export function primitiveLocalBounds(
  primitive: PrimitiveSpec,
): { min: [number, number, number]; max: [number, number, number] } | null {
  const p = primitive as unknown as Record<string, number | string | undefined>;
  const num = (key: string, fallback: number): number =>
    typeof p[key] === "number" && Number.isFinite(p[key] as number)
      ? (p[key] as number)
      : fallback;
  switch (primitive.type) {
    case "box": {
      const w = num("width", 1) / 2;
      const h = num("height", 1) / 2;
      const d = num("depth", 1) / 2;
      return { min: [-w, -h, -d], max: [w, h, d] };
    }
    case "sphere": {
      const r = num("radius", 0.5);
      return { min: [-r, -r, -r], max: [r, r, r] };
    }
    case "cylinder":
    case "cone": {
      const r = Math.max(num("radiusTop", 0.5), num("radiusBottom", 0.5));
      const h = num("height", 1) / 2;
      return { min: [-r, -h, -r], max: [r, h, r] };
    }
    case "torus": {
      // THREE.TorusGeometry (and primitives.py generate_torus) lie in
      // the XY plane — a standing ring, its hole along Z. (Bug fix,
      // PR32: this used to report a flat XZ ring, so the Size section
      // and floor placement were wrong for every torus.)
      const r = num("radius", 0.5) + num("tube", 0.15);
      const t = num("tube", 0.15);
      return { min: [-r, -r, -t], max: [r, r, t] };
    }
    case "plane": {
      const w = num("width", 1) / 2;
      const h = num("height", 1) / 2;
      return { min: [-w, -h, 0], max: [w, h, 0] };
    }
    case "capsule": {
      const r = num("radius", 0.25);
      const h = num("length", 1) / 2 + r;
      return { min: [-r, -h, -r], max: [r, h, r] };
    }
    default:
      return null;
  }
}
/** `{ verts, tris }` for one primitive, or null for an unknown type. */
export function countPrimitive(
  primitive: PrimitiveSpec,
): { verts: number; tris: number } | null {
  switch (primitive.type) {
    case "box":
      return { verts: 24, tris: 12 };
    case "sphere": {
      const ws = segments(primitive.widthSegments, "widthSegments");
      const hs = segments(primitive.heightSegments, "heightSegments");
      return { verts: (ws + 1) * (hs + 1), tris: ws * (hs - 1) * 2 };
    }
    case "cylinder": {
      const radial = segments(primitive.radialSegments, "radialSegments");
      return { verts: 4 * radial + 6, tris: 4 * radial };
    }
    case "cone": {
      const radial = segments(primitive.radialSegments, "radialSegments");
      return { verts: 3 * radial + 4, tris: 2 * radial };
    }
    case "torus": {
      const radial = segments(primitive.radialSegments, "radialSegments");
      const tubular = segments(
        primitive.tubularSegments,
        "tubularSegments",
      );
      return {
        verts: (radial + 1) * (tubular + 1),
        tris: radial * tubular * 2,
      };
    }
    case "plane":
      return { verts: 4, tris: 2 };
    case "capsule": {
      const cap = segments(primitive.capSegments, "capSegments");
      const radial = segments(primitive.radialSegments, "radialSegments");
      return {
        verts: (2 * cap + 2) * (radial + 1),
        tris: (2 * cap + 1) * radial * 2,
      };
    }
    default:
      return null;
  }
}
