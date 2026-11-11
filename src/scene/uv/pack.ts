// src/scene/uv/pack.ts — shelf ("skyline") packing of UV islands into [0,1] (PR26). Pure.
//
// Islands are scaled so UV area follows 3D area (one texel density), then packed row by row with a 2 px margin
// at 1024 x 1024 (0.00195 of the square) on every side. Each island may turn 90 degrees if that sits lower.
export const MARGIN = 2 / 1024;

export interface Island { /** uv per local vertex (u, v). */ uv: Float64Array; /** the island's 3D surface area. */ area: number }
export interface Placement { scale: number; rotated: boolean; offsetU: number; offsetV: number }

interface Box { minU: number; minV: number; w: number; h: number }
const boxOf = (uv: Float64Array): Box => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < uv.length; i += 2) { a = Math.min(a, uv[i]); b = Math.min(b, uv[i + 1]); c = Math.max(c, uv[i]); d = Math.max(d, uv[i + 1]); }
  return { minU: a, minV: b, w: c - a, h: d - b };
};

/** Try a global scale; returns placements when every island fits in the unit square, else null. */
function tryPack(boxes: Box[], base: number[], scale: number): Placement[] | null {
  const order = boxes.map((_, i) => i).sort((i, j) => Math.max(boxes[j].w, boxes[j].h) * base[j] - Math.max(boxes[i].w, boxes[i].h) * base[i]);
  const placements: Placement[] = new Array(boxes.length);
  let x = MARGIN, y = MARGIN, rowH = 0;
  for (const i of order) {
    const s = base[i] * scale;
    const options = [{ w: boxes[i].w * s, h: boxes[i].h * s, rotated: false }, { w: boxes[i].h * s, h: boxes[i].w * s, rotated: true }];
    // Prefer the orientation that is no taller than the current row, then the flatter one.
    options.sort((p, q) => (Math.abs(p.h - rowH) - Math.abs(q.h - rowH)) || (p.h - q.h));
    let placed = false;
    for (const o of options) {
      if (x + o.w + MARGIN <= 1 + 1e-12 && y + Math.max(rowH, o.h) + MARGIN <= 1 + 1e-12) {
        placements[i] = { scale: s, rotated: o.rotated, offsetU: x, offsetV: y };
        x += o.w + 2 * MARGIN; rowH = Math.max(rowH, o.h); placed = true; break;
      }
    }
    if (!placed) { // a new shelf
      x = MARGIN; y += rowH + 2 * MARGIN; rowH = 0;
      const o = options[0];
      if (x + o.w + MARGIN > 1 + 1e-12 || y + o.h + MARGIN > 1 + 1e-12) return null;
      placements[i] = { scale: s, rotated: o.rotated, offsetU: x, offsetV: y };
      x += o.w + 2 * MARGIN; rowH = o.h;
    }
  }
  return placements;
}

/** Pack islands into the unit square. Returns one placement per island (same order). */
export function packIslands(islands: Island[]): Placement[] {
  if (islands.length === 0) return [];
  const boxes = islands.map((i) => boxOf(i.uv));
  // Texel density: island UV area should be proportional to its 3D area.
  const uvAreas = boxes.map((b, i) => { let s = 0; const u = islands[i].uv; void u; s = b.w * b.h; return s; });
  const total3d = islands.reduce((s, i) => s + i.area, 0) || 1;
  const base = islands.map((isl, i) => Math.sqrt(((isl.area / total3d) * 0.5) / Math.max(uvAreas[i], 1e-18)));
  let lo = 0, hi = 4, best: Placement[] | null = null;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const got = tryPack(boxes, base, mid);
    if (got) { best = got; lo = mid; } else hi = mid;
  }
  return best ?? tryPack(boxes, base, 1e-6)!;
}

/** Apply a placement to an island's uv, returning new uv (u, v) in [0,1]. */
export function placeUv(uv: Float64Array, placement: Placement): Float64Array {
  const box = boxOf(uv);
  const out = new Float64Array(uv.length);
  for (let i = 0; i < uv.length; i += 2) {
    let u = (uv[i] - box.minU) * placement.scale, v = (uv[i + 1] - box.minV) * placement.scale;
    // A quarter turn, not a swap: (u, v) -> (v, w - u) keeps the island's orientation (a swap would mirror it).
    if (placement.rotated) [u, v] = [v, box.w * placement.scale - u];
    out[i] = placement.offsetU + u; out[i + 1] = placement.offsetV + v;
  }
  return out;
}
