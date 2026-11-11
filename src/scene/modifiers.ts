import { COPY } from "../copy";
// src/scene/modifiers.ts — the modifier stack (PR25). Pure JS on the main thread, no DOM.
//
// A stack of up to 8 entries is applied, in order, to an un-modified BASE mesh and the result is baked.
// The base asset stays in the scene (the generator's `params.baseAssetId`), so the stack can be edited and
// re-applied non-destructively. Each modifier: mirror, array, subdivide (Loop), smooth (Laplacian), decimate
// (three's SimplifyModifier) and edge split (three's EdgeSplitModifier). The output size is PREDICTED
// before anything runs (MODIFIER_TOO_LARGE over 100,000 triangles); each step must finish within 1 s.
import * as THREE from "three";
import { EdgeSplitModifier } from "three/addons/modifiers/EdgeSplitModifier.js";
import { SimplifyModifier } from "three/addons/modifiers/SimplifyModifier.js";
import { buildTopology, recomputeNormals, triangleCount } from "./meshEdit";
import type { EditMesh } from "./meshEdit";

export type ModifierType = "mirror" | "array" | "subdivide" | "smooth" | "decimate" | "edgeSplit";
export interface ModifierEntry { type: ModifierType; enabled: boolean; params: Record<string, number | number[] | string> }
/** Optional source indices are paired; old single-primitive bases omit them. */
export interface ModifierGeneratorParams extends Record<string, unknown> { baseAssetId: string; stack: ModifierEntry[]; baseMeshIndex?: number; basePrimitiveIndex?: number }
export const MODIFIER_TYPES: ModifierType[] = ["mirror", "array", "subdivide", "smooth", "decimate", "edgeSplit"];
export const MAX_STACK = 8;
export const MAX_MODIFIER_TRIANGLES = 100_000;
export const MODIFIER_STEP_MS = 1000;
/** Decimate and edge split are O(n log n) in JS: refuse inputs that cannot finish in the step budget. */
export const MAX_DECIMATE_TRIANGLES = 30_000;

export const MODIFIER_LABELS: Record<ModifierType, string> = { mirror: "Mirror", array: "Array", subdivide: "Subdivide", smooth: "Smooth", decimate: "Decimate", edgeSplit: "Edge split" };

export function defaultEntry(type: ModifierType): ModifierEntry {
  const params: Record<ModifierType, ModifierEntry["params"]> = {
    mirror: { axis: "x", threshold: 0.001 }, array: { count: 2, offset: [1, 0, 0] }, subdivide: { levels: 1 },
    smooth: { iterations: 2, factor: 0.5 }, decimate: { ratio: 0.5 }, edgeSplit: { angle: 30 },
  };
  return { type, enabled: true, params: structuredClone(params[type]) };
}

export type ModifierErrorCode = "MODIFIER_INVALID" | "MODIFIER_TOO_LARGE" | "MODIFIER_TOO_SLOW";
export class ModifierError extends Error {
  readonly code: ModifierErrorCode;
  constructor(code: ModifierErrorCode, message: string) { super(message); this.name = "ModifierError"; this.code = code; }
}

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** The same rules as the server's `modifiers` generator validation (validate.py). Returns a sentence or null. */
export function validateEntry(e: ModifierEntry): string | null {
  const p = e.params as Record<string, unknown>;
  if (typeof e.enabled !== "boolean") return "enabled must be true or false";
  switch (e.type) {
    case "mirror": return ["x", "y", "z"].includes(p.axis as string) && num(p.threshold, 0, 1) ? null : "Mirror needs an axis (x, y or z) and a merge threshold from 0 to 1 m.";
    case "array": return Number.isInteger(p.count) && num(p.count, 1, 64) && Array.isArray(p.offset) && p.offset.length === 3 && p.offset.every((v) => num(v, -1000, 1000)) ? null : "Array needs a count from 1 to 64 and an offset of three numbers.";
    case "subdivide": return Number.isInteger(p.levels) && num(p.levels, 1, 2) ? null : "Subdivide takes 1 or 2 levels.";
    case "smooth": return Number.isInteger(p.iterations) && num(p.iterations, 1, 10) && num(p.factor, 0, 1) ? null : "Smooth takes 1 to 10 iterations and a factor from 0 to 1.";
    case "decimate": return num(p.ratio, 0.05, 0.95) ? null : "Decimate takes a target ratio from 0.05 to 0.95.";
    case "edgeSplit": return num(p.angle, 1, 180) ? null : "Edge split takes an angle from 1 to 180 degrees.";
    default: return "Unknown modifier.";
  }
}

