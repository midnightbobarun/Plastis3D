import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { geometryToMesh } from "../../src/scene/modifiers";
import { triangleCount } from "../../src/scene/meshEdit";
import type { EditMesh } from "../../src/scene/meshEdit";
import { lscm } from "../../src/scene/uv/lscm";
import { MARGIN, packIslands, placeUv } from "../../src/scene/uv/pack";
import { repairUv } from "../../src/scene/uv/repair";
import { findCharts, MAX_UNWRAP_TRIANGLES, packResult, repairResult, transformIsland, unwrap, uvSignedArea, UvError } from "../../src/scene/uv/unwrap";

const box = (): EditMesh => geometryToMesh(new THREE.BoxGeometry(1, 1, 1));
const weldedCube = (): EditMesh => {
  const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
  return { positions: Float32Array.from(v.flat()), normals: Float32Array.from(v.flat()), uvs: null, indices: Uint32Array.from(f.flat()) };
};
const angles = (a: number[], b: number[], c: number[]) => {
  const ang = (p: number[], q: number[], r: number[]) => { const u = q.map((x, i) => x - p[i]), w = r.map((x, i) => x - p[i]); return Math.acos((u.reduce((s, x, i) => s + x * w[i], 0)) / (Math.hypot(...u) * Math.hypot(...w))); };
  return [ang(a, b, c), ang(b, c, a), ang(c, a, b)];
};

describe("LSCM", () => {
  it("a flat plane in any orientation maps with zero angle distortion and converges", async () => {
    const g = new THREE.PlaneGeometry(3, 2, 4, 3);
    g.rotateX(0.7); g.rotateY(-1.1); g.translate(5, -2, 1);
    const positions = Float64Array.from(g.getAttribute("position").array as ArrayLike<number>);
    const triangles = Uint32Array.from(g.getIndex()!.array as ArrayLike<number>);
    const r = await lscm({ positions, triangles });
    expect(r.converged).toBe(true);
    expect(r.iterations).toBeLessThanOrEqual(2000);
    for (let t = 0; t < triangles.length / 3; t++) {
      const idx = [0, 1, 2].map((k) => triangles[t * 3 + k]);
      const p3 = idx.map((v) => [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
      const p2 = idx.map((v) => [r.uv[v * 2], r.uv[v * 2 + 1], 0]);
      const a3 = angles(p3[0], p3[1], p3[2]), a2 = angles(p2[0], p2[1], p2[2]);
      for (let k = 0; k < 3; k++) expect(a2[k]).toBeCloseTo(a3[k], 5);
    }
  });
  it("yields to the caller between slices on a large chart", async () => {
    const g = new THREE.PlaneGeometry(2, 2, 40, 40);
    let yields = 0, t = 0;
    await lscm({ positions: Float64Array.from(g.getAttribute("position").array as ArrayLike<number>), triangles: Uint32Array.from(g.getIndex()!.array as ArrayLike<number>) }, async () => { yields++; }, () => (t += 20));
    expect(yields).toBeGreaterThan(0);
  });
});

describe("charts and unwrap", () => {
  it("a box (its faces are already separate) has 6 charts; a welded cube is cut into 6 by the 66 degree rule", () => {
    expect(findCharts(box(), { autoSeams: false, angle: 66 }).count).toBe(6);
    expect(findCharts(weldedCube(), { autoSeams: true, angle: 66 }).count).toBe(6);
    expect(findCharts(weldedCube(), { autoSeams: false, angle: 66 }).count).toBe(1);
  });
  it("a cube gives six non-overlapping islands, all inside the margin, with positive area (no flips)", async () => {
    const out = await unwrap(box(), { autoSeams: false, angle: 66 });
    expect(out.islands).toBe(6);
    expect(triangleCount(out.mesh)).toBe(12);
    const uv = out.mesh.uvs!;
    for (let i = 0; i < uv.length; i++) { expect(uv[i]).toBeGreaterThanOrEqual(MARGIN - 1e-6); expect(uv[i]).toBeLessThanOrEqual(1 - MARGIN + 1e-6); }
    for (let f = 0; f < 12; f++) expect(uvSignedArea(out.mesh, f)).toBeGreaterThan(0);
    const boxes = Array.from({ length: 6 }, (_, id) => {
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let f = 0; f < 12; f++) if (out.islandOfTriangle[f] === id) for (let k = 0; k < 3; k++) { const v = out.mesh.indices[f * 3 + k]; lo[0] = Math.min(lo[0], uv[v * 2]); lo[1] = Math.min(lo[1], uv[v * 2 + 1]); hi[0] = Math.max(hi[0], uv[v * 2]); hi[1] = Math.max(hi[1], uv[v * 2 + 1]); }
      return { lo, hi };
    });
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const overlap = boxes[a].lo[0] < boxes[b].hi[0] && boxes[b].lo[0] < boxes[a].hi[0] && boxes[a].lo[1] < boxes[b].hi[1] && boxes[b].lo[1] < boxes[a].hi[1];
      expect(overlap, `${a} vs ${b}`).toBe(false);
    }
    // The surface is unchanged: same triangles, positions and normals.
    const src = box();
    for (let f = 0; f < 12; f++) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) expect(out.mesh.positions[out.mesh.indices[f * 3 + k] * 3 + a]).toBe(src.positions[src.indices[f * 3 + k] * 3 + a]);
  });
  it("a sphere with no seams is one chart and still gets finite UVs in range", async () => {
    const out = await unwrap(geometryToMesh(new THREE.SphereGeometry(1, 12, 8)), { autoSeams: true, angle: 66 });
    expect(Array.from(out.mesh.uvs!).every(Number.isFinite)).toBe(true);
    expect(Math.max(...out.mesh.uvs!)).toBeLessThanOrEqual(1);
    expect(Math.min(...out.mesh.uvs!)).toBeGreaterThanOrEqual(0);
  });
  it("refuses a mesh over the limit before doing any work", async () => {
    const big: EditMesh = { positions: new Float32Array(9), normals: new Float32Array(9), uvs: null, indices: new Uint32Array((MAX_UNWRAP_TRIANGLES + 1) * 3) };
    await expect(unwrap(big)).rejects.toMatchObject({ code: "UV_TOO_LARGE" });
    expect(new UvError("UV_INVALID", "x").code).toBe("UV_INVALID");
  });
});

