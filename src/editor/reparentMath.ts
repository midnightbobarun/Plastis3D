import * as THREE from "three";
import type { SceneSpec, Transform, Vec3 } from "../types";

/** Compute a representable local TRS, or null if the new parent induces shear. */
export function reparentTransform(scene: SceneSpec, id: string, parent: string | null): Transform | null {
  const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
  function world(nodeId: string | null, visited = new Set<string>()): THREE.Matrix4 | null {
    if (nodeId === null) return new THREE.Matrix4();
    if (visited.has(nodeId)) return null;
    visited.add(nodeId);
    const node = nodes.get(nodeId);
    if (!node) return null;
    const base = world(node.parent, visited);
    if (!base) return null;
    const t = node.transform ?? { t: [0, 0, 0] as Vec3, r: [0, 0, 0] as Vec3, s: [1, 1, 1] as Vec3 };
    const rotation = new THREE.Euler(...t.r.map(THREE.MathUtils.degToRad) as Vec3, "XYZ");
    return base.multiply(new THREE.Matrix4().compose(new THREE.Vector3(...t.t), new THREE.Quaternion().setFromEuler(rotation), new THREE.Vector3(...t.s)));
  }
  const oldWorld = world(id);
  const parentWorld = world(parent);
  if (!oldWorld || !parentWorld || Math.abs(parentWorld.determinant()) < 1e-12 || Math.abs(oldWorld.determinant()) < 1e-12) return null;
  const local = parentWorld.clone().invert().multiply(oldWorld);
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  local.decompose(position, quaternion, scale);
  const recomposed = new THREE.Matrix4().compose(position, quaternion, scale);
  if (!local.elements.every((v, i) => Number.isFinite(v) && Math.abs(v - recomposed.elements[i]) <= 1e-6 * Math.max(1, Math.abs(v)))) return null;
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return { t: position.toArray() as Vec3, r: [euler.x, euler.y, euler.z].map(THREE.MathUtils.radToDeg) as Vec3, s: scale.toArray() as Vec3 };
}