export function validateStack(stack: readonly ModifierEntry[]): string | null {
  if (stack.length > MAX_STACK) return `A stack holds at most ${MAX_STACK} modifiers.`;
  for (const entry of stack) { const problem = validateEntry(entry); if (problem) return problem; }
  return null;
}

/** Triangles after each enabled modifier, predicted from the input count (x4 per subdivide level, x count for array). */
export function predictTriangles(tris: number, stack: readonly ModifierEntry[]): number {
  let n = tris;
  for (const e of stack) {
    if (!e.enabled) continue;
    const p = e.params as Record<string, number>;
    if (e.type === "mirror") n *= 2;
    else if (e.type === "array") n *= p.count;
    else if (e.type === "subdivide") n *= 4 ** p.levels;
    else if (e.type === "decimate") n = Math.max(1, Math.floor(n * p.ratio));
  }
  return n;
}

export function geometryToMesh(geometry: THREE.BufferGeometry): EditMesh {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const sourceIndices = index ? Array.from(index.array as ArrayLike<number>) : Array.from({ length: position.count }, (_, i) => i);
  const used = [...new Set(sourceIndices)];
  const slots = new Map(used.map((v, i) => [v, i]));
  const count = used.length;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const uv = geometry.getAttribute("uv"), normal = geometry.getAttribute("normal"), color = geometry.getAttribute("color");
  const colors = color ? new Float32Array(count * 4) : null;
  const uvs = uv ? new Float32Array(count * 2) : null;
  for (let i = 0; i < count; i++) {
    const v = used[i];
    positions.set([position.getX(v), position.getY(v), position.getZ(v)], i * 3);
    if (normal) normals.set([normal.getX(v), normal.getY(v), normal.getZ(v)], i * 3);
    if (uvs && uv) uvs.set([uv.getX(v), uv.getY(v)], i * 2);
    if (colors && color) colors.set([color.getX(v), color.getY(v), color.getZ(v), color.itemSize === 4 ? color.getW(v) : 1], i * 4);
  }
  const indices = Uint32Array.from(sourceIndices, (v) => slots.get(v)!);
  const mesh: EditMesh = { positions, normals, uvs, indices, colors };
  if (!normal) recomputeNormals(mesh, Array.from({ length: count }, (_, i) => i));
  return mesh;
}

function meshToGeometry(mesh: EditMesh, withNormals = true): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions.slice(), 3));
  if (withNormals) g.setAttribute("normal", new THREE.BufferAttribute(mesh.normals.slice(), 3));
  if (mesh.uvs) g.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs.slice(), 2));
  if (mesh.colors) g.setAttribute("color", new THREE.BufferAttribute(mesh.colors.slice(), 4));
  g.setIndex(new THREE.BufferAttribute(mesh.indices.slice(), 1));
  return g;
}

// --- the six modifiers -----------------------------------------------------------------------------------

function merge(parts: EditMesh[]): EditMesh {
  const verts = parts.reduce((n, m) => n + m.positions.length / 3, 0);
  const tris = parts.reduce((n, m) => n + m.indices.length, 0);
  const uv = parts.every((m) => m.uvs);
  const out: EditMesh = { positions: new Float32Array(verts * 3), normals: new Float32Array(verts * 3), uvs: uv ? new Float32Array(verts * 2) : null, indices: new Uint32Array(tris) };
  if (parts.some((m) => m.colors)) out.colors = new Float32Array(verts * 4).fill(1);
  let v = 0, i = 0;
  for (const m of parts) {
    if (out.colors && m.colors) out.colors.set(m.colors, v * 4);
    out.positions.set(m.positions, v * 3); out.normals.set(m.normals, v * 3); if (out.uvs && m.uvs) out.uvs.set(m.uvs, v * 2);
    for (let k = 0; k < m.indices.length; k++) out.indices[i + k] = m.indices[k] + v;
    v += m.positions.length / 3; i += m.indices.length;
  }
  return out;
}

