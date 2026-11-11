// src/scene/sculpt/brushes.ts — the sculpt brushes (PR29). Pure: no DOM, no three.
//
// Fixed topology: a brush only moves vertices. Each stroke dab finds the vertices within `radius` of the hit
// point (all the split copies of one position move together), weights them with a smooth falloff, moves them,
// and recomputes normals only for the touched region. X symmetry applies the same dab at the mirrored hit
// across x = 0. Brushes: draw (along the normal), smooth (Laplacian, toward the neighbours' average), flatten
// (onto the plane through the hit) and grab (follow a drag by a delta).
import { buildTopology, recomputeNormals } from "../meshEdit";
import type { EditMesh, Topology } from "../meshEdit";

export type BrushType = "draw" | "smooth" | "flatten" | "grab";
export interface BrushSettings { type: BrushType; radius: number; strength: number; symmetryX: boolean; /** draw only: push inward instead of outward. */ invert?: boolean }
export interface Hit { point: [number, number, number]; normal: [number, number, number] }

export const MIN_RADIUS = 0.005;
/** One draw dab moves a vertex at the centre by at most strength x radius x this (a stroke is many dabs, one per pointer event). */
export const DRAW_STEP = 0.05;
export const MAX_STROKES = 100;

/** The smooth falloff: 1 at the centre, 0 at the radius, (1 - t^2)^2 between. */
export function falloff(distance: number, radius: number): number {
  if (distance >= radius || radius <= 0) return 0;
  const t = distance / radius;
  return (1 - t * t) * (1 - t * t);
}

export interface SculptContext { topology: Topology; neighbours: number[][] }

/** Adjacency for the smooth brush, built once per topology (the weld ids that share an edge). */
export function sculptContext(mesh: EditMesh): SculptContext {
  const topology = buildTopology(mesh);
  const neighbours: number[][] = topology.members.map(() => []);
  for (const [a, b] of topology.edges) { neighbours[a].push(b); neighbours[b].push(a); }
  return { topology, neighbours };
}

function weldPosition(mesh: EditMesh, t: Topology, w: number): [number, number, number] {
  const v = t.members[w][0] * 3;
  return [mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]];
}

/** The weld ids within `radius` of `point` with their weights. A linear scan: an 8 ms budget holds to 200,000 triangles. */
export function affected(mesh: EditMesh, ctx: SculptContext, point: [number, number, number], radius: number): Array<{ weld: number; weight: number }> {
  const out: Array<{ weld: number; weight: number }> = [];
  const r2 = radius * radius;
  for (let w = 0; w < ctx.topology.members.length; w++) {
    const v = ctx.topology.members[w][0] * 3;
    const dx = mesh.positions[v] - point[0], dy = mesh.positions[v + 1] - point[1], dz = mesh.positions[v + 2] - point[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < r2) out.push({ weld: w, weight: falloff(Math.sqrt(d2), radius) });
  }
  return out;
}

function setWeld(mesh: EditMesh, t: Topology, w: number, p: [number, number, number]): void {
  for (const v of t.members[w]) { mesh.positions[v * 3] = p[0]; mesh.positions[v * 3 + 1] = p[1]; mesh.positions[v * 3 + 2] = p[2]; }
}

function dab(mesh: EditMesh, ctx: SculptContext, hit: Hit, s: BrushSettings, delta: [number, number, number] | null, touched: Set<number>): void {
  const near = affected(mesh, ctx, hit.point, s.radius);
  const n = hit.normal;
  const new_: Array<[number, [number, number, number]]> = [];
  for (const { weld, weight } of near) {
    const p = weldPosition(mesh, ctx.topology, weld);
    const k = weight * s.strength;
    let q: [number, number, number] = p;
    if (s.type === "draw") {
      const step = k * s.radius * DRAW_STEP * (s.invert ? -1 : 1);
      q = [p[0] + n[0] * step, p[1] + n[1] * step, p[2] + n[2] * step];
    } else if (s.type === "flatten") {
      const d = (p[0] - hit.point[0]) * n[0] + (p[1] - hit.point[1]) * n[1] + (p[2] - hit.point[2]) * n[2];
      q = [p[0] - n[0] * d * k, p[1] - n[1] * d * k, p[2] - n[2] * d * k];
    } else if (s.type === "smooth") {
      const ns = ctx.neighbours[weld];
      if (!ns.length) continue;
      const avg = [0, 0, 0];
      for (const m of ns) { const r = weldPosition(mesh, ctx.topology, m); avg[0] += r[0] / ns.length; avg[1] += r[1] / ns.length; avg[2] += r[2] / ns.length; }
      q = [p[0] + (avg[0] - p[0]) * k, p[1] + (avg[1] - p[1]) * k, p[2] + (avg[2] - p[2]) * k];
    } else if (delta) {
      q = [p[0] + delta[0] * weight, p[1] + delta[1] * weight, p[2] + delta[2] * weight];
    }
    new_.push([weld, q]);
  }
  // Apply after the scan so a smooth dab reads the positions from before it.
  for (const [weld, q] of new_) { setWeld(mesh, ctx.topology, weld, q); for (const v of ctx.topology.members[weld]) touched.add(v); }
}

/** Apply one dab (and its X mirror) at `hit`. Returns the vertex indices it moved, normals already refreshed. */
export function applyBrush(mesh: EditMesh, ctx: SculptContext, hit: Hit, settings: BrushSettings, delta: [number, number, number] | null = null): Set<number> {
  const touched = new Set<number>();
  dab(mesh, ctx, hit, settings, delta, touched);
  if (settings.symmetryX) dab(mesh, ctx, { point: [-hit.point[0], hit.point[1], hit.point[2]], normal: [-hit.normal[0], hit.normal[1], hit.normal[2]] }, settings, delta ? [-delta[0], delta[1], delta[2]] : null, touched);
  if (touched.size) {
    // The faces around a moved vertex change shape: refresh normals on the touched vertices only.
    recomputeNormals(mesh, touched);
  }
  return touched;
}
