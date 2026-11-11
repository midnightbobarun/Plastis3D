// src/scene/physics.ts — "Settle" (PR27, D-EXT-05): drop the selected nodes under gravity until they rest.
//
// cannon-es (pure JS, no .wasm) runs a small world: gravity -9.81 m/s^2 and a static floor at y = 0. The
// SELECTED nodes (at most 32) are dynamic; every other visible mesh, part or model node is a static box (a sphere
// primitive is a sphere), from its local bounds x its world scale, rotated by its world quaternion. No convex hulls.
// Steps are 1/120 s, at most 1,200 (10 s), stopping when every body sleeps, 60 steps per slice with a yield between.
// The result is a LOCAL transform per node (the world pose converted through the parent's inverse), so it can be
// previewed on the built objects and kept with one PATCH. A pose a parent's scale cannot hold is refused (C-04).
import * as CANNON from "cannon-es";
import * as THREE from "three";
import { primitiveLocalBounds } from "./primitiveStats";
import type { AssetSpec, Clip, NodeSpec, PrimitiveSpec, SceneSpec, Vec3 } from "../types";

export const MAX_SELECTED = 32;
export const STEP = 1 / 120;
export const MAX_STEPS = 1200;
export const STEPS_PER_SLICE = 60;
/** A frame is sampled for "record the fall" every this many steps (0.025 s). */
export const SAMPLE_EVERY = 3;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export type PhysicsErrorCode = "PHYSICS_TOO_MANY" | "PHYSICS_NOTHING" | "PHYSICS_NO_REST" | "PHYSICS_POSE";
export class PhysicsError extends Error {
  readonly code: PhysicsErrorCode;
  constructor(code: PhysicsErrorCode, message: string) { super(message); this.name = "PhysicsError"; this.code = code; }
}

export interface LocalPose { t: [number, number, number]; r: [number, number, number]; s: [number, number, number] }
export interface Frame { time: number; poses: Map<string, LocalPose> }
export interface SettleResult {
  /** The final local pose of every settled node. */
  poses: Map<string, LocalPose>;
  /** The original local poses (to restore on Cancel). */
  original: Map<string, LocalPose>;
  /** Sampled frames from time 0 (the start pose) to the end, for recording the fall. */
  frames: Frame[];
  steps: number;
  /** Every body went to sleep before the step limit. */
  rested: boolean;
}

function localMatrix(node: NodeSpec): THREE.Matrix4 {
  const t = node.transform ?? { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((t.r[0] ?? 0) * RAD, (t.r[1] ?? 0) * RAD, (t.r[2] ?? 0) * RAD, "XYZ"));
  return new THREE.Matrix4().compose(new THREE.Vector3(...(t.t as [number, number, number])), q, new THREE.Vector3(...(t.s as [number, number, number])));
}

/** World matrix of every node, from the spec (no scene graph needed). Cycles and missing parents fall back to the root. */
export function worldMatrices(nodes: readonly NodeSpec[]): Map<string, THREE.Matrix4> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, THREE.Matrix4>();
  const resolve = (id: string, seen: Set<string>): THREE.Matrix4 => {
    const cached = out.get(id);
    if (cached) return cached;
    const node = byId.get(id) as NodeSpec;
    const parent = node.parent && byId.has(node.parent) && !seen.has(node.parent) ? resolve(node.parent, new Set([...seen, id])) : new THREE.Matrix4();
    const m = parent.clone().multiply(localMatrix(node));
    out.set(id, m);
    return m;
  };
  for (const n of nodes) resolve(n.id, new Set());
  return out;
}

interface Bounds { min: [number, number, number]; max: [number, number, number] }

/** Local bounds of a node that can be a body, or null. */
export function boundsOf(node: NodeSpec, assets: ReadonlyMap<string, AssetSpec>): Bounds | null {
  if (node.kind === "mesh" && node.primitive) return primitiveLocalBounds(node.primitive as PrimitiveSpec);
  if (node.kind === "part" || node.kind === "model") {
    const asset = assets.get(node.modelAssetId ?? "");
    const stats = asset?.stats as { bounds?: Bounds; parts?: Array<{ meshIndex: number; primitiveIndex: number; bounds?: Bounds }> } | undefined;
    if (node.kind === "part") {
      const part = stats?.parts?.find((p) => p.meshIndex === node.meshIndex && p.primitiveIndex === node.primitiveIndex);
      if (part?.bounds) return part.bounds;
    }
    return stats?.bounds ?? null;
  }
  return null;
}