function mirror(mesh: EditMesh, axis: "x" | "y" | "z", threshold: number): EditMesh {
  const k = { x: 0, y: 1, z: 2 }[axis];
  const copy: EditMesh = { positions: mesh.positions.slice(), normals: mesh.normals.slice(), uvs: mesh.uvs ? mesh.uvs.slice() : null, indices: mesh.indices.slice(), colors: mesh.colors?.slice() };
  for (let v = 0; v < copy.positions.length / 3; v++) { copy.positions[v * 3 + k] *= -1; copy.normals[v * 3 + k] *= -1; }
  for (let f = 0; f < copy.indices.length / 3; f++) { const t = copy.indices[f * 3 + 1]; copy.indices[f * 3 + 1] = copy.indices[f * 3 + 2]; copy.indices[f * 3 + 2] = t; } // winding flips with the reflection
  const out = merge([mesh, copy]);
  if (threshold > 0) for (let v = 0; v < out.positions.length / 3; v++) if (Math.abs(out.positions[v * 3 + k]) <= threshold) out.positions[v * 3 + k] = 0; // close the seam on the plane
  return out;
}

function array(mesh: EditMesh, count: number, offset: number[]): EditMesh {
  const parts: EditMesh[] = [];
  for (let c = 0; c < count; c++) {
    const copy: EditMesh = { positions: mesh.positions.slice(), normals: mesh.normals, uvs: mesh.uvs, indices: mesh.indices, colors: mesh.colors };
    for (let v = 0; v < copy.positions.length / 3; v++) for (let a = 0; a < 3; a++) copy.positions[v * 3 + a] += offset[a] * c;
    parts.push(copy);
  }
  return merge(parts);
}

