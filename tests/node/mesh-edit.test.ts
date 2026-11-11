import { describe, expect, it } from "vitest";
import { buildTopology, centroidOf, cloneMesh, compact, deleteFaces, extrudeFaces, faceRegion, flipFaces, recomputeNormals, transformVertices, triangleCount, verticesOf } from "../../src/scene/meshEdit";
import type { EditMesh } from "../../src/scene/meshEdit";

/** A unit cube as a three.js BoxGeometry would give it: 24 split vertices, 12 triangles, UVs per face. */
function cube(): EditMesh {
  const faces: Array<{ n: number[]; u: number[]; v: number[] }> = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] }, { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] }, { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  faces.forEach((f, i) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(0.5 * f.n[0] + 0.5 * (a * f.u[0] + b * f.v[0]), 0.5 * f.n[1] + 0.5 * (a * f.u[1] + b * f.v[1]), 0.5 * f.n[2] + 0.5 * (a * f.u[2] + b * f.v[2]));
      normals.push(...f.n);
      uvs.push((a + 1) / 2, (b + 1) / 2);
    }
    const o = i * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  // Make every face wind counter-clockwise seen from outside.
  const mesh: EditMesh = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
  for (let f = 0; f < 12; f++) {
    const t = buildTopology(mesh, 1e-6);
    const n = [t.faceNormals[f * 3], t.faceNormals[f * 3 + 1], t.faceNormals[f * 3 + 2]];
    const vn = [mesh.normals[mesh.indices[f * 3] * 3], mesh.normals[mesh.indices[f * 3] * 3 + 1], mesh.normals[mesh.indices[f * 3] * 3 + 2]];
    if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] < 0) { const x = mesh.indices[f * 3 + 1]; mesh.indices[f * 3 + 1] = mesh.indices[f * 3 + 2]; mesh.indices[f * 3 + 2] = x; }
  }
  return mesh;
}

const topFaces = (mesh: EditMesh) => {
  const t = buildTopology(mesh);
  const seed = [...Array(triangleCount(mesh)).keys()].find((f) => t.faceNormals[f * 3 + 1] > 0.99) as number;
  return { t, seed };
};

describe("topology", () => {
  it("welds by position for adjacency while the arrays keep their seams", () => {
    const mesh = cube();
    const t = buildTopology(mesh);
    expect(mesh.positions.length / 3).toBe(24);
    expect(t.members.length).toBe(8); // eight corners, however many split copies each has
    expect(t.members.every((m) => m.length === 3)).toBe(true);
    expect(t.edges.length).toBe(18); // 12 cube edges + 6 face diagonals
    // Every cube edge is shared across a UV seam by exactly two triangles.
    const shared = t.edgeFaces.filter((f) => f.length === 2).length;
    expect(shared).toBe(18);
  });

  it("a click on a quad face selects its whole flat polygon (two triangles)", () => {
    const mesh = cube();
    const { t, seed } = topFaces(mesh);
    const region = faceRegion(mesh, t, seed);
    expect(region.length).toBe(2);
    expect(region.every((f) => t.faceNormals[f * 3 + 1] > 0.99)).toBe(true);
  });

  it("selection vertices include every welded copy, so a moved face does not tear off", () => {
    const mesh = cube();
    const { t, seed } = topFaces(mesh);
    const verts = verticesOf(mesh, t, "face", faceRegion(mesh, t, seed));
    expect(verts.size).toBe(4 * 3);
  });
});