interface Item { node: NodeSpec; body: CANNON.Body; centre: THREE.Vector3; scale: THREE.Vector3; dynamic: boolean }

function descendantsOf(nodes: readonly NodeSpec[], rootId: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => { for (const n of nodes) if (n.parent === id && !out.has(n.id)) { out.add(n.id); walk(n.id); } };
  walk(rootId);
  return out;
}

export interface SettleOptions {
  yieldNow?: () => Promise<void>;
  /** Called after each slice with the current local poses (the live preview). */
  onFrame?: (poses: Map<string, LocalPose>, time: number) => void;
  maxSteps?: number;
}

/** Simulate. Throws PHYSICS_TOO_MANY (over 32), PHYSICS_NOTHING (no selected node can fall) or PHYSICS_POSE. */
export async function settle(scene: SceneSpec, selectedIds: readonly string[], options: SettleOptions = {}): Promise<SettleResult> {
  const yieldNow = options.yieldNow ?? (async () => {});
  if (selectedIds.length > MAX_SELECTED) throw new PhysicsError("PHYSICS_TOO_MANY", `Settle works on up to ${MAX_SELECTED} nodes at a time.`);
  const assets = new Map(scene.assets.map((a) => [a.id, a]));
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const worlds = worldMatrices(scene.nodes);
  // A selected node inside another selected node moves with it: only the topmost ones fall.
  const selected = new Set(selectedIds.filter((id) => byId.has(id)));
  for (const id of [...selected]) for (const d of descendantsOf(scene.nodes, id)) selected.delete(d);
  const fallers = scene.nodes.filter((n) => selected.has(n.id) && boundsOf(n, assets) !== null && n.visible !== false);
  if (fallers.length === 0) throw new PhysicsError("PHYSICS_NOTHING", "Select a shape, part or model to settle.");

  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.81, 0) });
  world.allowSleep = true;
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.05;
  const floor = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
  floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(floor);

  const items: Item[] = [];
  const hidden = new Set<string>();
  for (const n of scene.nodes) { if (n.visible === false) for (const d of [n.id, ...descendantsOf(scene.nodes, n.id)]) hidden.add(d); }
  const skipStatic = new Set<string>();
  for (const id of selected) for (const d of descendantsOf(scene.nodes, id)) skipStatic.add(d);
  for (const n of scene.nodes) {
    const bounds = boundsOf(n, assets);
    const dynamic = selected.has(n.id);
    if (!bounds || hidden.has(n.id) || (!dynamic && (skipStatic.has(n.id) || selected.has(n.id)))) continue;
    if (!dynamic && n.id in {}) continue;
    const m = worlds.get(n.id) as THREE.Matrix4;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    m.decompose(pos, quat, scl);
    const centreLocal = new THREE.Vector3((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2);
    const half = new THREE.Vector3((bounds.max[0] - bounds.min[0]) / 2 * Math.abs(scl.x), (bounds.max[1] - bounds.min[1]) / 2 * Math.abs(scl.y), (bounds.max[2] - bounds.min[2]) / 2 * Math.abs(scl.z));
    const centre = pos.clone().add(centreLocal.clone().multiply(scl).applyQuaternion(quat));
    const isSphere = n.kind === "mesh" && (n.primitive as PrimitiveSpec | undefined)?.type === "sphere";
    const shape = isSphere ? new CANNON.Sphere(Math.max(half.x, half.y, half.z)) : new CANNON.Box(new CANNON.Vec3(Math.max(half.x, 1e-4), Math.max(half.y, 1e-4), Math.max(half.z, 1e-4)));
    const body = new CANNON.Body({ mass: dynamic ? 1 : 0, shape, position: new CANNON.Vec3(centre.x, centre.y, centre.z), quaternion: new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w) });
    if (dynamic) { body.allowSleep = true; body.sleepSpeedLimit = 0.1; body.sleepTimeLimit = 0.5; body.linearDamping = 0.01; body.angularDamping = 0.05; }
    world.addBody(body);
    items.push({ node: n, body, centre: centreLocal.multiply(scl), scale: scl, dynamic });
  }
  const dynamics = items.filter((i) => i.dynamic);

  const original = new Map<string, LocalPose>(dynamics.map((i) => [i.node.id, poseOf(i.node)]));
  const poseNow = (): Map<string, LocalPose> => {
    const out = new Map<string, LocalPose>();
    for (const it of dynamics) out.set(it.node.id, localPose(it, byId, worlds));
    return out;
  };
  const frames: Frame[] = [{ time: 0, poses: new Map(original) }];
  const limit = options.maxSteps ?? MAX_STEPS;
  let steps = 0;
  const asleep = () => dynamics.every((i) => i.body.sleepState === CANNON.Body.SLEEPING);
  while (steps < limit && !asleep()) {
    for (let k = 0; k < STEPS_PER_SLICE && steps < limit; k++) {
      world.step(STEP);
      steps++;
      if (steps % SAMPLE_EVERY === 0) frames.push({ time: steps * STEP, poses: poseNow() });
      if (asleep()) break;
    }
    options.onFrame?.(poseNow(), steps * STEP);
    await yieldNow();
  }
  const poses = poseNow(); // refuses a pose the parents' scale cannot hold
  if (frames[frames.length - 1].time < steps * STEP - 1e-9) frames.push({ time: steps * STEP, poses });
  return { poses, original, frames, steps, rested: asleep() };
}

