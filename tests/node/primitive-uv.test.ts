// tests/node/primitive-uv.test.ts — Tier 3 UV parity (PR15, correctness audit C-08).
//
// The viewport draws three.js's built-in primitive geometry; the exporter
// writes the Python generators' meshes. A texture must land on a primitive
// the same way in both, so every Python vertex's UV has to equal the UV of
// the three.js vertex that sits at the same position with the same normal,
// after the one convention change: glTF's v runs down, three.js's runs up.
//
// Around a wrapped surface the Python u runs through 0.5 - k/n (or 0.25 - k/n)
// instead of restarting at the seam, so u is compared modulo 1: the export
// uses a REPEAT sampler, which makes the two identical. Vertices on the
// primitive's axis (poles, apexes, cap centres) coincide, so there u carries
// no position information and only v is compared; the Python test checks that
// each pole vertex sits at the middle of its triangle.
//
// Also pins the texture orientation contract the viewport relies on: an
// upright image has flipY on, because three.js geometry UVs run v up.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPrimitiveGeometry } from "../../src/scene/build";
import type { PrimitiveSpec } from "../../src/types";

interface Case {
  primitive: Record<string, unknown>;
  positions: number[];
  normals: number[];
  uvs: number[];
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/primitive-uvs.json", import.meta.url)), "utf-8"),
) as { cases: Case[] };

const EPS = 1e-4;
const frac = (u: number) => ((u % 1) + 1) % 1;
const sameU = (a: number, b: number) => {
  const d = Math.abs(frac(a) - frac(b));
  return d < EPS || Math.abs(d - 1) < EPS;
};

/**
 * Vertex rings with an odd segment count sit half a column apart in the two
 * implementations (the geometry itself differs by that sub-column rotation),
 * so vertices cannot be paired. Those cases are checked against the closed
 * form of the mapping instead, on both sides.
 */
function aligned(p: Record<string, unknown>): boolean {
  const even = (k: string) => typeof p[k] !== "number" || (p[k] as number) % 2 === 0;
  if (p.type === "sphere") return even("widthSegments");
  if (p.type === "cylinder" || p.type === "cone" || p.type === "capsule") return even("radialSegments");
  return true;
}

/** The mapping as a function of position (glTF convention u; v is checked elsewhere). */
function expectedU(type: unknown, x: number, y: number, z: number, ny: number): number | null {
  const onAxis = Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6;
  if (onAxis) return null;
  if (type === "sphere" || type === "capsule") return Math.atan2(z, -x) / (2 * Math.PI);
  if ((type === "cylinder" || type === "cone") && Math.abs(ny) < 1 - 1e-6) {
    return Math.atan2(x, z) / (2 * Math.PI); // the side wall
  }
  return null;
}

function closedFormFailures(
  type: unknown,
  count: number,
  get: (i: number) => { p: number[]; n: number[]; uv: number[] },
  vIsThreeConvention: boolean,
): string[] {
  const failures: string[] = [];
  for (let i = 0; i < count; i++) {
    const { p, n, uv } = get(i);
    const u = expectedU(type, p[0], p[1], p[2], n[1]);
    if (u !== null && !sameU(u, uv[0])) failures.push(`u at vertex ${i}: expected ${u}, got ${uv[0]}`);
    if ((type === "cylinder" || type === "cone") && Math.abs(Math.abs(n[1]) - 1) < 1e-6) {
      const r = Math.hypot(p[0], p[2]);
      if (r > 1e-6) {
        const sign = n[1] > 0 ? 1 : -1;
        const vThree = 0.5 + 0.5 * sign * (p[0] / r);
        if (Math.abs(uv[0] - (0.5 + 0.5 * (p[2] / r))) > EPS) failures.push(`cap u at vertex ${i}`);
        const v = vIsThreeConvention ? uv[1] : 1 - uv[1];
        if (Math.abs(v - vThree) > EPS) failures.push(`cap v at vertex ${i}`);
      }
    }
  }
  return failures;
}

describe("Python primitive UVs equal three.js's, with v flipped", () => {
  for (const c of fixture.cases) {
    const label = `${c.primitive.type} ${JSON.stringify(c.primitive)}`;
    it(label, () => {
      const geometry = buildPrimitiveGeometry(c.primitive as unknown as PrimitiveSpec);
      const pos = geometry.attributes.position;
      const nor = geometry.attributes.normal;
      const uv = geometry.attributes.uv;
      expect(uv).toBeDefined();

      // Both sides follow the same closed-form mapping, wherever they put their vertices.
      expect(
        closedFormFailures(c.primitive.type, c.positions.length / 3, (i) => ({
          p: c.positions.slice(3 * i, 3 * i + 3),
          n: c.normals.slice(3 * i, 3 * i + 3),
          uv: c.uvs.slice(2 * i, 2 * i + 2),
        }), false).slice(0, 5),
      ).toEqual([]);
      expect(
        closedFormFailures(c.primitive.type, pos.count, (i) => ({
          p: [pos.getX(i), pos.getY(i), pos.getZ(i)],
          n: [nor.getX(i), nor.getY(i), nor.getZ(i)],
          uv: [uv.getX(i), uv.getY(i)],
        }), true).slice(0, 5),
      ).toEqual([]);

      if (!aligned(c.primitive)) return;
      const failures: string[] = [];
      for (let i = 0; i < c.positions.length / 3; i++) {
        const [x, y, z] = c.positions.slice(3 * i, 3 * i + 3);
        const [nx, ny, nz] = c.normals.slice(3 * i, 3 * i + 3);
        const [u, v] = c.uvs.slice(2 * i, 2 * i + 2);
        const onAxis = Math.abs(x) < 1e-6 && Math.abs(z) < 1e-6;
        let found = false;
        for (let j = 0; j < pos.count && !found; j++) {
          if (
            Math.abs(pos.getX(j) - x) > EPS ||
            Math.abs(pos.getY(j) - y) > EPS ||
            Math.abs(pos.getZ(j) - z) > EPS ||
            Math.abs(nor.getX(j) - nx) > EPS ||
            Math.abs(nor.getY(j) - ny) > EPS ||
            Math.abs(nor.getZ(j) - nz) > EPS
          ) {
            continue;
          }
          const vThree = uv.getY(j);
          if (Math.abs(1 - v - vThree) > EPS) continue;
          if (!onAxis && !sameU(u, uv.getX(j))) continue;
          found = true;
        }
        if (!found) failures.push(`vertex ${i} at (${x}, ${y}, ${z}) uv (${u}, ${v})`);
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  }
});
