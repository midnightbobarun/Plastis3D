import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyBrush, falloff, sculptContext } from "../../src/scene/sculpt/brushes";
import type { BrushSettings, Hit } from "../../src/scene/sculpt/brushes";
import { ensureColors, fillColor, hexToColor, paintDab, paintFalloff } from "../../src/scene/paint";
import { buildTopology, cloneMesh, compact, deleteFaces, extrudeFaces, flipFaces, splitEdges } from "../../src/scene/meshEdit";
import type { EditMesh } from "../../src/scene/meshEdit";
import { geometryToMesh } from "../../src/scene/modifiers";
import { decodeMesh, encodeMesh } from "../../src/scene/bake";

/** A flat 20 x 20 grid of unit-ish quads in the xz plane, facing +y. */
function grid(n = 20, size = 4): EditMesh {
  const g = new THREE.PlaneGeometry(size, size, n, n);
  g.rotateX(-Math.PI / 2);
  return geometryToMesh(g);
}
const S = (over: Partial<BrushSettings> = {}): BrushSettings => ({ type: "draw", radius: 1, strength: 0.5, symmetryX: false, ...over });
const up: Hit["normal"] = [0, 1, 0];
const yOf = (m: EditMesh, v: number) => m.positions[v * 3 + 1];
const maxAbsY = (m: EditMesh) => Math.max(...Array.from({ length: m.positions.length / 3 }, (_, v) => Math.abs(yOf(m, v))));

describe("the falloff", () => {
  it("is 1 at the centre, 0 at and past the radius, smooth and monotone between", () => {
    expect(falloff(0, 1)).toBe(1);
    expect(falloff(1, 1)).toBe(0);
    expect(falloff(2, 1)).toBe(0);
    let last = 1;
    for (let d = 0.05; d < 1; d += 0.05) { const f = falloff(d, 1); expect(f).toBeLessThan(last); expect(f).toBeGreaterThan(0); last = f; }
    expect(falloff(0.5, 1)).toBeCloseTo(0.5625, 6);
  });
  it("paint falloff is a hard disc at hardness 1 and soft below", () => {
    expect(paintFalloff(0.99, 1, 1)).toBe(1);
    expect(paintFalloff(1, 1, 1)).toBe(0);
    expect(paintFalloff(0.3, 1, 0)).toBeLessThan(1);
    expect(paintFalloff(0.3, 1, 0.5)).toBe(1);
  });
});

