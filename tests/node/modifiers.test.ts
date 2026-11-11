import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyStack, defaultEntry, geometryToMesh, MAX_MODIFIER_TRIANGLES, ModifierError, predictTriangles, validateEntry, validateStack } from "../../src/scene/modifiers";
import type { ModifierEntry } from "../../src/scene/modifiers";
import { buildTopology, triangleCount } from "../../src/scene/meshEdit";
import type { EditMesh } from "../../src/scene/meshEdit";

const box = (x = 0): EditMesh => { const g = new THREE.BoxGeometry(1, 1, 1); g.translate(x, 0, 0); return geometryToMesh(g); };
const sphere = (): EditMesh => geometryToMesh(new THREE.SphereGeometry(1, 24, 12));
const entry = (type: ModifierEntry["type"], params: ModifierEntry["params"] = {}): ModifierEntry => { const e = defaultEntry(type); e.params = { ...e.params, ...params }; return e; };
const bounds = (m: EditMesh) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < m.positions.length / 3; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.positions[v * 3 + k]); hi[k] = Math.max(hi[k], m.positions[v * 3 + k]); }
  return { lo, hi };
};
const closed = (m: EditMesh) => buildTopology(m).edgeFaces.every((f) => f.length === 2);
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as ModifierError).code; } return null; };
/** A welded unit cube (8 vertices, smooth normals), which a hard-edge split can cut apart. */
function weldedCube(): EditMesh {
  const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
  const positions = Float32Array.from(v.flat()), normals = Float32Array.from(v.flatMap((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); }));
  return { positions, normals, uvs: null, indices: Uint32Array.from(f.flat()) };
}

