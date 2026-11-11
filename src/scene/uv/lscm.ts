// src/scene/uv/lscm.ts — least-squares conformal maps for one chart (PR26). Pure, no xatlas (WASM).
//
// A chart is a set of triangles over local vertices. LSCM minimises the conformal energy of the map from the
// triangles' own planes to the UV plane. Two vertices are pinned (the farthest pair, so the result is not
// degenerate); the rest are solved from the sparse least-squares system by conjugate gradient on the normal
// equations (at most 2,000 iterations, tolerance 1e-8). `yieldNow` lets the caller hand the thread back
// between slices (the 8 ms per-frame chunk).
export interface Chart {
  /** Local vertex positions, xyz per vertex. */
  positions: Float64Array;
  /** Three local vertex indices per triangle. */
  triangles: Uint32Array;
}

export const CG_MAX_ITERATIONS = 2000;
export const CG_TOLERANCE = 1e-8;
export const SLICE_MS = 8;

interface Row { cols: number[]; values: number[] }

export interface LscmResult { uv: Float64Array; iterations: number; converged: boolean }

/** The two local vertices farthest apart (a cheap two-sweep estimate). */
export function pinnedPair(positions: Float64Array): [number, number] {
  const n = positions.length / 3;
  const far = (from: number): number => {
    let best = from, bestD = -1;
    for (let v = 0; v < n; v++) {
      const d = Math.hypot(positions[v * 3] - positions[from * 3], positions[v * 3 + 1] - positions[from * 3 + 1], positions[v * 3 + 2] - positions[from * 3 + 2]);
      if (d > bestD) { bestD = d; best = v; }
    }
    return best;
  };
  const a = far(0);
  return [a, far(a)];
}

export async function lscm(chart: Chart, yieldNow: () => Promise<void> = async () => {}, now: () => number = () => performance.now()): Promise<LscmResult> {
  const n = chart.positions.length / 3;
  const p = chart.positions;
  const tris = chart.triangles.length / 3;
  // Rows of the conformal system: two real rows (real and imaginary part) per triangle.
  const rows: Row[] = [];
  for (let t = 0; t < tris; t++) {
    const a = chart.triangles[t * 3], b = chart.triangles[t * 3 + 1], c = chart.triangles[t * 3 + 2];
    // Local 2D frame in the triangle's plane: x along a->b, y perpendicular in the plane.
    const ex = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const ac = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const lx = Math.hypot(ex[0], ex[1], ex[2]);
    if (lx < 1e-12) continue;
    const xu = ex.map((v) => v / lx);
    const cx = ac[0] * xu[0] + ac[1] * xu[1] + ac[2] * xu[2];
    const perp = [ac[0] - cx * xu[0], ac[1] - cx * xu[1], ac[2] - cx * xu[2]];
    const cy = Math.hypot(perp[0], perp[1], perp[2]); // >= 0: orientation is fixed by the frame
    const x1 = 0, y1 = 0, x2 = lx, y2 = 0, x3 = cx, y3 = cy;
    const d = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
    if (d < 1e-14) continue; // a degenerate triangle carries no information
    const s = 1 / Math.sqrt(d);
    const w = [[(x3 - x2) * s, (y3 - y2) * s], [(x1 - x3) * s, (y1 - y3) * s], [(x2 - x1) * s, (y2 - y1) * s]];
    const idx = [a, b, c];
    // r = sum W_j z_j with z = u + iv:  re = sum(Wre*u - Wim*v),  im = sum(Wim*u + Wre*v)
    rows.push({ cols: [0, 1, 2].flatMap((j) => [idx[j], n + idx[j]]), values: [0, 1, 2].flatMap((j) => [w[j][0], -w[j][1]]) });
    rows.push({ cols: [0, 1, 2].flatMap((j) => [idx[j], n + idx[j]]), values: [0, 1, 2].flatMap((j) => [w[j][1], w[j][0]]) });
  }
  const [p0, p1] = pinnedPair(chart.positions);
  const dist = Math.hypot(p[p0 * 3] - p[p1 * 3], p[p0 * 3 + 1] - p[p1 * 3 + 1], p[p0 * 3 + 2] - p[p1 * 3 + 2]) || 1;
  const pinned = new Map<number, number>([[p0, 0], [n + p0, 0], [p1, dist], [n + p1, 0]]); // unknown index -> fixed value
  const free: number[] = [];
  const slot = new Int32Array(2 * n).fill(-1);
  for (let k = 0; k < 2 * n; k++) if (!pinned.has(k)) { slot[k] = free.length; free.push(k); }
  const m = free.length;
  // b = -A_p x_p, applied row by row.
  const rhs = new Float64Array(rows.length);
  rows.forEach((row, r) => { let s = 0; row.cols.forEach((col, i) => { const f = pinned.get(col); if (f !== undefined) s -= row.values[i] * f; }); rhs[r] = s; });
  const Av = (x: Float64Array, out: Float64Array) => rows.forEach((row, r) => { let s = 0; row.cols.forEach((col, i) => { const k = slot[col]; if (k >= 0) s += row.values[i] * x[k]; }); out[r] = s; });
  const Atv = (y: Float64Array, out: Float64Array) => { out.fill(0); rows.forEach((row, r) => row.cols.forEach((col, i) => { const k = slot[col]; if (k >= 0) out[k] += row.values[i] * y[r]; })); };
  // Conjugate gradient on A^T A x = A^T b.
  const x = new Float64Array(m), g = new Float64Array(m), pdir = new Float64Array(m), tmpR = new Float64Array(rows.length), q = new Float64Array(m);
  Atv(rhs, g); // residual of the normal equations at x = 0
  pdir.set(g);
  let rs = g.reduce((s, v) => s + v * v, 0);
  const stop = CG_TOLERANCE * Math.max(1, Math.sqrt(g.reduce((s, v) => s + v * v, 0)));
  let it = 0, converged = Math.sqrt(rs) <= stop, sliceStart = now();
  while (!converged && it < CG_MAX_ITERATIONS) {
    Av(pdir, tmpR); Atv(tmpR, q);
    const pq = pdir.reduce((s, v, i) => s + v * q[i], 0);
    if (pq <= 0) break;
    const alpha = rs / pq;
    for (let i = 0; i < m; i++) { x[i] += alpha * pdir[i]; g[i] -= alpha * q[i]; }
    const rsNew = g.reduce((s, v) => s + v * v, 0);
    it++;
    if (Math.sqrt(rsNew) <= stop) { converged = true; break; }
    const beta = rsNew / rs; rs = rsNew;
    for (let i = 0; i < m; i++) pdir[i] = g[i] + beta * pdir[i];
    if (now() - sliceStart > SLICE_MS) { await yieldNow(); sliceStart = now(); }
  }
  const uv = new Float64Array(n * 2);
  const value = (k: number): number => { const f = pinned.get(k); return f !== undefined ? f : x[slot[k]]; };
  for (let v = 0; v < n; v++) { uv[v * 2] = value(v); uv[v * 2 + 1] = value(n + v); }
  return { uv, iterations: it, converged };
}