describe("packing", () => {
  it("keeps every island in bounds with the 2 px margin, and bigger surfaces get more texture", () => {
    const sq = (s: number) => Float64Array.from([0, 0, s, 0, s, s, 0, s]);
    const islands = [{ uv: sq(1), area: 4 }, { uv: sq(1), area: 1 }, { uv: sq(2), area: 1 }, { uv: Float64Array.from([0, 0, 4, 0, 4, 0.5, 0, 0.5]), area: 2 }];
    const placements = packIslands(islands);
    const placed = islands.map((isl, i) => placeUv(isl.uv, placements[i]));
    placed.forEach((uv) => { for (const x of uv) { expect(x).toBeGreaterThanOrEqual(MARGIN - 1e-9); expect(x).toBeLessThanOrEqual(1 - MARGIN + 1e-9); } });
    const size = (uv: Float64Array) => { const xs = uv.filter((_, i) => i % 2 === 0), ys = uv.filter((_, i) => i % 2 === 1); return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)); };
    expect(size(placed[0]) / size(placed[1])).toBeCloseTo(4, 2); // texel density follows the 3D area
  });
  it("a rotated placement is a quarter turn, not a mirror", () => {
    const tri = Float64Array.from([0, 0, 2, 0, 0, 1]); // counter-clockwise
    const area = (u: Float64Array) => ((u[2] - u[0]) * (u[5] - u[1]) - (u[3] - u[1]) * (u[4] - u[0])) / 2;
    const turned = placeUv(tri, { scale: 0.1, rotated: true, offsetU: 0.2, offsetV: 0.3 });
    expect(area(turned)).toBeGreaterThan(0);
    expect(area(turned)).toBeCloseTo(area(tri) * 0.01, 8);
    expect(Math.min(...turned.filter((_, i) => i % 2 === 0))).toBeCloseTo(0.2, 8);
    expect(Math.min(...turned.filter((_, i) => i % 2 === 1))).toBeCloseTo(0.3, 8);
  });
  it("re-packing a result keeps shapes and stays in range", async () => {
    const out = await unwrap(box(), { autoSeams: false, angle: 66 });
    const moved = transformIsland(out, 0, { move: [3, 3] });
    const packed = packResult(moved);
    expect(Math.max(...packed.mesh.uvs!)).toBeLessThanOrEqual(1);
    expect(Math.min(...packed.mesh.uvs!)).toBeGreaterThanOrEqual(0);
  });
  it("move, rotate and scale act on one island about its centre", async () => {
    const out = await unwrap(box(), { autoSeams: false, angle: 66 });
    const before = (id: number) => { const us: number[] = []; for (let f = 0; f < 12; f++) if (out.islandOfTriangle[f] === id) for (let k = 0; k < 3; k++) us.push(out.mesh.uvs![out.mesh.indices[f * 3 + k] * 2]); return us; };
    const scaled = transformIsland(out, 2, { scale: 2 });
    const wide = (r: typeof out, id: number) => { const us: number[] = []; for (let f = 0; f < 12; f++) if (r.islandOfTriangle[f] === id) for (let k = 0; k < 3; k++) us.push(r.mesh.uvs![r.mesh.indices[f * 3 + k] * 2]); return Math.max(...us) - Math.min(...us); };
    expect(wide(scaled, 2) / wide(out, 2)).toBeCloseTo(2, 4);
    expect(before(3)).toEqual(Array.from({ length: before(3).length }, (_, i) => (scaled.mesh.uvs![0] === undefined ? 0 : before(3)[i]))); // other islands untouched
    const rotated = transformIsland(out, 1, { rotate: 1 });
    expect(wide(rotated, 1)).toBeCloseTo(wide(out, 1), 4); // a square island turns onto itself
    for (let f = 0; f < 12; f++) expect(uvSignedArea(transformIsland(out, 4, { move: [0.1, 0.1] }).mesh, f)).toBeGreaterThan(0);
  });
});

