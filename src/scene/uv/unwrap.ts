import { COPY } from "../../copy";
// src/scene/uv/unwrap.ts — the unwrap pipeline (PR26). Pure.
//
// Seams are the edges to cut along: edges that are ALREADY seams in the mesh (the two faces use different
// vertices there, which is what Mark seam in edit mode makes), open boundaries, and, with `autoSeams`, edges
// sharper than the dihedral angle (default 66 degrees). The faces left connected form charts, each flattened
// by LSCM, then all charts are packed into [0,1]. The result is a new mesh whose vertices are split along the
// chart borders and carry `uvs`. Nothing about the surface changes: positions and normals are copied.
import { buildTopology, faceNormalOf, triangleCount } from "../meshEdit";
import type { EditMesh } from "../meshEdit";
import { lscm } from "./lscm";
import { packIslands, placeUv } from "./pack";
import { repairUv } from "./repair";
import type { RepairReport } from "./repair";

export const MAX_UNWRAP_TRIANGLES = 50_000;
export const DEFAULT_SEAM_ANGLE = 66;

export interface UnwrapOptions { autoSeams: boolean; angle: number }
export interface UnwrapResult { mesh: EditMesh; /** island id per triangle of `mesh`. */ islandOfTriangle: Int32Array; islands: number }
export class UvError extends Error {
  readonly code: "UV_TOO_LARGE" | "UV_INVALID";
  constructor(code: "UV_TOO_LARGE" | "UV_INVALID", message: string) { super(message); this.name = "UvError"; this.code = code; }
}

function area3d(mesh: EditMesh, f: number): number {
  const p = mesh.positions, a = mesh.indices[f * 3] * 3, b = mesh.indices[f * 3 + 1] * 3, c = mesh.indices[f * 3 + 2] * 3;
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2], vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** The chart (island) id of every triangle, and how many charts there are. */
export function findCharts(mesh: EditMesh, options: UnwrapOptions): { chart: Int32Array; count: number } {
  const t = buildTopology(mesh);
  const faces = triangleCount(mesh);
  const cut = new Array<boolean>(t.edges.length).fill(false);
  const cos = Math.cos((options.angle * Math.PI) / 180);
  t.edges.forEach((edge, e) => {
    const fs = t.edgeFaces[e];
    if (fs.length !== 2) { cut[e] = true; return; }
    const verts = (f: number): string => {
      const own = [0, 1, 2].map((k) => mesh.indices[f * 3 + k]).filter((v) => t.weld[v] === edge[0] || t.weld[v] === edge[1]);
      return own.sort((x, y) => x - y).join(",");
    };
    if (verts(fs[0]) !== verts(fs[1])) { cut[e] = true; return; } // already a seam
    if (options.autoSeams) {
      const n0 = [t.faceNormals[fs[0] * 3], t.faceNormals[fs[0] * 3 + 1], t.faceNormals[fs[0] * 3 + 2]];
      const n1 = [t.faceNormals[fs[1] * 3], t.faceNormals[fs[1] * 3 + 1], t.faceNormals[fs[1] * 3 + 2]];
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < cos) cut[e] = true;
    }
  });
  const chart = new Int32Array(faces).fill(-1);
  let count = 0;
  for (let seed = 0; seed < faces; seed++) {
    if (chart[seed] >= 0) continue;
    const queue = [seed]; chart[seed] = count;
    while (queue.length) {
      const f = queue.pop() as number;
      for (const e of t.faceEdges[f]) {
        if (e < 0 || cut[e]) continue;
        for (const g of t.edgeFaces[e]) if (chart[g] < 0) { chart[g] = count; queue.push(g); }
      }
    }
    count++;
  }
  return { chart, count };
}

