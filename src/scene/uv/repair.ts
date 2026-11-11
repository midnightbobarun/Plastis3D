// src/scene/uv/repair.ts — UV repair (PR26). Pure.
//
// * An island whose triangles are mostly flipped (negative signed UV area against their 3D orientation) is
//   mirrored back.
// * NaN and Infinity values mean a failed unwrap: those islands are reported for re-unwrapping.
// * Values outside [0,1] are normalised: the whole set is scaled and shifted to fit.
export interface RepairInput { uv: Float32Array; indices: Uint32Array; /** island id per triangle. */ islandOfTriangle: Int32Array; /** the 3D orientation of each triangle's local frame is assumed counter-clockwise. */ }
export interface RepairReport { mirrored: number[]; bad: number[]; normalised: boolean }

const signedArea = (uv: Float32Array, a: number, b: number, c: number): number => ((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[b * 2 + 1] - uv[a * 2 + 1]) * (uv[c * 2] - uv[a * 2])) / 2;

/** Repairs `uv` in place; returns what it did. `badIslands` are those with non-finite values (the caller re-unwraps them). */
export function repairUv(input: RepairInput): RepairReport {
  const { uv, indices, islandOfTriangle } = input;
  const islands = new Set<number>(islandOfTriangle);
  const mirrored: number[] = [], bad: number[] = [];
  for (const island of islands) {
    let flipped = 0, total = 0, finite = true;
    for (let t = 0; t < indices.length / 3; t++) {
      if (islandOfTriangle[t] !== island) continue;
      const [a, b, c] = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
      if (![a, b, c].every((v) => Number.isFinite(uv[v * 2]) && Number.isFinite(uv[v * 2 + 1]))) { finite = false; continue; }
      total++;
      if (signedArea(uv, a, b, c) < 0) flipped++;
    }
    if (!finite) { bad.push(island); continue; }
    if (total > 0 && flipped > total / 2) {
      mirrored.push(island);
      const seen = new Set<number>();
      let maxU = -Infinity, minU = Infinity;
      for (let t = 0; t < indices.length / 3; t++) if (islandOfTriangle[t] === island) for (let k = 0; k < 3; k++) { const v = indices[t * 3 + k]; maxU = Math.max(maxU, uv[v * 2]); minU = Math.min(minU, uv[v * 2]); }
      for (let t = 0; t < indices.length / 3; t++) if (islandOfTriangle[t] === island) for (let k = 0; k < 3; k++) { const v = indices[t * 3 + k]; if (!seen.has(v)) { seen.add(v); uv[v * 2] = maxU + minU - uv[v * 2]; } }
    }
  }
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let v = 0; v < uv.length / 2; v++) {
    const [u, w] = [uv[v * 2], uv[v * 2 + 1]];
    if (!Number.isFinite(u) || !Number.isFinite(w)) continue;
    lo = [Math.min(lo[0], u), Math.min(lo[1], w)]; hi = [Math.max(hi[0], u), Math.max(hi[1], w)];
  }
  const outside = lo[0] < -1e-6 || lo[1] < -1e-6 || hi[0] > 1 + 1e-6 || hi[1] > 1 + 1e-6;
  if (outside) {
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1]) || 1;
    for (let v = 0; v < uv.length / 2; v++) {
      if (!Number.isFinite(uv[v * 2]) || !Number.isFinite(uv[v * 2 + 1])) continue;
      uv[v * 2] = (uv[v * 2] - lo[0]) / span; uv[v * 2 + 1] = (uv[v * 2 + 1] - lo[1]) / span;
    }
  }
  return { mirrored, bad, normalised: outside };
}