function poseOf(node: NodeSpec): LocalPose {
  const t = node.transform;
  return { t: [...t.t] as [number, number, number], r: [...t.r] as [number, number, number], s: [...t.s] as [number, number, number] };
}

/** The node's local transform for the body's current world pose (the parent's inverse applied), or PHYSICS_POSE. */
function localPose(item: Item, byId: Map<string, NodeSpec>, worlds: Map<string, THREE.Matrix4>): LocalPose {
  const b = item.body;
  const q = new THREE.Quaternion(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
  const origin = new THREE.Vector3(b.position.x, b.position.y, b.position.z).sub(item.centre.clone().applyQuaternion(q));
  const world = new THREE.Matrix4().compose(origin, q, item.scale);
  const parent = item.node.parent && byId.has(item.node.parent) ? (worlds.get(item.node.parent) as THREE.Matrix4) : new THREE.Matrix4();
  const local = parent.clone().invert().multiply(world);
  const pos = new THREE.Vector3(), rot = new THREE.Quaternion(), scl = new THREE.Vector3();
  local.decompose(pos, rot, scl);
  const want = item.node.transform.s;
  if (Math.abs(scl.x - want[0]) > 1e-3 * Math.max(1, Math.abs(want[0])) || Math.abs(scl.y - want[1]) > 1e-3 * Math.max(1, Math.abs(want[1])) || Math.abs(scl.z - want[2]) > 1e-3 * Math.max(1, Math.abs(want[2]))) {
    throw new PhysicsError("PHYSICS_POSE", `The parent's scale cannot hold the settled pose of ${item.node.name}. Move it out of the scaled group, or reset the group's scale.`);
  }
  const euler = new THREE.Euler().setFromQuaternion(rot, "XYZ");
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  return { t: [round(pos.x), round(pos.y), round(pos.z)], r: [round(euler.x * DEG), round(euler.y * DEG), round(euler.z * DEG)], s: [...want] as [number, number, number] };
}

/** A translation and rotation clip per node from the sampled frames (record the fall, PR21's clip format).
 *  Euler angles are unwrapped so no key jumps by half a turn; a resting tail is trimmed to one key. */
export function fallClips(result: SettleResult): Map<string, Clip> {
  const out = new Map<string, Clip>();
  for (const id of result.original.keys()) {
    const times: number[] = [], t: Vec3[] = [], r: Vec3[] = [];
    let last = -1;
    for (const f of result.frames) {
      const pose = f.poses.get(id) as LocalPose;
      const time = Math.round(f.time * 1e4) / 1e4;
      if (time <= last) continue;
      const prev = r[r.length - 1];
      const rot = pose.r.map((v, k) => {
        if (!prev) return v;
        let x = v;
        while (x - prev[k] > 180) x -= 360;
        while (x - prev[k] < -180) x += 360;
        return x;
      }) as Vec3;
      const still = prev !== undefined && rot.every((v, k) => Math.abs(v - prev[k]) < 1e-3) && pose.t.every((v, k) => Math.abs(v - t[t.length - 1][k]) < 1e-5);
      if (still && times.length >= 2 && f !== result.frames[result.frames.length - 1]) continue;
      times.push(time); t.push([...pose.t] as Vec3); r.push(rot); last = time;
    }
    if (times.length < 2) continue;
    out.set(id, { name: "Fall", duration: times[times.length - 1], channels: [{ target: "translation", times, values: t }, { target: "rotation", times: [...times], values: r }] });
  }
  return out;
}