describe("sculpt brushes", () => {
  it("draw pushes vertices along the normal, bounded, strongest at the centre, nothing outside the radius", () => {
    const m = grid(); const ctx = sculptContext(m);
    const touched = applyBrush(m, ctx, { point: [0, 0, 0], normal: up }, S());
    expect(touched.size).toBeGreaterThan(0);
    const peak = maxAbsY(m);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(0.5 * 1 * 0.05 + 1e-9); // strength * radius * DRAW_STEP
    for (let v = 0; v < m.positions.length / 3; v++) if (Math.hypot(m.positions[v * 3], m.positions[v * 3 + 2]) >= 1) expect(yOf(m, v)).toBeCloseTo(0, 9);
    // Inverted draw pushes the other way.
    const n = grid(); applyBrush(n, sculptContext(n), { point: [0, 0, 0], normal: up }, S({ invert: true }));
    expect(Math.min(...Array.from({ length: n.positions.length / 3 }, (_, v) => yOf(n, v)))).toBeLessThan(0);
  });
  it("normals are refreshed in the touched region, and only there", () => {
    const m = grid(); const before = m.normals.slice(); const ctx = sculptContext(m);
    const touched = applyBrush(m, ctx, { point: [0, 0, 0], normal: up }, S({ strength: 1 }));
    let changed = 0;
    for (let v = 0; v < m.positions.length / 3; v++) {
      const moved = Math.hypot(m.normals[v * 3] - before[v * 3], m.normals[v * 3 + 1] - before[v * 3 + 1], m.normals[v * 3 + 2] - before[v * 3 + 2]) > 1e-6;
      if (moved) { changed++; expect(touched.has(v)).toBe(true); }
    }
    expect(changed).toBeGreaterThan(0);
  });
  it("X symmetry mirrors a dab exactly on a symmetric mesh", () => {
    const m = grid(); const ctx = sculptContext(m);
    applyBrush(m, ctx, { point: [0.8, 0, 0.3], normal: up }, S({ symmetryX: true, strength: 0.7 }));
    const at = new Map<string, number>();
    for (let v = 0; v < m.positions.length / 3; v++) at.set(`${m.positions[v * 3].toFixed(4)},${m.positions[v * 3 + 2].toFixed(4)}`, yOf(m, v));
    let compared = 0;
    for (let v = 0; v < m.positions.length / 3; v++) {
      const mirrored = at.get(`${(-m.positions[v * 3]).toFixed(4)},${m.positions[v * 3 + 2].toFixed(4)}`);
      if (mirrored !== undefined) { expect(mirrored).toBeCloseTo(yOf(m, v), 6); compared++; }
    }
    expect(compared).toBeGreaterThan(100);
    expect(maxAbsY(m)).toBeGreaterThan(0);
  });
  it("smooth pulls a spike toward its neighbours; flatten pushes vertices onto the plane through the hit", () => {
    const m = grid(); const ctx = sculptContext(m);
    const centre = Array.from({ length: m.positions.length / 3 }, (_, v) => v).reduce((best, v) => Math.hypot(m.positions[v * 3], m.positions[v * 3 + 2]) < Math.hypot(m.positions[best * 3], m.positions[best * 3 + 2]) ? v : best, 0);
    for (const v of ctx.topology.members[ctx.topology.weld[centre]]) m.positions[v * 3 + 1] = 1;
    applyBrush(m, ctx, { point: [0, 1, 0], normal: up }, S({ type: "smooth", strength: 1, radius: 0.4 }));
    expect(yOf(m, centre)).toBeLessThan(1);
    const f = grid(); const fctx = sculptContext(f);
    for (let v = 0; v < f.positions.length / 3; v++) f.positions[v * 3 + 1] = (f.positions[v * 3] > 0 ? 0.3 : -0.3);
    applyBrush(f, fctx, { point: [0, 0, 0], normal: up }, S({ type: "flatten", strength: 1, radius: 1.5 }));
    for (let v = 0; v < f.positions.length / 3; v++) if (Math.hypot(f.positions[v * 3], f.positions[v * 3 + 2]) < 0.2) expect(Math.abs(yOf(f, v))).toBeLessThan(0.3);
  });
  it("grab follows the drag delta, weighted by the falloff", () => {
    const m = grid(); const ctx = sculptContext(m);
    applyBrush(m, ctx, { point: [0, 0, 0], normal: up }, S({ type: "grab" }), [0, 0.6, 0]);
    expect(maxAbsY(m)).toBeCloseTo(0.6, 1);
    let nearest = Infinity;
    for (let v = 0; v < m.positions.length / 3; v++) if (Math.hypot(m.positions[v * 3], m.positions[v * 3 + 2]) > 1) expect(yOf(m, v)).toBeCloseTo(0, 9);
    nearest = 0; void nearest;
  });
  it("keeps the topology: same triangles and indices, finite positions", () => {
    const m = grid(); const idx = m.indices.slice(); const ctx = sculptContext(m);
    for (let i = 0; i < 20; i++) applyBrush(m, ctx, { point: [Math.sin(i) * 1.5, 0, Math.cos(i) * 1.5], normal: up }, S({ symmetryX: i % 2 === 0 }));
    expect(Array.from(m.indices)).toEqual(Array.from(idx));
    expect(Array.from(m.positions).every(Number.isFinite)).toBe(true);
  });
});