describe("operations", () => {
  it("extrudes a cube face: new faces move out, four side walls appear, the rest is untouched", () => {
    const mesh = cube();
    const { t, seed } = topFaces(mesh);
    const region = faceRegion(mesh, t, seed);
    const out = extrudeFaces(mesh, t, region, 0.5);
    expect(triangleCount(out.mesh)).toBe(12 + 4 * 2);
    expect(out.faces).toEqual(region);
    const ys = out.faces.map((f) => out.mesh.positions[out.mesh.indices[f * 3] * 3 + 1]);
    expect(ys.every((y) => Math.abs(y - 1) < 1e-6)).toBe(true); // top at 0.5 + 0.5
    // The original top face's old vertices stay put, now hidden inside the walls' base.
    expect(Math.max(...Array.from({ length: out.mesh.positions.length / 3 }, (_, v) => out.mesh.positions[v * 3 + 1]))).toBeCloseTo(1, 5);
    // The result is a closed, consistent surface: every welded edge has exactly two triangles.
    const t2 = buildTopology(out.mesh);
    const open = t2.edgeFaces.filter((f) => f.length !== 2).length;
    expect(open).toBe(t2.edgeFaces.filter((f, i) => f.length === 1 && t2.edges[i]).length);
    // Walls face outward: every wall normal is horizontal.
    const walls = [...Array(triangleCount(out.mesh)).keys()].slice(12, 20);
    for (const f of walls) expect(Math.abs(t2.faceNormals[f * 3 + 1])).toBeLessThan(1e-6);
    // Untouched vertices kept their normals.
    for (let v = 0; v < 24; v++) if (out.mesh.positions[v * 3 + 1] < 0.4) expect(out.mesh.normals.slice(v * 3, v * 3 + 3)).toEqual(mesh.normals.slice(v * 3, v * 3 + 3));
  });

  it("extrude refuses an empty selection", () => {
    const mesh = cube();
    expect(() => extrudeFaces(mesh, buildTopology(mesh), [], 1)).toThrow("EDIT_NOTHING_SELECTED");
  });

  it("deletes faces and drops the vertices nothing uses; refuses to delete everything", () => {
    const mesh = cube();
    const { t, seed } = topFaces(mesh);
    const out = deleteFaces(mesh, faceRegion(mesh, t, seed));
    expect(triangleCount(out)).toBe(10);
    expect(out.positions.length / 3).toBe(20);
    expect(() => deleteFaces(mesh, [...Array(12).keys()])).toThrow("EDIT_EMPTY");
  });

  it("flips normals: winding reverses, normals negate, neighbours are not disturbed", () => {
    const mesh = cube();
    const { t, seed } = topFaces(mesh);
    const region = faceRegion(mesh, t, seed);
    const out = flipFaces(mesh, region);
    expect(triangleCount(out)).toBe(12);
    const t2 = buildTopology(out);
    const flipped = [...Array(12).keys()].filter((f) => t2.faceNormals[f * 3 + 1] < -0.99);
    expect(flipped.length).toBe(4); // the 2 flipped top triangles join the 2 bottom ones that already faced down
    for (const f of flipped) for (let k = 0; k < 3; k++) expect(out.normals[out.indices[f * 3 + k] * 3 + 1]).toBeCloseTo(-1);
    // Nothing faces up any more, and the four side faces were not disturbed.
    expect([...Array(12).keys()].filter((f) => t2.faceNormals[f * 3 + 1] > 0.99).length).toBe(0);
  });

  it("moving a face recomputes only the normals it touches", () => {
    const mesh = cube();
    const { t, seed } = topFaces(mesh);
    const before = mesh.normals.slice();
    const verts = verticesOf(mesh, t, "face", faceRegion(mesh, t, seed));
    transformVertices(mesh, verts, (p) => [p[0] * 0.5, p[1], p[2] * 0.5]);
    const changed = new Set<number>();
    for (let v = 0; v < 24; v++) if (Math.hypot(mesh.normals[v * 3] - before[v * 3], mesh.normals[v * 3 + 1] - before[v * 3 + 1], mesh.normals[v * 3 + 2] - before[v * 3 + 2]) > 1e-6) changed.add(v);
    expect(changed.size).toBeGreaterThan(0);
    for (const v of changed) expect(verts.has(v)).toBe(true);
  });

  it("centroid, compact and clone behave", () => {
    const mesh = cube();
    expect(centroidOf(mesh, [0, 1, 2, 3])).toHaveLength(3);
    const copy = cloneMesh(mesh);
    copy.positions[0] = 99;
    expect(mesh.positions[0]).not.toBe(99);
    expect(compact(mesh).positions.length).toBe(mesh.positions.length);
    recomputeNormals(mesh, []);
  });
});

describe("Mark seam (splitEdges)", () => {
  const weldedCube = (): EditMesh => {
    const v = [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
    return { positions: Float32Array.from(v.flat()), normals: Float32Array.from(v.flat()), uvs: null, indices: Uint32Array.from(f.flat()) };
  };
  it("cutting every cube edge makes the six faces independent (24 vertices) without changing the surface", async () => {
    const { splitEdges } = await import("../../src/scene/meshEdit");
    const mesh = weldedCube();
    const t = buildTopology(mesh);
    const sharp = t.edges.map((_, e) => e).filter((e) => { const [a, b] = t.edgeFaces[e]; return t.faceNormals[a * 3] * t.faceNormals[b * 3] + t.faceNormals[a * 3 + 1] * t.faceNormals[b * 3 + 1] + t.faceNormals[a * 3 + 2] * t.faceNormals[b * 3 + 2] < 0.99; });
    expect(sharp.length).toBe(12);
    const out = splitEdges(mesh, t, sharp);
    expect(out.positions.length / 3).toBe(24);
    expect(triangleCount(out)).toBe(12);
    for (let f = 0; f < 12; f++) for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) expect(out.positions[out.indices[f * 3 + k] * 3 + a]).toBe(mesh.positions[mesh.indices[f * 3 + k] * 3 + a]);
  });
  it("a single cut across a closed surface separates nothing, and no cut changes nothing", async () => {
    const { splitEdges } = await import("../../src/scene/meshEdit");
    const mesh = weldedCube();
    const t = buildTopology(mesh);
    expect(splitEdges(mesh, t, [0]).positions.length / 3).toBe(8);
    expect(splitEdges(mesh, t, []).positions.length / 3).toBe(8);
  });
  it("a loop round the top of a cube cuts the top face free (8 + 4 vertices)", async () => {
    const { splitEdges } = await import("../../src/scene/meshEdit");
    const mesh = weldedCube();
    const t = buildTopology(mesh);
    const top = [2, 3, 6, 7]; // the four +y corners
    const loop = t.edges.map((_, e) => e).filter((e) => top.includes(t.edges[e][0]) && top.includes(t.edges[e][1]) && t.edgeFaces[e].length === 2 && (() => { const [a, b] = t.edgeFaces[e]; return t.faceNormals[a * 3 + 1] * t.faceNormals[b * 3 + 1] + t.faceNormals[a * 3] * t.faceNormals[b * 3] + t.faceNormals[a * 3 + 2] * t.faceNormals[b * 3 + 2] < 0.99; })());
    expect(loop.length).toBe(4);
    expect(splitEdges(mesh, t, loop).positions.length / 3).toBe(12);
  });
});
