// src/scene/paint.ts — vertex colour painting (PR29, v1: COLOR_0 only). Pure.
//
// Colours are RGBA floats (0..1) per vertex. A dab blends the brush colour into the vertices within the radius by
// strength times a falloff whose edge is set by `hardness` (1 = a hard disc, 0 = fully soft). Fill sets every
// vertex. Texture paint is post-entry.
import type { EditMesh } from "./meshEdit";

export interface PaintSettings { color: [number, number, number, number]; radius: number; strength: number; hardness: number; symmetryX: boolean }

/** The paint falloff: full inside `hardness * radius`, then smooth to 0 at the radius. */
export function paintFalloff(distance: number, radius: number, hardness: number): number {
  if (distance >= radius || radius <= 0) return 0;
  const inner = Math.min(0.999, Math.max(0, hardness)) * radius;
  if (distance <= inner) return 1;
  const t = (distance - inner) / (radius - inner);
  return (1 - t * t) * (1 - t * t);
}

/** The mesh's colour array, created (opaque white) on first use. Returns it. */
export function ensureColors(mesh: EditMesh): Float32Array {
  if (!mesh.colors) mesh.colors = new Float32Array((mesh.positions.length / 3) * 4).fill(1);
  return mesh.colors;
}

function dab(mesh: EditMesh, point: [number, number, number], s: PaintSettings, touched: Set<number>): void {
  const colors = ensureColors(mesh);
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const d = Math.hypot(mesh.positions[v * 3] - point[0], mesh.positions[v * 3 + 1] - point[1], mesh.positions[v * 3 + 2] - point[2]);
    const k = paintFalloff(d, s.radius, s.hardness) * s.strength;
    if (k <= 0) continue;
    for (let c = 0; c < 4; c++) colors[v * 4 + c] += (s.color[c] - colors[v * 4 + c]) * k;
    touched.add(v);
  }
}

/** One dab (and its X mirror). Returns the vertices it touched. */
export function paintDab(mesh: EditMesh, point: [number, number, number], settings: PaintSettings): Set<number> {
  const touched = new Set<number>();
  dab(mesh, point, settings, touched);
  if (settings.symmetryX) dab(mesh, [-point[0], point[1], point[2]], settings, touched);
  return touched;
}

/** Fill every vertex with one colour. */
export function fillColor(mesh: EditMesh, color: [number, number, number, number]): void {
  const colors = ensureColors(mesh);
  for (let v = 0; v < colors.length / 4; v++) for (let c = 0; c < 4; c++) colors[v * 4 + c] = color[c];
}

/** Parse "#rrggbb" into 0..1 RGBA. */
export function hexToColor(hex: string, alpha = 1): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1, alpha];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}