/** Loop subdivision on the position-welded topology; UV seams and hard edges stay split. */
function subdivideOnce(mesh: EditMesh): EditMesh {
  const t = buildTopology(mesh);
  const p = mesh.positions;
  const wp = (w: number): number[] => { const v = t.members[w][0] * 3; return [p[v], p[v + 1], p[v + 2]]; };
  // Neighbours of each weld id, and whether it sits on a boundary (an edge with one face) or a non-manifold edge.
  const neighbours: Array<Set<number>> = t.members.map(() => new Set<number>());
  const boundary = new Array<boolean>(t.members.length).fill(false);
  t.edges.forEach(([a, b], e) => {
    neighbours[a].add(b); neighbours[b].add(a);
    if (t.edgeFaces[e].length !== 2) { boundary[a] = true; boundary[b] = true; }
  });
  const newWeldPos: number[][] = t.members.map((_, w) => {
    const v = wp(w), ns = [...neighbours[w]];
    if (boundary[w]) {
      const bs = ns.filter((n) => t.edgeFaces[t.edgeIndex.get(n < w ? `${n}_${w}` : `${w}_${n}`) as number].length === 1);
      if (bs.length !== 2) return v; // a non-manifold corner stays put
      const a = wp(bs[0]), b = wp(bs[1]);
      return v.map((x, i) => 0.75 * x + 0.125 * (a[i] + b[i]));
    }
    const n = ns.length, beta = n === 3 ? 3 / 16 : 3 / (8 * n);
    const sum = [0, 0, 0];
    for (const m of ns) { const q = wp(m); for (let i = 0; i < 3; i++) sum[i] += q[i]; }
    return v.map((x, i) => (1 - n * beta) * x + beta * sum[i]);
  });
  const edgePos = (a: number, b: number): number[] => {
    const wa = t.weld[a], wb = t.weld[b];
    const key = wa < wb ? `${wa}_${wb}` : `${wb}_${wa}`;
    const e = t.edgeIndex.get(key);
    const A = wp(wa), B = wp(wb);
    const faces = e === undefined ? [] : t.edgeFaces[e];
    if (faces.length === 2) {
      const opp = faces.map((f) => [0, 1, 2].map((k) => t.weld[mesh.indices[f * 3 + k]]).find((w) => w !== wa && w !== wb) as number);
      const C = wp(opp[0]), D = wp(opp[1]);
      return A.map((x, i) => 0.375 * (x + B[i]) + 0.125 * (C[i] + D[i]));
    }
    return A.map((x, i) => 0.5 * (x + B[i]));
  };
  const positions: number[] = [], normals: number[] = [], uvs: number[] | null = mesh.uvs ? [] : null;
  const colors: number[] | null = mesh.colors ? [] : null;
  const count = p.length / 3;
  for (let v = 0; v < count; v++) {
    positions.push(...newWeldPos[t.weld[v]]); normals.push(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
    if (uvs && mesh.uvs) uvs.push(mesh.uvs[v * 2], mesh.uvs[v * 2 + 1]);
    if (colors && mesh.colors) colors.push(...mesh.colors.subarray(v * 4, v * 4 + 4));
  }
  const mid = new Map<string, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let m = mid.get(key);
    if (m === undefined) {
      m = positions.length / 3; mid.set(key, m);
      if (colors && mesh.colors) for (let k = 0; k < 4; k++) colors.push((mesh.colors[a * 4 + k] + mesh.colors[b * 4 + k]) / 2);
      positions.push(...edgePos(a, b));
      normals.push((mesh.normals[a * 3] + mesh.normals[b * 3]) / 2, (mesh.normals[a * 3 + 1] + mesh.normals[b * 3 + 1]) / 2, (mesh.normals[a * 3 + 2] + mesh.normals[b * 3 + 2]) / 2);
      if (uvs && mesh.uvs) uvs.push((mesh.uvs[a * 2] + mesh.uvs[b * 2]) / 2, (mesh.uvs[a * 2 + 1] + mesh.uvs[b * 2 + 1]) / 2);
    }
    return m;
  };
  const indices: number[] = [];
  for (let f = 0; f < mesh.indices.length / 3; f++) {
    const a = mesh.indices[f * 3], b = mesh.indices[f * 3 + 1], c = mesh.indices[f * 3 + 2];
    const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
    indices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const out: EditMesh = { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: uvs ? Float32Array.from(uvs) : null, indices: Uint32Array.from(indices), colors: colors ? Float32Array.from(colors) : null };
  recomputeNormals(out, Array.from({ length: out.positions.length / 3 }, (_, i) => i));
  return out;
}

function smooth(mesh: EditMesh, iterations: number, factor: number): EditMesh {
  const out: EditMesh = { ...mesh, positions: mesh.positions.slice(), normals: mesh.normals.slice() };
  const t = buildTopology(out);
  const neighbours: Array<Set<number>> = t.members.map(() => new Set<number>());
  const pinned = new Array<boolean>(t.members.length).fill(false);
  t.edges.forEach(([a, b], e) => { neighbours[a].add(b); neighbours[b].add(a); if (t.edgeFaces[e].length !== 2) { pinned[a] = true; pinned[b] = true; } }); // boundaries stay put
  for (let it = 0; it < iterations; it++) {
    const next = t.members.map((m) => [out.positions[m[0] * 3], out.positions[m[0] * 3 + 1], out.positions[m[0] * 3 + 2]]);
    t.members.forEach((m, w) => {
      if (pinned[w] || neighbours[w].size === 0) return;
      const avg = [0, 0, 0];
      for (const n of neighbours[w]) { const v = t.members[n][0] * 3; for (let i = 0; i < 3; i++) avg[i] += out.positions[v + i] / neighbours[w].size; }
      for (let i = 0; i < 3; i++) next[w][i] += factor * (avg[i] - next[w][i]);
    });
    t.members.forEach((m, w) => { for (const v of m) out.positions.set(next[w], v * 3); });
  }
  recomputeNormals(out, Array.from({ length: out.positions.length / 3 }, (_, i) => i));
  return out;
}

function decimate(mesh: EditMesh, ratio: number): EditMesh {
  // The pinned SimplifyModifier interpolates RGB and UVs but its Color type has no alpha.
  if (mesh.colors && mesh.colors.some((v, i) => i % 4 === 3 && v !== 1)) throw new ModifierError("MODIFIER_INVALID", COPY.modifierAlphaUnsupported);
  const input = meshToGeometry(mesh);
  // Feed RGB to the addon: mergeVertices must not compare a discarded alpha component.
  if (mesh.colors) input.setAttribute("color", new THREE.BufferAttribute(Float32Array.from({ length: mesh.colors.length / 4 * 3 }, (_, i) => mesh.colors![Math.floor(i / 3) * 4 + i % 3]), 3));
  let simplified: THREE.BufferGeometry | undefined;
  try {
    const remove = Math.floor(input.getAttribute("position").count * (1 - ratio));
    if (remove < 1) return mesh;
    simplified = new SimplifyModifier().modify(input, remove);
    const out = geometryToMesh(simplified);
    recomputeNormals(out, Array.from({ length: out.positions.length / 3 }, (_, i) => i));
    return out;
  } finally { input.dispose(); simplified?.dispose(); }
}

function edgeSplit(mesh: EditMesh, angleDegrees: number): EditMesh {
  const indexed = meshToGeometry(mesh);
  // The addon assumes every indexed vertex is referenced. Its non-indexed path
  // compacts attributes with mergeVertices, preserving colour/UV/normal seams.
  const input = indexed.toNonIndexed(); indexed.dispose();
  let split: THREE.BufferGeometry | undefined;
  try {
    split = new EdgeSplitModifier().modify(input, THREE.MathUtils.degToRad(angleDegrees), false);
    const out = geometryToMesh(split);
    recomputeNormals(out, Array.from({ length: out.positions.length / 3 }, (_, i) => i));
    return out;
  } finally { input.dispose(); split?.dispose(); }
}

/** Apply the enabled modifiers, in order, to `base`. Predicts the size first; each step must finish in 1 s. */
export function applyStack(base: EditMesh, stack: readonly ModifierEntry[], now: () => number = () => performance.now()): EditMesh {
  const problem = validateStack(stack);
  if (problem) throw new ModifierError("MODIFIER_INVALID", problem);
  const predicted = predictTriangles(triangleCount(base), stack);
  if (predicted > MAX_MODIFIER_TRIANGLES) throw new ModifierError("MODIFIER_TOO_LARGE", `This stack would make about ${predicted.toLocaleString()} triangles, over the ${MAX_MODIFIER_TRIANGLES.toLocaleString()} limit.`);
  let mesh = base;
  for (const e of stack) {
    if (!e.enabled) continue;
    const p = e.params as Record<string, never>;
    if ((e.type === "decimate" || e.type === "edgeSplit") && triangleCount(mesh) > MAX_DECIMATE_TRIANGLES) throw new ModifierError("MODIFIER_TOO_LARGE", `${MODIFIER_LABELS[e.type]} works on at most ${MAX_DECIMATE_TRIANGLES.toLocaleString()} triangles.`);
    const started = now();
    if (e.type === "mirror") mesh = mirror(mesh, p.axis, p.threshold);
    else if (e.type === "array") mesh = array(mesh, p.count, p.offset);
    else if (e.type === "subdivide") for (let l = 0; l < (p.levels as number); l++) mesh = subdivideOnce(mesh);
    else if (e.type === "smooth") mesh = smooth(mesh, p.iterations, p.factor);
    else if (e.type === "decimate") mesh = decimate(mesh, p.ratio);
    else mesh = edgeSplit(mesh, p.angle);
    if (now() - started > MODIFIER_STEP_MS) throw new ModifierError("MODIFIER_TOO_SLOW", `${MODIFIER_LABELS[e.type]} took more than a second. Use a lighter setting or a smaller mesh.`);
    if (triangleCount(mesh) > MAX_MODIFIER_TRIANGLES) throw new ModifierError("MODIFIER_TOO_LARGE", "The result is over the triangle limit.");
  }
  return mesh;
}