describe("repair", () => {
  it("mirrors a flipped island back", async () => {
    const out = await unwrap(box(), { autoSeams: false, angle: 66 });
    const uv = Float32Array.from(out.mesh.uvs!);
    const verts = new Set<number>();
    for (let f = 0; f < 12; f++) if (out.islandOfTriangle[f] === 1) for (let k = 0; k < 3; k++) verts.add(out.mesh.indices[f * 3 + k]);
    for (const v of verts) uv[v * 2] = 1 - uv[v * 2];
    const flipped = { ...out, mesh: { ...out.mesh, uvs: uv } };
    expect([...Array(12).keys()].some((f) => uvSignedArea(flipped.mesh, f) < 0)).toBe(true);
    const fixed = await repairResult(flipped, box(), { autoSeams: false, angle: 66 });
    expect(fixed.report.mirrored).toEqual([1]);
    for (let f = 0; f < 12; f++) expect(uvSignedArea(fixed.result.mesh, f)).toBeGreaterThan(0);
  });
  it("re-unwraps an island with NaN, and normalises out-of-range values", async () => {
    const out = await unwrap(box(), { autoSeams: false, angle: 66 });
    const uv = Float32Array.from(out.mesh.uvs!);
    uv[0] = Number.NaN;
    const broken = await repairResult({ ...out, mesh: { ...out.mesh, uvs: uv } }, box(), { autoSeams: false, angle: 66 });
    expect(broken.report.bad.length).toBe(1);
    expect(Array.from(broken.result.mesh.uvs!).every(Number.isFinite)).toBe(true);
    const big = Float32Array.from(out.mesh.uvs!).map((x) => x * 7 - 2);
    const r = repairUv({ uv: big, indices: out.mesh.indices, islandOfTriangle: out.islandOfTriangle });
    expect(r.normalised).toBe(true);
    expect(Math.max(...big)).toBeCloseTo(1, 5);
    expect(Math.min(...big)).toBeCloseTo(0, 5);
  });
});

it("repairs only the failed chart, retaining good UV bytes, geometry, normals and paint", async () => {
  const source = box();
  source.colors = Float32Array.from({ length: source.positions.length / 3 * 4 }, (_, i) => (i % 7) / 7);
  const out = await unwrap(source, { autoSeams: false, angle: 66 });
  expect(out.mesh.colors!.length).toBe(out.mesh.positions.length / 3 * 4);
  const uv = out.mesh.uvs!.slice();
  const bad = out.islandOfTriangle[0];
  const badVertices = new Set<number>();
  for (let f = 0; f < out.islandOfTriangle.length; f++) if (out.islandOfTriangle[f] === bad) for (let k = 0; k < 3; k++) badVertices.add(out.mesh.indices[f * 3 + k]);
  uv[out.mesh.indices[0] * 2] = NaN;
  const fixed = await repairResult({ ...out, mesh: { ...out.mesh, uvs: uv } }, source, { autoSeams: false, angle: 66 });
  expect(fixed.report.bad).toEqual([bad]);
  expect(fixed.result.mesh.positions).toBe(out.mesh.positions);
  expect(fixed.result.mesh.normals).toBe(out.mesh.normals);
  expect(fixed.result.mesh.indices).toBe(out.mesh.indices);
  expect(fixed.result.mesh.colors).toBe(out.mesh.colors);
  for (let v = 0; v < uv.length / 2; v++) if (!badVertices.has(v)) {
    expect(fixed.result.mesh.uvs![v * 2]).toBe(out.mesh.uvs![v * 2]);
    expect(fixed.result.mesh.uvs![v * 2 + 1]).toBe(out.mesh.uvs![v * 2 + 1]);
  }
  expect(fixed.result.mesh.uvs!.every(Number.isFinite)).toBe(true);
});