/** Flatten every chart by LSCM and pack them. */
export async function unwrap(mesh: EditMesh, options: UnwrapOptions = { autoSeams: true, angle: DEFAULT_SEAM_ANGLE }, yieldNow: () => Promise<void> = async () => {}): Promise<UnwrapResult> {
  if (triangleCount(mesh) > MAX_UNWRAP_TRIANGLES) throw new UvError("UV_TOO_LARGE", `This mesh has ${triangleCount(mesh).toLocaleString()} triangles; unwrapping works on up to ${MAX_UNWRAP_TRIANGLES.toLocaleString()}.`);
  const topology = buildTopology(mesh);
  const { chart, count } = findCharts(mesh, options);
  const faces = triangleCount(mesh);
  const chartFaces: number[][] = Array.from({ length: count }, () => []);
  for (let f = 0; f < faces; f++) chartFaces[chart[f]].push(f);
  const solved: Array<{ weld: Map<number, number>; uv: Float64Array; area: number; source: number[]; faces: number[] }> = [];
  for (const list of chartFaces) {
    const weld = new Map<number, number>();
    const source: number[] = []; // an original vertex index per local vertex (for normals)
    const positions: number[] = [];
    const tri: number[] = [];
    let area = 0;
    for (const f of list) {
      area += area3d(mesh, f);
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[f * 3 + k], w = topology.weld[v];
        let local = weld.get(w);
        if (local === undefined) { local = weld.size; weld.set(w, local); source.push(v); positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]); }
        tri.push(local);
      }
    }
    const result = await lscm({ positions: Float64Array.from(positions), triangles: Uint32Array.from(tri) }, yieldNow);
    solved.push({ weld, uv: result.uv, area, source, faces: list });
  }
  const placements = packIslands(solved.map((s) => ({ uv: s.uv, area: s.area })));
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const colors: number[] | null = mesh.colors ? [] : null;
  const indices = new Uint32Array(faces * 3);
  const islandOfTriangle = new Int32Array(faces);
  solved.forEach((s, id) => {
    const placed = placeUv(s.uv, placements[id]);
    const output = new Map<number, number>();
    for (const f of s.faces) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[f * 3 + k];
        let index = output.get(v);
        if (index === undefined) {
          index = positions.length / 3; output.set(v, index);
          const local = s.weld.get(topology.weld[v])!;
          positions.push(...mesh.positions.subarray(v * 3, v * 3 + 3));
          normals.push(...mesh.normals.subarray(v * 3, v * 3 + 3));
          if (colors && mesh.colors) colors.push(...mesh.colors.subarray(v * 4, v * 4 + 4));
          uvs.push(placed[local * 2], placed[local * 2 + 1]);
        }
        indices[f * 3 + k] = index;
      }
      islandOfTriangle[f] = id;
    }
  });
  return { mesh: { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices, colors: colors ? Float32Array.from(colors) : null }, islandOfTriangle, islands: count };
}

/** Re-pack the islands of a result at the current UV scale (keeps each island's shape). */
export function packResult(result: UnwrapResult): UnwrapResult {
  const { mesh, islandOfTriangle, islands } = result;
  const uv = mesh.uvs as Float32Array;
  const members: Array<Set<number>> = Array.from({ length: islands }, () => new Set<number>());
  const area = new Array<number>(islands).fill(0);
  for (let f = 0; f < islandOfTriangle.length; f++) {
    for (let k = 0; k < 3; k++) members[islandOfTriangle[f]].add(mesh.indices[f * 3 + k]);
    area[islandOfTriangle[f]] += area3d(mesh, f);
  }
  const lists = members.map((m) => [...m]);
  const islandUv = lists.map((vs) => { const a = new Float64Array(vs.length * 2); vs.forEach((v, i) => { a[i * 2] = uv[v * 2]; a[i * 2 + 1] = uv[v * 2 + 1]; }); return a; });
  const placements = packIslands(islandUv.map((a, i) => ({ uv: a, area: area[i] })));
  const out = Float32Array.from(uv);
  lists.forEach((vs, i) => { const placed = placeUv(islandUv[i], placements[i]); vs.forEach((v, j) => { out[v * 2] = placed[j * 2]; out[v * 2 + 1] = placed[j * 2 + 1]; }); });
  return { ...result, mesh: { ...mesh, uvs: out } };
}

export interface RepairOutcome { result: UnwrapResult; report: RepairReport }