describe("paint", () => {
  it("a dab blends toward the colour inside the radius only; strength 1 and a hard edge gives the colour exactly", () => {
    const m = grid(); const red = hexToColor("#ff0000");
    const touched = paintDab(m, [0, 0, 0], { color: red, radius: 1, strength: 1, hardness: 1, symmetryX: false });
    expect(touched.size).toBeGreaterThan(0);
    const c = m.colors!;
    for (let v = 0; v < m.positions.length / 3; v++) {
      const d = Math.hypot(m.positions[v * 3], m.positions[v * 3 + 2]);
      if (d < 0.99) expect(Array.from(c.slice(v * 4, v * 4 + 4))).toEqual([1, 0, 0, 1]);
      if (d >= 1) expect(Array.from(c.slice(v * 4, v * 4 + 4))).toEqual([1, 1, 1, 1]);
    }
  });
  it("soft strength blends part way, and symmetry paints both sides", () => {
    const m = grid();
    paintDab(m, [1, 0, 0], { color: [0, 0, 1, 1], radius: 0.5, strength: 0.5, hardness: 1, symmetryX: true });
    let left = 0, right = 0;
    for (let v = 0; v < m.positions.length / 3; v++) { const p = m.colors![v * 4]; if (p < 1) { if (m.positions[v * 3] < 0) left++; else right++; expect(p).toBeCloseTo(0.5, 6); } }
    expect(left).toBe(right);
    expect(left).toBeGreaterThan(0);
  });
  it("Fill sets every vertex", () => {
    const m = grid(5, 1); fillColor(m, [0.2, 0.4, 0.6, 1]);
    expect(Array.from(ensureColors(m)).every((x, i) => Math.abs(x - [0.2, 0.4, 0.6, 1][i % 4]) < 1e-6)).toBe(true);
    expect(hexToColor("#00ff80")).toEqual([0, 1, 128 / 255, 1]);
    expect(hexToColor("nope")).toEqual([1, 1, 1, 1]);
  });
});

describe("colours survive the edit operations and the wire", () => {
  const painted = (): EditMesh => { const m = geometryToMesh(new THREE.BoxGeometry(1, 1, 1)); const c = ensureColors(m); for (let v = 0; v < c.length / 4; v++) { c[v * 4] = v / 24; c[v * 4 + 1] = 0.5; c[v * 4 + 2] = 0.25; } return m; };
  it("clone, compact, delete, flip, extrude and split keep one colour per vertex", () => {
    const m = painted(); const t = buildTopology(m);
    const colourOfPos = (mesh: EditMesh) => { const out = new Map<string, number>(); for (let v = 0; v < mesh.positions.length / 3; v++) out.set(`${mesh.positions[v * 3]},${mesh.positions[v * 3 + 1]},${mesh.positions[v * 3 + 2]},${mesh.normals[v * 3]},${mesh.normals[v * 3 + 1]},${mesh.normals[v * 3 + 2]}`, mesh.colors![v * 4]); return out; };
    expect(Array.from(cloneMesh(m).colors!)).toEqual(Array.from(m.colors!));
    for (const out of [compact(m), deleteFaces(m, [0, 1]), flipFaces(m, [0, 1]), extrudeFaces(m, t, [0, 1], 0.2).mesh, splitEdges(m, t, [0])]) {
      expect(out.colors!.length).toBe((out.positions.length / 3) * 4);
      expect(Array.from(out.colors!).every(Number.isFinite)).toBe(true);
    }
    const kept = deleteFaces(m, [0, 1]); const before = colourOfPos(m);
    for (const [key, value] of colourOfPos(kept)) expect(before.get(key)).toBe(value);
  });
  it("encode and decode carry colours, and a bad colour array is refused", () => {
    const m = painted();
    const back = decodeMesh(encodeMesh(m))!;
    expect(Array.from(back.colors!)).toEqual(Array.from(m.colors!));
    expect(decodeMesh({ ...encodeMesh(m), colors: encodeMesh({ ...m, colors: new Float32Array(8) }).colors })).toBeNull();
    expect(decodeMesh(encodeMesh({ ...m, colors: null }))!.colors).toBeNull();
  });
});
