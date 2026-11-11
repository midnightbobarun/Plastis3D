import * as THREE from "three";
import type { Clip } from "../types";
import { COPY } from "../copy";

export function validPrimitiveClips(clips: unknown): clips is Clip[] {
  if (!Array.isArray(clips)) return false;
  return clips.every((clip) => {
    if (!clip || typeof clip !== "object" || !Array.isArray(clip.channels) || clip.channels.length === 0) return false;
    if (Object.keys(clip).some((key) => !["id", "name", "duration", "channels"].includes(key))) return false;
    if (clip.id !== undefined && (typeof clip.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(clip.id))) return false;
    if (clip.name !== undefined && (typeof clip.name !== "string" || clip.name.length < 1 || clip.name.length > 64)) return false;
    if (clip.duration !== undefined && (!Number.isFinite(clip.duration) || clip.duration <= 0)) return false;
    const seen = new Set<string>();
    return clip.channels.every((channel: unknown) => {
      if (!channel || typeof channel !== "object") return false;
      if (Object.keys(channel).some((key) => !["target", "times", "values"].includes(key))) return false;
      const c = channel as { target?: unknown; times?: unknown; values?: unknown };
      if (typeof c.target !== "string" || !["translation", "rotation", "scale"].includes(c.target) || seen.has(c.target)) return false;
      seen.add(c.target);
      if (!Array.isArray(c.times) || c.times.length === 0 || !Array.isArray(c.values) || c.values.length !== c.times.length) return false;
      const times = c.times as unknown[];
      const values = c.values as unknown[];
      if (!times.every((t: unknown, i: number) => typeof t === "number" && Number.isFinite(t) && t >= 0 && (i === 0 || t > (times[i - 1] as number)) && (clip.duration === undefined || t <= clip.duration))) return false;
      if (!values.every((v: unknown) => Array.isArray(v) && v.length === 3 && v.every((n: unknown) => typeof n === "number" && Number.isFinite(n)))) return false;
      if (c.target === "rotation" && (values as number[][]).some((v, i, list) => {
        if (i === 0) return false;
        const previous = list[i - 1];
        if (v.some((n, axis) => Math.abs(n - previous[axis]) >= 180)) return true;
        const q = (angles: number[]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(...angles.map(THREE.MathUtils.degToRad) as [number, number, number], "XYZ"));
        return Math.abs(q(previous).dot(q(v))) <= 5e-7;
      })) return false;
      return true;
    });
  });
}

/** Convert the schema's XYZ-degree rotations into glTF-compatible slerp tracks. */
export function primitiveClips(clips: Clip[]): THREE.AnimationClip[] {
  return clips.map((clip, index) => {
    const tracks = clip.channels.map((channel) => {
      const values = channel.values.flat();
      if (channel.target === "rotation") {
        const quaternions = channel.values.flatMap(([x, y, z]) => {
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(x), THREE.MathUtils.degToRad(y), THREE.MathUtils.degToRad(z), "XYZ",
          ));
          return [q.x, q.y, q.z, q.w];
        });
        return new THREE.QuaternionKeyframeTrack(".quaternion", channel.times, quaternions);
      }
      return new THREE.VectorKeyframeTrack(channel.target === "translation" ? ".position" : ".scale", channel.times, values);
    });
    const last = Math.max(...clip.channels.map((channel) => channel.times.at(-1) ?? 0));
    return new THREE.AnimationClip(clip.name || `${COPY.clip} ${index + 1}`, clip.duration ?? last, tracks);
  });
}

/** Capture the displayed pose at the transport time without touching scene data. */
export function capturePrimitiveKey(clips: Clip[], index: number, root: THREE.Object3D, time: number): Clip[] {
  const result = structuredClone(clips);
  const clip = result[index];
  if (!clip) return result;
  const t = Math.max(0, Math.round(time * 10000) / 10000);
  const position = root.position.toArray() as [number, number, number];
  const scale = root.scale.toArray() as [number, number, number];
  const rotation: [number, number, number] = [root.rotation.x, root.rotation.y, root.rotation.z].map(THREE.MathUtils.radToDeg) as [number, number, number];
  for (const channel of clip.channels) {
    const value = channel.target === "translation" ? position : channel.target === "rotation" ? rotation : scale;
    const at = channel.times.findIndex((key) => key >= t);
    if (at >= 0 && channel.times[at] === t) channel.values[at] = [...value];
    else {
      const position = at < 0 ? channel.times.length : at;
      channel.times.splice(position, 0, t);
      channel.values.splice(position, 0, [...value]);
    }
  }
  if (clip.duration !== undefined) clip.duration = Math.max(clip.duration, t);
  return result;
}
