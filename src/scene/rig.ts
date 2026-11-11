// src/scene/rig.ts — the rig settings the Rig section edits (PR30), and their conversion to what the gateway stores.
//
// The gateway (plastis3d_scene/rig.py) owns the weights, the skinned GLB and the validation; here the settings are
// kept in degrees (what a person types) and converted to the unit quaternions the gateway stores. No DOM, no SDK.
import * as THREE from "three";
import type { Vec3 } from "../types";

export const MAX_BONES = 64;
export const MAX_CLIPS = 16;
export const MAX_KEYS = 512;

export interface Bone { id: string; name: string; parent: string | null; head: Vec3; tail: Vec3 }
/** A key as edited: Euler XYZ degrees. */
export interface DraftKey { t: number; boneId: string; rotation: Vec3 }
export interface DraftClip { name: string; keys: DraftKey[] }
export interface RigDraft { bones: Bone[]; clips: DraftClip[] }
/** What the gateway stores: quaternions [x, y, z, w]. */
export interface StoredKey { t: number; boneId: string; rotation: [number, number, number, number] }
export interface RigParams { bones: Bone[]; weights: "envelope"; clips: Array<{ name: string; keys: StoredKey[] }> }

export class RigError extends Error {}

export function eulerToQuat(degrees: Vec3): [number, number, number, number] {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(degrees[0]), THREE.MathUtils.degToRad(degrees[1]), THREE.MathUtils.degToRad(degrees[2]), "XYZ"));
  return [q.x, q.y, q.z, q.w];
}

export function quatToEuler(q: readonly number[]): Vec3 {
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize(), "XYZ");
  const round = (v: number) => Math.round(THREE.MathUtils.radToDeg(v) * 1e3) / 1e3;
  return [round(e.x), round(e.y), round(e.z)];
}

/** Two bones up the middle of `bounds` (lower half, upper half): a starting point to move around. */
export function defaultDraft(bounds: { min: Vec3; max: Vec3 } | null): RigDraft {
  const min = bounds?.min ?? [-0.5, 0, -0.5];
  const max = bounds?.max ?? [0.5, 1, 0.5];
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2, mid = (min[1] + max[1]) / 2;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return {
    bones: [
      { id: "bone1", name: "Lower", parent: null, head: [r(cx), r(min[1]), r(cz)], tail: [r(cx), r(mid), r(cz)] },
      { id: "bone2", name: "Upper", parent: "bone1", head: [r(cx), r(mid), r(cz)], tail: [r(cx), r(max[1]), r(cz)] },
    ],
    clips: [{ name: "Bend", keys: [{ t: 0, boneId: "bone2", rotation: [0, 0, 0] }, { t: 1, boneId: "bone2", rotation: [0, 0, 45] }] }],
  };
}

export function draftFromParams(params: Partial<RigParams>): RigDraft {
  return {
    bones: structuredClone(params.bones ?? []),
    clips: (params.clips ?? []).map((clip) => ({ name: clip.name, keys: clip.keys.map((k) => ({ t: k.t, boneId: k.boneId, rotation: quatToEuler(k.rotation) })) })),
  };
}

/** The first problem with a draft (mirrors the gateway's rules so Apply can say why), or null. */
export function validateDraft(draft: RigDraft): string | null {
  if (draft.bones.length < 1 || draft.bones.length > MAX_BONES) return `A rig takes 1 to ${MAX_BONES} bones.`;
  const ids = new Set<string>();
  for (const b of draft.bones) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(b.id) || ids.has(b.id)) return "Bone ids must be unique.";
    ids.add(b.id);
    if (Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]) < 1e-6) return `${b.name} needs a length (head and tail differ).`;
  }
  const byId = new Map(draft.bones.map((b) => [b.id, b]));
  for (const b of draft.bones) {
    if (b.parent !== null && !byId.has(b.parent)) return `${b.name} has a parent that is not a bone.`;
    const seen = new Set([b.id]);
    for (let p = b.parent; p !== null; p = byId.get(p)?.parent ?? null) {
      if (seen.has(p)) return "Bone parents form a loop.";
      seen.add(p);
    }
  }
  if (draft.clips.length > MAX_CLIPS) return `A rig takes at most ${MAX_CLIPS} clips.`;
  for (const clip of draft.clips) {
    if (clip.keys.length < 1 || clip.keys.length > MAX_KEYS) return `Clip ${clip.name} needs 1 to ${MAX_KEYS} keys.`;
    const last = new Map<string, number>();
    for (const k of clip.keys) {
      if (!ids.has(k.boneId)) return `Clip ${clip.name} has a key for a bone that was removed.`;
      if (!(k.t >= 0)) return `Clip ${clip.name} has a key before time 0.`;
      if (last.has(k.boneId) && k.t <= (last.get(k.boneId) as number)) return `Clip ${clip.name}: key times must increase for each bone.`;
      last.set(k.boneId, k.t);
    }
  }
  return null;
}

/** Keys are sent in time order, per bone (the gateway needs each bone's times strictly increasing). */
export function toParams(draft: RigDraft): RigParams {
  return {
    bones: draft.bones.map((b) => ({ ...b, head: [...b.head] as Vec3, tail: [...b.tail] as Vec3 })),
    weights: "envelope",
    clips: draft.clips.map((c) => ({ name: c.name, keys: [...c.keys].sort((a, b) => a.t - b.t).map((k) => ({ t: k.t, boneId: k.boneId, rotation: eulerToQuat(k.rotation) })) })),
  };
}

/** The pose matrices of every bone at `time` in a clip (local rotations slerped between keys), world-space bind
 *  relative: used by the pose preview and the tests. Returns each bone's world rotation. */
export function poseRotations(bones: Bone[], clip: DraftClip | undefined, time: number): Map<string, THREE.Quaternion> {
  const local = new Map<string, THREE.Quaternion>();
  for (const b of bones) {
    const keys = (clip?.keys ?? []).filter((k) => k.boneId === b.id).sort((x, y) => x.t - y.t);
    let q = new THREE.Quaternion();
    if (keys.length) {
      const quat = (k: DraftKey) => new THREE.Quaternion(...eulerToQuat(k.rotation));
      if (time <= keys[0].t) q = quat(keys[0]);
      else if (time >= keys[keys.length - 1].t) q = quat(keys[keys.length - 1]);
      else {
        const i = keys.findIndex((k) => k.t > time);
        const a = keys[i - 1], b2 = keys[i];
        q = quat(a).slerp(quat(b2), (time - a.t) / (b2.t - a.t));
      }
    }
    local.set(b.id, q);
  }
  const byId = new Map(bones.map((b) => [b.id, b]));
  const world = new Map<string, THREE.Quaternion>();
  const resolve = (id: string): THREE.Quaternion => {
    const cached = world.get(id);
    if (cached) return cached;
    const parent = byId.get(id)?.parent;
    const q = parent ? resolve(parent).clone().multiply(local.get(id) as THREE.Quaternion) : (local.get(id) as THREE.Quaternion).clone();
    world.set(id, q);
    return q;
  };
  for (const b of bones) resolve(b.id);
  return world;
}
