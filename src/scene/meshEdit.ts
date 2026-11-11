// src/scene/meshEdit.ts — pure mesh topology and edit operations (PR24).
//
// No three.js and no DOM, so Vitest tests it directly. The edit copy is an
// indexed triangle mesh. Adjacency is found by welding vertices by POSITION
// (1e-6 m) so that two triangles that meet along a UV or normal seam are
// still neighbours; the arrays themselves keep their split vertices, so a
// seam stays a seam in the output. Normals are recomputed for touched faces
// only; every other normal is kept as it was.

export interface EditMesh {
  positions: Float32Array; // xyz per vertex
  normals: Float32Array; // xyz per vertex
  uvs: Float32Array | null; // uv per vertex
  indices: Uint32Array; // three per triangle
  /** Optional vertex colours (COLOR_0), RGBA floats per vertex (PR29). Operations that rebuild vertices carry them. */
  colors?: Float32Array | null;
}

export type PickMode = "vertex" | "edge" | "face";

/** Over this many triangles edit mode is refused (EDIT_TOO_LARGE), before any BVH build. */
export const MAX_EDIT_TRIANGLES = 200_000;
export const WELD_EPSILON = 1e-6;

export function triangleCount(mesh: EditMesh): number {
  return mesh.indices.length / 3;
}

export function cloneMesh(mesh: EditMesh): EditMesh {
  return {
    positions: mesh.positions.slice(),
    normals: mesh.normals.slice(),
    uvs: mesh.uvs ? mesh.uvs.slice() : null,
    indices: mesh.indices.slice(),
    colors: mesh.colors ? mesh.colors.slice() : null,
  };
}

export interface Topology {
  /** vertex index -> weld id (the position group it belongs to). */
  weld: Uint32Array;
  /** weld id -> every vertex index at that position. */
  members: number[][];
  /** unique edges as [weldA, weldB] with weldA < weldB. */
  edges: Array<[number, number]>;
  /** "a_b" -> index into `edges`. */
  edgeIndex: Map<string, number>;
  /** edge index -> the triangles that use it. */
  edgeFaces: number[][];
  /** triangle -> its three edge indices. */
  faceEdges: Array<[number, number, number]>;
  /** per-triangle unit normal. */
  faceNormals: Float32Array;
}

const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);

export function faceNormalOf(mesh: EditMesh, face: number, out: number[] = [0, 0, 0]): number[] {
  const { positions: p, indices: ix } = mesh;
  const a = ix[face * 3] * 3, b = ix[face * 3 + 1] * 3, c = ix[face * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  if (length === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return out; }
  out[0] = x / length; out[1] = y / length; out[2] = z / length;
  return out;
}

export function buildTopology(mesh: EditMesh, epsilon = WELD_EPSILON): Topology {
  const vertexCount = mesh.positions.length / 3;
  const weld = new Uint32Array(vertexCount);
  const members: number[][] = [];
  const byPosition = new Map<string, number>();
  for (let v = 0; v < vertexCount; v++) {
    const key = `${Math.round(mesh.positions[v * 3] / epsilon)},${Math.round(mesh.positions[v * 3 + 1] / epsilon)},${Math.round(mesh.positions[v * 3 + 2] / epsilon)}`;
    let id = byPosition.get(key);
    if (id === undefined) { id = members.length; byPosition.set(key, id); members.push([]); }
    weld[v] = id;
    members[id].push(v);
  }
  const edges: Array<[number, number]> = [];
  const edgeIndex = new Map<string, number>();
  const edgeFaces: number[][] = [];
  const faces = mesh.indices.length / 3;
  const faceEdges: Array<[number, number, number]> = [];
  const faceNormals = new Float32Array(faces * 3);
  const normal = [0, 0, 0];
  for (let f = 0; f < faces; f++) {
    const w = [weld[mesh.indices[f * 3]], weld[mesh.indices[f * 3 + 1]], weld[mesh.indices[f * 3 + 2]]];
    const ids: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = w[k], b = w[(k + 1) % 3];
      if (a === b) { ids.push(-1); continue; } // a degenerate edge
      const key = edgeKey(a, b);
      let index = edgeIndex.get(key);
      if (index === undefined) { index = edges.length; edgeIndex.set(key, index); edges.push(a < b ? [a, b] : [b, a]); edgeFaces.push([]); }
      edgeFaces[index].push(f);
      ids.push(index);
    }
    faceEdges.push(ids as [number, number, number]);
    faceNormalOf(mesh, f, normal);
    faceNormals[f * 3] = normal[0]; faceNormals[f * 3 + 1] = normal[1]; faceNormals[f * 3 + 2] = normal[2];
  }
  return { weld, members, edges, edgeIndex, edgeFaces, faceEdges, faceNormals };
}