/** Repair flipped islands, re-unwrap islands with non-finite values, and normalise out-of-range UVs. */
export async function repairResult(result: UnwrapResult, source: EditMesh, options: UnwrapOptions): Promise<RepairOutcome> {
  if (triangleCount(result.mesh) > MAX_UNWRAP_TRIANGLES) throw new UvError("UV_TOO_LARGE", COPY.uvRepairCap);
  void source; void options; // Repair the result's charts; their indices already encode its seams.
  const uv = Float32Array.from(result.mesh.uvs as Float32Array);
  const report: RepairReport = { mirrored: [], bad: [], normalised: false };
  const members = Array.from({ length: result.islands }, () => new Set<number>());
  for (let f = 0; f < result.islandOfTriangle.length; f++) for (let k = 0; k < 3; k++) members[result.islandOfTriangle[f]].add(result.mesh.indices[f * 3 + k]);
  // Run finite/flipped/range repair per chart, avoiding global rescaling of good islands.
  for (let id = 0; id < members.length; id++) {
    const vs = [...members[id]], lookup = new Map(vs.map((v, i) => [v, i]));
    const local = Float32Array.from(vs.flatMap((v) => [uv[v * 2], uv[v * 2 + 1]]));
    const triangles: number[] = [];
    for (let f = 0; f < result.islandOfTriangle.length; f++) if (result.islandOfTriangle[f] === id) for (let k = 0; k < 3; k++) triangles.push(lookup.get(result.mesh.indices[f * 3 + k])!);
    const r = repairUv({ uv: local, indices: Uint32Array.from(triangles), islandOfTriangle: new Int32Array(triangles.length / 3) });
    if (r.bad.length) { report.bad.push(id); continue; }
    if (r.mirrored.length) report.mirrored.push(id);
    report.normalised ||= r.normalised;
    vs.forEach((v, i) => { uv[v * 2] = local[i * 2]; uv[v * 2 + 1] = local[i * 2 + 1]; });
  }
  type Rect = { x: number; y: number; w: number; h: number };
  let free: Rect[] = [{ x: 0.002, y: 0.002, w: 0.996, h: 0.996 }];
  const occupy = (b: Rect) => {
    const next: Rect[] = [];
    for (const r of free) {
      const x = Math.max(r.x, b.x), y = Math.max(r.y, b.y), right = Math.min(r.x + r.w, b.x + b.w), top = Math.min(r.y + r.h, b.y + b.h);
      if (right <= x || top <= y) { next.push(r); continue; }
      next.push({ x: r.x, y: r.y, w: x - r.x, h: r.h }, { x: right, y: r.y, w: r.x + r.w - right, h: r.h }, { x, y: r.y, w: right - x, h: y - r.y }, { x, y: top, w: right - x, h: r.y + r.h - top });
    }
    free = next.filter((r) => r.w > 1e-6 && r.h > 1e-6);
    if (free.length > 4096) throw new UvError("UV_INVALID", COPY.uvRepairRegions);
  };
  let goodSurface = 0, goodUvArea = 0;
  for (let f = 0; f < result.islandOfTriangle.length; f++) if (!report.bad.includes(result.islandOfTriangle[f])) {
    goodSurface += area3d(result.mesh, f);
    goodUvArea += Math.abs(uvSignedArea({ ...result.mesh, uvs: uv }, f));
  }
  for (let id = 0; id < members.length; id++) if (!report.bad.includes(id)) {
    let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
    for (const v of members[id]) { x = Math.min(x, uv[v * 2]); y = Math.min(y, uv[v * 2 + 1]); right = Math.max(right, uv[v * 2]); top = Math.max(top, uv[v * 2 + 1]); }
    occupy({ x: x - 0.001, y: y - 0.001, w: right - x + 0.002, h: top - y + 0.002 });
  }
  for (const id of report.bad) {
    const vs = [...members[id]], lookup = new Map(vs.map((v, i) => [v, i]));
    if (members.some((m, i) => i !== id && vs.some((v) => m.has(v)))) throw new UvError("UV_INVALID", COPY.uvRepairBorders);
    const positions = Float64Array.from(vs.flatMap((v) => Array.from(result.mesh.positions.subarray(v * 3, v * 3 + 3))));
    const triangles: number[] = [];
    let area = 0;
    for (let f = 0; f < result.islandOfTriangle.length; f++) if (result.islandOfTriangle[f] === id) { area += area3d(result.mesh, f); for (let k = 0; k < 3; k++) triangles.push(lookup.get(result.mesh.indices[f * 3 + k])!); }
    if (area < 1e-12) throw new UvError("UV_INVALID", COPY.uvRepairDegenerate);
    const solved = await lscm({ positions, triangles: Uint32Array.from(triangles) });
    if (!solved.converged || !solved.uv.every(Number.isFinite)) throw new UvError("UV_INVALID", COPY.uvRepairConvergence);
    let x = Infinity, y = Infinity, right = -Infinity, top = -Infinity;
    for (let i = 0; i < vs.length; i++) { x = Math.min(x, solved.uv[i * 2]); y = Math.min(y, solved.uv[i * 2 + 1]); right = Math.max(right, solved.uv[i * 2]); top = Math.max(top, solved.uv[i * 2 + 1]); }
    const w = right - x, h = top - y;
    if (w * h < 1e-12) throw new UvError("UV_INVALID", COPY.uvRepairSingular);
    const candidates = free.map((r) => ({ r, scale: Math.min(r.w / w, r.h / h) })).sort((a, b) => b.scale - a.scale);
    const best = candidates[0];
    if (!best || best.scale < 1e-6) throw new UvError("UV_INVALID", COPY.uvRepairSpace);
    let solvedArea = 0;
    for (let f = 0; f < triangles.length; f += 3) {
      const [a, b, c] = triangles.slice(f, f + 3), u = solved.uv;
      solvedArea += Math.abs((u[b * 2] - u[a * 2]) * (u[c * 2 + 1] - u[a * 2 + 1]) - (u[b * 2 + 1] - u[a * 2 + 1]) * (u[c * 2] - u[a * 2])) / 2;
    }
    // Match the valid charts' area density when space permits; never resize them.
    const scale = goodSurface > 0 && goodUvArea > 0 && solvedArea > 0 ? Math.min(best.scale, Math.sqrt(goodUvArea / goodSurface * area / solvedArea)) : best.scale;
    vs.forEach((v, i) => { uv[v * 2] = best.r.x + (solved.uv[i * 2] - x) * scale; uv[v * 2 + 1] = best.r.y + (solved.uv[i * 2 + 1] - y) * scale; });
    occupy({ x: best.r.x, y: best.r.y, w: w * scale, h: h * scale });
  }
  const next: UnwrapResult = { ...result, mesh: { ...result.mesh, uvs: uv } };
  return { result: next, report };
}

