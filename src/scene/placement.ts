// src/scene/placement.ts — where and how a new object is created
// (UI/UX redesign §5.7, PR32). Pure (three.js math only, no DOM, no
// SDK), so it is unit-tested in Node. AddMenu.tsx sends what this builds.

import * as THREE from "three";
import { primitiveLocalBounds } from "./primitiveStats";
import type { MaterialSpec, PrimitiveSpec } from "../types";

/** The schema-default material (spec.py default_material). */
export const DEFAULT_MATERIAL: MaterialSpec = {
  id: "m_default",
  color: "#c8ccd0",
  emissive: "#000000",
  metalness: 0,
  roughness: 0.6,
  opacity: 1,
  doubleSide: false,
};

/** Spec-default primitive params (mirror build.ts PRIMITIVE_DEFAULTS). */
const PRIMITIVE_DEFAULTS: Record<string, Record<string, number>> = {
  box: { width: 1, height: 1, depth: 1 },
  sphere: { radius: 0.5, widthSegments: 32, heightSegments: 24 },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 32 },
  cone: { radius: 0.5, height: 1, radialSegments: 32 },
  torus: { radius: 0.5, tube: 0.15, radialSegments: 16, tubularSegments: 48 },
  plane: { width: 2, height: 2 },
  capsule: { radius: 0.25, length: 1, capSegments: 8, radialSegments: 24 },
};

export type AddKind =
  | "box"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus"
  | "plane"
  | "capsule"
  | "group"
  | "directional"
  | "point"
  | "spot"
  | "camera";

/** A unique name: the label, then "Label 2" on collision, and so on. */
export function uniqueNodeName(label: string, taken: Set<string>): string {
  if (!taken.has(label)) return label;
  let n = 2;
  while (taken.has(`${label} ${n}`)) n += 1;
  return `${label} ${n}`;
}

const DEG = 180 / Math.PI;

/** Euler XYZ degrees that point a light/camera's -Z from `from` at `to`. */
export function aimRotation(from: THREE.Vector3, to: THREE.Vector3): [number, number, number] {
  const cam = new THREE.PerspectiveCamera();
  cam.position.copy(from);
  cam.lookAt(to);
  const e = new THREE.Euler().setFromQuaternion(cam.quaternion, "XYZ");
  return [round3(e.x * DEG), round3(e.y * DEG), round3(e.z * DEG)];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export interface Placement {
  /** The orbit target (where the user is looking). */
  target: [number, number, number];
  /** The orbit camera position (camera from view). */
  eye: [number, number, number];
  /** Footprints added this session: [x, z, halfWidth]. */
  occupied: Array<[number, number, number]>;
}

/** The bottom-on-floor translation for a primitive at (x, z). */
export function floorY(primitive: PrimitiveSpec, rotation: [number, number, number]): number {
  const local = primitiveLocalBounds(primitive);
  if (!local) return 0;
  const euler = new THREE.Euler(rotation[0] / DEG, rotation[1] / DEG, rotation[2] / DEG, "XYZ");
  const m = new THREE.Matrix4().makeRotationFromEuler(euler);
  let minY = Infinity;
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        minY = Math.min(minY, new THREE.Vector3(x, y, z).applyMatrix4(m).y);
      }
    }
  }
  return round3(Number.isFinite(minY) ? -minY : 0);
}

/** Build the node object for an Add item (no id — the server mints it). */
export function buildAddNode(
  kind: AddKind,
  name: string,
  placement?: Placement,
  materialId = "m_default",
): Record<string, unknown> {
  const target = placement?.target ?? [0, 0, 0];
  const snap = (v: number) => Math.round(v * 2) / 2;
  const base = {
    name,
    transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
    parent: null,
    visible: true,
  };
  const tgt = new THREE.Vector3(snap(target[0]), 0, snap(target[2]));
  switch (kind) {
    case "group":
      return { ...base, kind: "group", transform: { ...base.transform, t: [tgt.x, 0, tgt.z] } };
    case "directional":
    case "spot": {
      const pos = tgt.clone().add(new THREE.Vector3(2.5, 4, 3));
      const light =
        kind === "directional"
          ? { type: "directional", color: "#ffffff", intensity: 3 }
          : { type: "spot", color: "#ffffff", intensity: 40, distance: 0, angle: 30, penumbra: 0.35 };
      return {
        ...base,
        kind: "light",
        transform: { t: [round3(pos.x), round3(pos.y), round3(pos.z)], r: aimRotation(pos, tgt), s: [1, 1, 1] },
        light,
      };
    }
    case "point":
      return {
        ...base,
        kind: "light",
        transform: { t: [tgt.x, 2.5, tgt.z], r: [0, 0, 0], s: [1, 1, 1] },
        light: { type: "point", color: "#ffffff", intensity: 15, distance: 0 },
      };
    case "camera": {
      const eye = new THREE.Vector3(...(placement?.eye ?? [4, 3, 6]));
      const look = new THREE.Vector3(...target);
      return {
        ...base,
        kind: "camera",
        transform: { t: [round3(eye.x), round3(eye.y), round3(eye.z)], r: aimRotation(eye, look), s: [1, 1, 1] },
        camera: { type: "perspective", fov: 40, near: 0.01, far: 500 },
      };
    }
    default: {
      const primitive = { type: kind, ...PRIMITIVE_DEFAULTS[kind] } as unknown as PrimitiveSpec;
      const r: [number, number, number] = kind === "plane" ? [-90, 0, 0] : [0, 0, 0];
      const local = primitiveLocalBounds(primitive);
      const half = local ? Math.max(local.max[0] - local.min[0], local.max[2] - local.min[2]) / 2 : 0.5;
      let x = tgt.x;
      const z = tgt.z;
      // Don't land inside something added this session: step along +X.
      if (kind !== "plane") {
        for (let i = 0; i < 24; i += 1) {
          const hit = placement?.occupied.find(
            ([ox, oz, oh]) => Math.abs(ox - x) < oh + half && Math.abs(oz - z) < oh + half,
          );
          if (!hit) break;
          x = round3(hit[0] + hit[2] + half + 0.25);
        }
      }
      return {
        ...base,
        transform: { t: [x, floorY(primitive, r), z], r, s: [1, 1, 1] },
        kind: "mesh",
        primitive,
        materialId,
      };
    }
  }
}