describe("each modifier on a known mesh", () => {
  it("mirror doubles the triangles, reflects across the axis plane and keeps every face pointing outward", () => {
    const out = applyStack(box(1), [entry("mirror", { axis: "x", threshold: 0 })]);
    expect(triangleCount(out)).toBe(24);
    const b = bounds(out);
    expect(b.lo[0]).toBeCloseTo(-1.5, 5); expect(b.hi[0]).toBeCloseTo(1.5, 5);
    const t = buildTopology(out);
    for (let f = 0; f < 24; f++) {
      const cx = [0, 1, 2].reduce((s, k) => s + out.positions[out.indices[f * 3 + k] * 3], 0) / 3;
      const side = cx > 0 ? 1 : -1; // which cube the face belongs to: its own centre is at x = +-1
      const n = [t.faceNormals[f * 3], t.faceNormals[f * 3 + 1], t.faceNormals[f * 3 + 2]];
      const centre = [side, 0, 0];
      const c = [0, 1, 2].map((a) => [0, 1, 2].reduce((s, k) => s + out.positions[out.indices[f * 3 + k] * 3 + a], 0) / 3);
      expect(n[0] * (c[0] - centre[0]) + n[1] * (c[1] - centre[1]) + n[2] * (c[2] - centre[2])).toBeGreaterThan(0);
    }
  });
  it("mirror's threshold closes a small gap onto the plane", () => {
    const out = applyStack(box(0.5005), [entry("mirror", { axis: "x", threshold: 0.001 })]); // the cube's near face is 0.0005 from the plane
    expect(bounds(out).lo[0]).toBeCloseTo(-1.0005, 4);
    const onPlane = Array.from({ length: out.positions.length / 3 }, (_, v) => out.positions[v * 3]).filter((x) => x === 0);
    expect(onPlane.length).toBe(24); // both copies' near-face corners (4 corners x 3 split copies each) sit exactly on x = 0
  });
  it("array makes count copies at the offset", () => {
    const out = applyStack(box(), [entry("array", { count: 3, offset: [2, 0, 0] })]);
    expect(triangleCount(out)).toBe(36);
    const b = bounds(out);
    expect(b.lo[0]).toBeCloseTo(-0.5, 5); expect(b.hi[0]).toBeCloseTo(4.5, 5);
  });
  it("subdivide quadruples per level, stays closed, and pulls corners in (Loop is approximating)", () => {
    const one = applyStack(weldedCube(), [entry("subdivide", { levels: 1 })]);
    expect(triangleCount(one)).toBe(48);
    expect(closed(one)).toBe(true);
    const two = applyStack(weldedCube(), [entry("subdivide", { levels: 2 })]);
    expect(triangleCount(two)).toBe(192);
    expect(closed(two)).toBe(true);
    expect(bounds(two).hi[0]).toBeLessThan(1);
    expect(bounds(two).hi[0]).toBeGreaterThan(0.5);
  });
  it("subdivide keeps UV seams: a box (split vertices) stays closed by position and keeps its uvs", () => {
    const out = applyStack(box(), [entry("subdivide", { levels: 1 })]);
    expect(triangleCount(out)).toBe(48);
    expect(out.uvs!.length / 2).toBe(out.positions.length / 3);
    expect(closed(out)).toBe(true);
  });
  it("subdivide leaves an open edge on its boundary (a plane keeps its outline)", () => {
    const plane = geometryToMesh(new THREE.PlaneGeometry(2, 2, 1, 1));
    const out = applyStack(plane, [entry("subdivide", { levels: 1 })]);
    const b = bounds(out);
    expect(b.lo[0]).toBeCloseTo(-1, 5); expect(b.hi[1]).toBeCloseTo(1, 5);
  });
  it("smooth moves interior vertices toward their neighbours and pins an open boundary", () => {
    const g = new THREE.PlaneGeometry(4, 4, 4, 4);
    const pos = g.getAttribute("position");
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) < 0.1 && Math.abs(pos.getY(i)) < 0.1) pos.setZ(i, 1);
    const plane = geometryToMesh(g);
    const out = applyStack(plane, [entry("smooth", { iterations: 3, factor: 0.5 })]);
    expect(Math.max(...Array.from({ length: out.positions.length / 3 }, (_, v) => out.positions[v * 3 + 2]))).toBeLessThan(0.6);
    for (let v = 0; v < out.positions.length / 3; v++) if (Math.abs(out.positions[v * 3]) === 2 || Math.abs(out.positions[v * 3 + 1]) === 2) expect(out.positions[v * 3 + 2]).toBe(0);
    expect(triangleCount(out)).toBe(triangleCount(plane));
  });
  it("decimate removes about the asked share of triangles", () => {
    const base = sphere();
    const out = applyStack(base, [entry("decimate", { ratio: 0.5 })]);
    expect(triangleCount(out)).toBeLessThan(triangleCount(base) * 0.7);
    expect(triangleCount(out)).toBeGreaterThan(triangleCount(base) * 0.3);
    expect(Math.max(...out.indices)).toBeLessThan(out.positions.length / 3);
  });
  it("edge split cuts only the edges sharper than the angle", () => {
    const sharp = applyStack(weldedCube(), [entry("edgeSplit", { angle: 30 })]);
    expect(triangleCount(sharp)).toBe(12);
    expect(sharp.positions.length / 3).toBeGreaterThan(8);
    const soft = applyStack(sphere(), [entry("edgeSplit", { angle: 90 })]);
    const hard = applyStack(sphere(), [entry("edgeSplit", { angle: 5 })]);
    expect(triangleCount(soft)).toBe(triangleCount(sphere()));
    expect(soft.positions.length / 3).toBeLessThan(hard.positions.length / 3); // a smaller angle cuts more edges
  });
});