/** Move, rotate (90 degrees steps) or scale one island about its centre. */
export function transformIsland(result: UnwrapResult, island: number, op: { move?: [number, number]; rotate?: 1 | -1; scale?: number }): UnwrapResult {
  const { mesh, islandOfTriangle } = result;
  const uv = Float32Array.from(mesh.uvs as Float32Array);
  const verts = new Set<number>();
  for (let f = 0; f < islandOfTriangle.length; f++) if (islandOfTriangle[f] === island) for (let k = 0; k < 3; k++) verts.add(mesh.indices[f * 3 + k]);
  let cu = 0, cv = 0;
  for (const v of verts) { cu += uv[v * 2]; cv += uv[v * 2 + 1]; }
  cu /= verts.size || 1; cv /= verts.size || 1;
  for (const v of verts) {
    let u = uv[v * 2] - cu, w = uv[v * 2 + 1] - cv;
    if (op.rotate) [u, w] = op.rotate === 1 ? [-w, u] : [w, -u];
    if (op.scale) { u *= op.scale; w *= op.scale; }
    uv[v * 2] = u + cu + (op.move?.[0] ?? 0); uv[v * 2 + 1] = w + cv + (op.move?.[1] ?? 0);
  }
  return { ...result, mesh: { ...mesh, uvs: uv } };
}

/** The smallest face-normal sanity helper for tests: a triangle's UV signed area. */
export function uvSignedArea(mesh: EditMesh, f: number): number {
  const uv = mesh.uvs as Float32Array, [a, b, c] = [0, 1, 2].map((k) => mesh.indices[f * 3 + k]);
  return ((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[b * 2 + 1] - uv[a * 2 + 1]) * (uv[c * 2] - uv[a * 2])) / 2;
}
void faceNormalOf;