/** The triangles that share a flat polygon with `face` (coplanar, edge-connected). */
export function faceRegion(mesh: EditMesh, topology: Topology, face: number, cap = 4096): number[] {
  const seen = new Set<number>([face]);
  const queue = [face];
  const n = topology.faceNormals;
  while (queue.length && seen.size < cap) {
    const f = queue.shift() as number;
    for (const e of topology.faceEdges[f]) {
      if (e < 0) continue;
      for (const g of topology.edgeFaces[e]) {
        if (seen.has(g)) continue;
        const dot = n[f * 3] * n[g * 3] + n[f * 3 + 1] * n[g * 3 + 1] + n[f * 3 + 2] * n[g * 3 + 2];
        if (dot >= 0.9999) { seen.add(g); queue.push(g); }
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** Every split vertex index a selection moves (welded copies move together). */
export function verticesOf(mesh: EditMesh, topology: Topology, mode: PickMode, ids: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const addWeld = (w: number) => { for (const v of topology.members[w]) out.add(v); };
  for (const id of ids) {
    if (mode === "vertex") addWeld(id);
    else if (mode === "edge") { addWeld(topology.edges[id][0]); addWeld(topology.edges[id][1]); }
    else for (let k = 0; k < 3; k++) addWeld(topology.weld[mesh.indices[id * 3 + k]]);
  }
  return out;
}

export function centroidOf(mesh: EditMesh, vertices: Iterable<number>): [number, number, number] {
  let x = 0, y = 0, z = 0, n = 0;
  for (const v of vertices) { x += mesh.positions[v * 3]; y += mesh.positions[v * 3 + 1]; z += mesh.positions[v * 3 + 2]; n++; }
  return n ? [x / n, y / n, z / n] : [0, 0, 0];
}

/** Recompute normals for the given vertices from every triangle that uses them (area weighted). */
export function recomputeNormals(mesh: EditMesh, vertices: Iterable<number>): void {
  const wanted = new Set(vertices);
  if (!wanted.size) return;
  const sums = new Map<number, [number, number, number]>();
  for (const v of wanted) sums.set(v, [0, 0, 0]);
  const p = mesh.positions;
  const faces = mesh.indices.length / 3;
  for (let f = 0; f < faces; f++) {
    const a = mesh.indices[f * 3], b = mesh.indices[f * 3 + 1], c = mesh.indices[f * 3 + 2];
    if (!wanted.has(a) && !wanted.has(b) && !wanted.has(c)) continue;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; // length = 2 * area
    for (const v of [a, b, c]) { const s = sums.get(v); if (s) { s[0] += nx; s[1] += ny; s[2] += nz; } }
  }
  for (const [v, s] of sums) {
    const length = Math.hypot(s[0], s[1], s[2]);
    if (length > 0) { mesh.normals[v * 3] = s[0] / length; mesh.normals[v * 3 + 1] = s[1] / length; mesh.normals[v * 3 + 2] = s[2] / length; }
  }
}

/** Triangles that use any of the vertices. */
export function facesUsing(mesh: EditMesh, vertices: Set<number>): Set<number> {
  const out = new Set<number>();
  for (let f = 0; f < mesh.indices.length / 3; f++) {
    if (vertices.has(mesh.indices[f * 3]) || vertices.has(mesh.indices[f * 3 + 1]) || vertices.has(mesh.indices[f * 3 + 2])) out.add(f);
  }
  return out;
}

/** Move the given vertices through `fn` and recompute the normals they touch. Edits in place. */
export function transformVertices(mesh: EditMesh, vertices: Iterable<number>, fn: (p: [number, number, number]) => [number, number, number]): void {
  const list = [...vertices];
  for (const v of list) {
    const q = fn([mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]]);
    mesh.positions[v * 3] = q[0]; mesh.positions[v * 3 + 1] = q[1]; mesh.positions[v * 3 + 2] = q[2];
  }
  recomputeNormals(mesh, list);
}

function append(array: Float32Array | null, extra: number[]): Float32Array | null {
  if (!array) return null;
  const out = new Float32Array(array.length + extra.length);
  out.set(array);
  out.set(extra, array.length);
  return out;
}

/** Drop vertices no triangle uses and renumber the indices. */
export function compact(mesh: EditMesh): EditMesh {
  const used = new Map<number, number>();
  const order: number[] = [];
  for (const v of mesh.indices) if (!used.has(v)) { used.set(v, order.length); order.push(v); }
  const positions = new Float32Array(order.length * 3);
  const normals = new Float32Array(order.length * 3);
  const uvs = mesh.uvs ? new Float32Array(order.length * 2) : null;
  const colors = mesh.colors ? new Float32Array(order.length * 4) : null;
  order.forEach((v, i) => {
    positions.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3);
    normals.set(mesh.normals.subarray(v * 3, v * 3 + 3), i * 3);
    if (uvs && mesh.uvs) uvs.set(mesh.uvs.subarray(v * 2, v * 2 + 2), i * 2);
    if (colors && mesh.colors) colors.set(mesh.colors.subarray(v * 4, v * 4 + 4), i * 4);
  });
  const indices = new Uint32Array(mesh.indices.length);
  mesh.indices.forEach((v, i) => { indices[i] = used.get(v) as number; });
  return { positions, normals, uvs, indices, colors };
}

/** Delete triangles. Refuses to leave an empty mesh. */
export function deleteFaces(mesh: EditMesh, faces: Iterable<number>): EditMesh {
  const drop = new Set(faces);
  const keep: number[] = [];
  for (let f = 0; f < mesh.indices.length / 3; f++) if (!drop.has(f)) keep.push(mesh.indices[f * 3], mesh.indices[f * 3 + 1], mesh.indices[f * 3 + 2]);
  if (keep.length === 0) throw new Error("EDIT_EMPTY");
  return compact({ ...mesh, indices: Uint32Array.from(keep) });
}

/** Reverse the winding and negate the normals of the given triangles, on private vertex copies. */
export function flipFaces(mesh: EditMesh, faces: Iterable<number>): EditMesh {
  const flip = new Set(faces);
  let positions = mesh.positions, normals = mesh.normals, uvs = mesh.uvs, colors = mesh.colors ?? null;
  const indices = mesh.indices.slice();
  let count = positions.length / 3;
  const addPos: number[] = [], addNor: number[] = [], addUv: number[] = [], addCol: number[] = [];
  for (const f of flip) {
    const corners = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
    const fresh = corners.map((v) => {
      addPos.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      addNor.push(-mesh.normals[v * 3], -mesh.normals[v * 3 + 1], -mesh.normals[v * 3 + 2]);
      if (mesh.uvs) addUv.push(mesh.uvs[v * 2], mesh.uvs[v * 2 + 1]);
      if (mesh.colors) addCol.push(mesh.colors[v * 4], mesh.colors[v * 4 + 1], mesh.colors[v * 4 + 2], mesh.colors[v * 4 + 3]);
      return count++;
    });
    indices[f * 3] = fresh[0]; indices[f * 3 + 1] = fresh[2]; indices[f * 3 + 2] = fresh[1];
  }
  positions = append(positions, addPos) as Float32Array;
  normals = append(normals, addNor) as Float32Array;
  uvs = append(uvs, addUv);
  colors = append(colors, addCol);
  return compact({ positions, normals, uvs, indices, colors });
}

export interface ExtrudeResult { mesh: EditMesh; faces: number[] }

/**
 * Extrude the selected triangles along their averaged normal by `distance` (metres).
 * The selected triangles move to private copies of their corners; each boundary edge of
 * the selection gets a flat side wall of its own vertices. Returns the new mesh and the
 * triangle ids of the moved faces, which become the selection.
 */
export function extrudeFaces(mesh: EditMesh, topology: Topology, faces: Iterable<number>, distance: number): ExtrudeResult {
  const selected = new Set(faces);
  if (selected.size === 0) throw new Error("EDIT_NOTHING_SELECTED");
  // Averaged, area-agnostic normal of the selection.
  const avg = [0, 0, 0];
  for (const f of selected) { avg[0] += topology.faceNormals[f * 3]; avg[1] += topology.faceNormals[f * 3 + 1]; avg[2] += topology.faceNormals[f * 3 + 2]; }
  const length = Math.hypot(avg[0], avg[1], avg[2]) || 1;
  const n = [avg[0] / length, avg[1] / length, avg[2] / length];
  const offset = [n[0] * distance, n[1] * distance, n[2] * distance];

  const positions: number[] = Array.from(mesh.positions);
  const normals: number[] = Array.from(mesh.normals);
  const uvs: number[] | null = mesh.uvs ? Array.from(mesh.uvs) : null;
  const colors: number[] | null = mesh.colors ? Array.from(mesh.colors) : null;
  const indices: number[] = Array.from(mesh.indices);
  let count = positions.length / 3;
  const copyOf = new Map<number, number>();
  const pushVertex = (v: number, move: boolean, normal?: number[]): number => {
    positions.push(mesh.positions[v * 3] + (move ? offset[0] : 0), mesh.positions[v * 3 + 1] + (move ? offset[1] : 0), mesh.positions[v * 3 + 2] + (move ? offset[2] : 0));
    normals.push(...(normal ?? [mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]]));
    if (uvs && mesh.uvs) uvs.push(mesh.uvs[v * 2], mesh.uvs[v * 2 + 1]);
    if (colors && mesh.colors) colors.push(mesh.colors[v * 4], mesh.colors[v * 4 + 1], mesh.colors[v * 4 + 2], mesh.colors[v * 4 + 3]);
    return count++;
  };
  // Moved corners: one private copy per original vertex, shared by the selected triangles that use it.
  for (const f of selected) for (let k = 0; k < 3; k++) {
    const v = mesh.indices[f * 3 + k];
    if (!copyOf.has(v)) copyOf.set(v, pushVertex(v, true));
  }
  // Side walls along the boundary edges of the selection (an edge one selected triangle uses).
  for (const f of selected) {
    for (let k = 0; k < 3; k++) {
      const e = topology.faceEdges[f][k];
      if (e < 0) continue;
      const inside = topology.edgeFaces[e].filter((g) => selected.has(g)).length;
      if (inside !== 1) continue;
      const a = mesh.indices[f * 3 + k], b = mesh.indices[f * 3 + ((k + 1) % 3)];
      const ex = mesh.positions[b * 3] - mesh.positions[a * 3], ey = mesh.positions[b * 3 + 1] - mesh.positions[a * 3 + 1], ez = mesh.positions[b * 3 + 2] - mesh.positions[a * 3 + 2];
      let wx = ey * n[2] - ez * n[1], wy = ez * n[0] - ex * n[2], wz = ex * n[1] - ey * n[0]; // e x n: outward of the region
      const wl = Math.hypot(wx, wy, wz) || 1; wx /= wl; wy /= wl; wz /= wl;
      const wall = [wx, wy, wz];
      const va = pushVertex(a, false, wall), vb = pushVertex(b, false, wall), vb2 = pushVertex(b, true, wall), va2 = pushVertex(a, true, wall);
      indices.push(va, vb, vb2, va, vb2, va2);
    }
  }
  // Re-point the selected triangles at their moved copies.
  const moved: number[] = [];
  for (const f of [...selected].sort((x, y) => x - y)) {
    for (let k = 0; k < 3; k++) indices[f * 3 + k] = copyOf.get(mesh.indices[f * 3 + k]) as number;
    moved.push(f);
  }
  return {
    mesh: {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      uvs: uvs ? Float32Array.from(uvs) : null,
      indices: Uint32Array.from(indices),
      colors: colors ? Float32Array.from(colors) : null,
    },
    faces: moved,
  };
}

/**
 * Mark a seam (PR26): cut the surface along the given edges by giving each side its own vertices. Corners of
 * triangles stay on one vertex only while they are joined round the vertex by edges that are NOT cut (and that
 * already share the vertex), so a seam must be a closed loop, or run to an open edge, before anything splits;
 * a lone cut across a closed surface changes nothing. Positions, normals and UVs are copied.
 */
export function splitEdges(mesh: EditMesh, topology: Topology, edges: Iterable<number>): EditMesh {
  const cut = new Set(edges);
  const corners = mesh.indices.length;
  const parent = Int32Array.from({ length: corners }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const cornerAt = (f: number, weld: number): number => { for (let k = 0; k < 3; k++) if (topology.weld[mesh.indices[f * 3 + k]] === weld) return f * 3 + k; return -1; };
  topology.edges.forEach(([a, b], e) => {
    if (cut.has(e)) return;
    const faces = topology.edgeFaces[e];
    for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
      for (const w of [a, b]) {
        const ci = cornerAt(faces[i], w), cj = cornerAt(faces[j], w);
        if (ci >= 0 && cj >= 0 && mesh.indices[ci] === mesh.indices[cj]) parent[find(ci)] = find(cj);
      }
    }
  });
  const groupVertex = new Map<number, number>();
  const positions: number[] = [], normals: number[] = [], uvs: number[] | null = mesh.uvs ? [] : null, colors: number[] | null = mesh.colors ? [] : null;
  const indices = new Uint32Array(corners);
  for (let c = 0; c < corners; c++) {
    const root = find(c);
    let v = groupVertex.get(root);
    if (v === undefined) {
      v = positions.length / 3; groupVertex.set(root, v);
      const src = mesh.indices[c];
      positions.push(mesh.positions[src * 3], mesh.positions[src * 3 + 1], mesh.positions[src * 3 + 2]);
      normals.push(mesh.normals[src * 3], mesh.normals[src * 3 + 1], mesh.normals[src * 3 + 2]);
      if (uvs && mesh.uvs) uvs.push(mesh.uvs[src * 2], mesh.uvs[src * 2 + 1]);
      if (colors && mesh.colors) colors.push(mesh.colors[src * 4], mesh.colors[src * 4 + 1], mesh.colors[src * 4 + 2], mesh.colors[src * 4 + 3]);
    }
    indices[c] = v;
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: uvs ? Float32Array.from(uvs) : null, indices, colors: colors ? Float32Array.from(colors) : null };
}