describe("the stack", () => {
  it("order matters", () => {
    const a = bounds(applyStack(box(), [entry("array", { count: 2, offset: [2, 0, 0] }), entry("mirror", { axis: "x", threshold: 0 })]));
    const b = bounds(applyStack(box(), [entry("mirror", { axis: "x", threshold: 0 }), entry("array", { count: 2, offset: [2, 0, 0] })]));
    expect(a.lo[0]).toBeCloseTo(-2.5, 5);
    expect(b.lo[0]).toBeCloseTo(-0.5, 5); // a mirrored box centred on the plane is itself
    expect(a.lo[0]).not.toBeCloseTo(b.lo[0], 3);
  });
  it("a disabled entry does nothing, and an empty stack is the base", () => {
    const base = box();
    expect(applyStack(base, [{ ...entry("array", { count: 4 }), enabled: false }])).toBe(base);
    expect(applyStack(base, [])).toBe(base);
  });
  it("the prediction matches the actual triangle counts", () => {
    const stacks: ModifierEntry[][] = [[entry("mirror")], [entry("array", { count: 5 })], [entry("subdivide", { levels: 2 })], [entry("mirror"), entry("array", { count: 3 }), entry("subdivide", { levels: 1 })], [entry("smooth")]];
    for (const stack of stacks) expect(triangleCount(applyStack(box(), stack))).toBe(predictTriangles(12, stack));
    expect(predictTriangles(100, [entry("decimate", { ratio: 0.25 })])).toBe(25);
  });
  it("refuses an over-large stack BEFORE running anything", () => {
    let calls = 0;
    const stack = [entry("array", { count: 64 }), entry("subdivide", { levels: 2 })];
    expect(predictTriangles(triangleCount(sphere()), stack)).toBeGreaterThan(MAX_MODIFIER_TRIANGLES);
    expect(code(() => applyStack(sphere(), stack, () => { calls++; return 0; }))).toBe("MODIFIER_TOO_LARGE");
    expect(calls).toBe(0);
  });
  it("refuses a step that overruns its second", () => {
    let t = 0;
    expect(code(() => applyStack(box(), [entry("smooth")], () => (t += 1500)))).toBe("MODIFIER_TOO_SLOW");
  });
  it("validates the stack and each entry with the server's rules", () => {
    expect(validateStack(Array.from({ length: 9 }, () => entry("smooth")))).toMatch(/at most 8/);
    const bad: ModifierEntry[] = [entry("mirror", { axis: "w" }), entry("mirror", { threshold: 2 }), entry("array", { count: 0 }), entry("array", { count: 65 }), entry("array", { count: 2.5 }), entry("array", { offset: [1, 2] }), entry("subdivide", { levels: 3 }), entry("smooth", { iterations: 11 }), entry("smooth", { factor: 2 }), entry("decimate", { ratio: 0.99 }), entry("edgeSplit", { angle: 0 }), { type: "bogus" as never, enabled: true, params: {} }];
    for (const e of bad) expect(validateEntry(e), JSON.stringify(e)).not.toBeNull();
    for (const type of ["mirror", "array", "subdivide", "smooth", "decimate", "edgeSplit"] as const) expect(validateEntry(defaultEntry(type))).toBeNull();
    expect(code(() => applyStack(box(), [entry("array", { count: 0 })]))).toBe("MODIFIER_INVALID");
  });
  it("decimate refuses a mesh too big for the main thread", () => {
    const big = applyStack(box(), [entry("subdivide", { levels: 2 }), entry("array", { count: 64 })]); // 12288 triangles
    expect(code(() => applyStack({ ...big, indices: Uint32Array.from({ length: 31000 * 3 }, (_, i) => i % 24) }, [entry("decimate", { ratio: 0.5 })]))).toBe("MODIFIER_TOO_LARGE");
  });
});

describe("attribute retention", () => {
  const painted = () => {
    const m = box();
    m.colors = Float32Array.from({ length: m.positions.length / 3 * 4 }, (_, i) => i % 4 === 3 ? 0.4 : (Math.floor(i / 4) % 3) / 2);
    return m;
  };
  it("copies normalized RGB and RGBA attributes to independent RGBA arrays", () => {
    const g = new THREE.PlaneGeometry();
    g.setAttribute("color", new THREE.BufferAttribute(new Uint8Array([255, 128, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0]), 3, true));
    const m = geometryToMesh(g);
    expect(Array.from(m.colors!.subarray(0, 4))).toEqual([1, expect.closeTo(128 / 255, 6), 0, 1]);
    g.getAttribute("color").setX(0, 0);
    expect(m.colors![0]).toBe(1);
  });
  for (const type of ["mirror", "array", "subdivide", "smooth", "edgeSplit"] as const) it(`${type} preserves UV and RGBA seam attributes through two applications`, () => {
    const base = painted();
    const first = applyStack(base, [entry(type)]), out = applyStack(first, [entry(type)]);
    expect(out.uvs!.length).toBe(out.positions.length / 3 * 2);
    expect(out.colors!.length).toBe(out.positions.length / 3 * 4);
    expect(Array.from(out.colors!).filter((_, i) => i % 4 === 3).every((a) => Math.abs(a - 0.4) < 1e-6)).toBe(true);
    expect(out.colors!.every(Number.isFinite)).toBe(true);
    expect(Array.from(base.colors!)).toEqual(Array.from(painted().colors!));
  });
  it("decimates UV/RGB meshes with interpolation, and explicitly refuses unsupported alpha", () => {
    const base = sphere();
    base.colors = Float32Array.from({ length: base.positions.length / 3 * 4 }, (_, i) => i % 4 === 3 ? 1 : i % 3 / 2);
    const out = applyStack(base, [entry("decimate")]);
    expect(out.uvs!.length).toBe(out.positions.length / 3 * 2);
    expect(out.colors!.length).toBe(out.positions.length / 3 * 4);
    expect(out.colors!.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(() => applyStack(painted(), [entry("decimate")])).toThrow(/vertex alpha/);
  });
});
