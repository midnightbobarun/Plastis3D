import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
// src/scene/build.ts — pure scene-graph builder (Stage 4, PR4 §4.1).
//
// Converts spec JSON (src/types.ts, mirroring plastis3d_scene/spec.py)
// into a Three.js Object3D hierarchy. Synchronous; primitives, lights,
// cameras, and groups only — model/part nodes become empty groups plus
// a modelSlots entry the caller resolves with a parsed template
// (see cache.ts / resolveModelSlot below).
//
// This module MUST NOT import @hermes/plugin-sdk (the T2 Vitest suite
// must run without the SDK stub). Static imports here are only `three`,
// relative paths, and type-only imports.
//
// Finiteness guard (decision, documented for the PR4 report): the store
// validates specs upstream (validate.py rejects non-finite /
// non-positive dimensions and segment counts outside 3..64), but the
// view must never let a bad number poison a matrix — a single NaN in a
// position or scale makes the whole subtree disappear with no error.
// So every numeric input is sanitised HERE, by replacement with the
// spec default, never by throwing:
//   - transform components: non-finite t/r -> 0, non-finite s -> 1.
//   - primitive dimensions: non-finite or <= 0 -> the PRIMITIVE_DEFAULTS
//     value for that parameter.
//   - primitive segment counts: non-integer or outside 3..64 -> default.
//   - material numbers (roughness/metalness/opacity): non-finite ->
//     defaults (0.6 / 0 / 1). Invalid color strings -> the default color.
//   - light/camera numbers: non-finite -> defaults; near/far also fall
//     back when <= 0 or far <= near.
// A scale of exactly 0 is finite and is kept as written (degenerate but
// not NaN); the validator owns whether 0 is legal.

import * as THREE from "three";
import type {
  AssetSpec,
  LightSpec,
  MaterialSpec,
  NodeSpec,
  PrimitiveSpec,
  SceneSpec,
} from "../types";
import type { ParsedTemplate } from "./cache";

/** Key marking geometries/materials this build created (and therefore
 * owns). Cloned template geometry is never marked, so disposeBuiltScene
 * can never free a shared template resource. */
const OWNED_KEY = "plastis3dOwned";

/** Triangles above which the view shows stats + bounds instead of
 * parsing (stage-4 §2/§6.1). Provisional — PR1 did not replace the
 * invented 100,000 number with a measured one; see cache.ts. */
export const DRAW_CAP_TRIS = 100_000;

// --- Finiteness guards -------------------------------------------------------

/** `value` when it is a finite number, otherwise `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `value` when it is a finite number > 0, otherwise `fallback`. */
function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

/** `value` when it is an integer in [min, max], otherwise `fallback`. */
function intInRangeOr(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : fallback;
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** A `#rrggbb` string, or `fallback` when the value is not one. */
function hexOr(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_RE.test(value) ? value : fallback;
}

const DEG_TO_RAD = Math.PI / 180;

// --- Primitive defaults (mirror PRIMITIVE_DEFAULTS, primitives.py) ----------

export const PRIMITIVE_DEFAULTS: Record<string, Record<string, number>> = {
  box: { width: 1, height: 1, depth: 1 },
  sphere: { radius: 0.5, widthSegments: 16, heightSegments: 12 },
  cylinder: { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 16 },
  cone: { radius: 0.5, height: 1, radialSegments: 16 },
  torus: { radius: 0.5, tube: 0.15, radialSegments: 12, tubularSegments: 24 },
  plane: { width: 1, height: 1 },
  capsule: { radius: 0.25, length: 1, capSegments: 4, radialSegments: 8 },
};

const DIMENSION_PARAMS: Record<string, string[]> = {
  box: ["width", "height", "depth"],
  sphere: ["radius"],
  cylinder: ["radiusTop", "radiusBottom", "height"],
  cone: ["radius", "height"],
  torus: ["radius", "tube"],
  plane: ["width", "height"],
  capsule: ["radius", "length"],
};

const SEGMENT_PARAMS: Record<string, string[]> = {
  sphere: ["widthSegments", "heightSegments"],
  cylinder: ["radialSegments"],
  cone: ["radialSegments"],
  torus: ["radialSegments", "tubularSegments"],
  capsule: ["capSegments", "radialSegments"],
};

/**
 * Merge a primitive's params over the spec defaults, sanitising every
 * value (see the finiteness-guard note above). Unknown primitive types
 * fall back to a unit box rather than throwing.
 */
export function resolvePrimitiveParams(
  primitive: PrimitiveSpec,
): { type: string; params: Record<string, number> } {
  const defaults = PRIMITIVE_DEFAULTS[primitive.type];
  if (!defaults) return { type: "box", params: { ...PRIMITIVE_DEFAULTS.box } };
  const params: Record<string, number> = { ...defaults };
  const raw = primitive as unknown as Record<string, unknown>;
  for (const key of DIMENSION_PARAMS[primitive.type] ?? []) {
    params[key] = positiveOr(raw[key], defaults[key]);
  }
  for (const key of SEGMENT_PARAMS[primitive.type] ?? []) {
    params[key] = intInRangeOr(raw[key], 3, 64, defaults[key]);
  }
  return { type: primitive.type, params };
}

/** Build the Three.js geometry for one primitive spec (owned by the caller). */
export function buildPrimitiveGeometry(primitive: PrimitiveSpec): THREE.BufferGeometry {
  const { type, params: p } = resolvePrimitiveParams(primitive);
  let geometry: THREE.BufferGeometry;
  switch (type) {
    case "box":
      geometry = new THREE.BoxGeometry(p.width, p.height, p.depth);
      break;
    case "sphere":
      geometry = new THREE.SphereGeometry(p.radius, p.widthSegments, p.heightSegments);
      break;
    case "cylinder":
      geometry = new THREE.CylinderGeometry(
        p.radiusTop,
        p.radiusBottom,
        p.height,
        p.radialSegments,
      );
      break;
    case "cone":
      geometry = new THREE.ConeGeometry(p.radius, p.height, p.radialSegments);
      break;
    case "torus":
      geometry = new THREE.TorusGeometry(
        p.radius,
        p.tube,
        p.radialSegments,
        p.tubularSegments,
      );
      break;
    case "plane":
      geometry = new THREE.PlaneGeometry(p.width, p.height);
      break;
    case "capsule":
      geometry = new THREE.CapsuleGeometry(
        p.radius,
        p.length,
        p.capSegments,
        p.radialSegments,
      );
      break;
    default:
      geometry = new THREE.BoxGeometry(1, 1, 1);
      break;
  }
  geometry.userData[OWNED_KEY] = true;
  return geometry;
}

// --- Materials ---------------------------------------------------------------

const DEFAULT_MATERIAL_COLOR = "#c8ccd0";

/** Build a MeshStandardMaterial for one material spec (owned by the caller). */
export function buildMaterial(material: MaterialSpec): THREE.MeshStandardMaterial {
  const opacity = finiteOr(material.opacity, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: hexOr(material.color, DEFAULT_MATERIAL_COLOR),
    roughness: finiteOr(material.roughness, 0.6),
    metalness: finiteOr(material.metalness, 0),
    emissive: hexOr(material.emissive, "#000000"),
    opacity,
    transparent: opacity < 1,
    side: material.doubleSide === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.userData[OWNED_KEY] = true;
  return mat;
}

// --- Lights ------------------------------------------------------------------

/**
 * Create the Three.js light for a light spec. Directional and spot
 * lights parent their `target` at local (0, 0, -1) as a child of the
 * light node, so the stored Euler rotation aims the beam (PR4 §4.1:
 * the target must NOT be re-aimed with lookAt — the rotation comes
 * from the stored Euler, applied to the light node itself by the
 * caller). Point lights have no target.
 */
export function buildLight(light: LightSpec): THREE.Light {
  const color = hexOr(light.color, "#ffffff");
  const intensity = finiteOr(light.intensity, 1);
  switch (light.type) {
    case "point": {
      const point = new THREE.PointLight(
        color,
        intensity,
        positiveOr(light.distance, 0) || 0,
        finiteOr(light.decay, 2),
      );
      // distance 0 means infinite range in three.js; positiveOr(..., 0)
      // keeps a caller-supplied 0 as 0 and an absent/invalid value as 0.
      return point;
    }
    case "spot": {
      const spot = new THREE.SpotLight(
        color,
        intensity,
        positiveOr(light.distance, 0) || 0,
        // No spec default for angle (Light.angle is None in spec.py);
        // 60 degrees is three.js's own SpotLight default (Math.PI / 3).
        finiteOr(light.angle, 60) * DEG_TO_RAD,
        finiteOr(light.penumbra, 0),
      );
      spot.target.position.set(0, 0, -1);
      spot.add(spot.target);
      return spot;
    }
    case "directional":
    default: {
      const dir = new THREE.DirectionalLight(color, intensity);
      dir.target.position.set(0, 0, -1);
      dir.add(dir.target);
      return dir;
    }
  }
}

// --- Cameras -----------------------------------------------------------------

export function buildCamera(camera: {
  fov?: number;
  near?: number;
  far?: number;
}): THREE.PerspectiveCamera {
  const near = positiveOr(camera.near, 0.01);
  let far = positiveOr(camera.far, 500);
  if (far <= near) far = near + 1;
  return new THREE.PerspectiveCamera(finiteOr(camera.fov, 40), 1, near, far);
}

// --- Scene graph -------------------------------------------------------------

export interface ModelSlot {
  /** The spec node the clone(s) are parented under. */
  node: THREE.Object3D;
  asset: AssetSpec;
  /** Part nodes only: glTF mesh index within the asset. */
  meshIndex?: number;
  /** Part nodes only: primitive index within that glTF mesh. */
  primitiveIndex?: number;
  /**
   * Part nodes with a material override: the view material (shared per
   * material id within a build, owned by the build) the clone is drawn with
   * instead of the imported one.
   */
  material?: THREE.MeshStandardMaterial;
}

export interface BuiltScene {
  root: THREE.Group;
  /** Every spec node id -> its Object3D (one Object3D per spec node). */
  nodes: Map<string, THREE.Object3D>;
  /** Model/part nodes awaiting a parsed template (see resolveModelSlot). */
  modelSlots: ModelSlot[];
  /** The view material for each material id a node uses (PR15 binds textures to these). */
  materials: Map<string, THREE.MeshStandardMaterial>;
}

function applyTransform(obj: THREE.Object3D, node: NodeSpec): void {
  const t = node.transform ?? { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
  const tv = t.t ?? [0, 0, 0];
  const rv = t.r ?? [0, 0, 0];
  const sv = t.s ?? [1, 1, 1];
  obj.position.set(
    finiteOr(tv[0], 0),
    finiteOr(tv[1], 0),
    finiteOr(tv[2], 0),
  );
  obj.rotation.set(
    finiteOr(rv[0], 0) * DEG_TO_RAD,
    finiteOr(rv[1], 0) * DEG_TO_RAD,
    finiteOr(rv[2], 0) * DEG_TO_RAD,
    "XYZ",
  );
  obj.scale.set(
    finiteOr(sv[0], 1),
    finiteOr(sv[1], 1),
    finiteOr(sv[2], 1),
  );
  obj.visible = node.visible !== false;
}

/**
 * Build a Three.js hierarchy from a scene spec. Synchronous;
 * primitives/lights/cameras/groups only. One Object3D per spec node,
 * parented by spec.parent (unknown or absent parents fall back to the
 * root). Local TRS stays on the node. Model/part nodes are empty groups
 * plus a modelSlots entry — the caller clones a parsed template into
 * them with resolveModelSlot; no asset bytes are loaded here.
 */
export function buildSceneGraph(
  scene: SceneSpec,
  materialsById: Map<string, MaterialSpec>,
): BuiltScene {
  const root = new THREE.Group();
  root.name = scene.id;
  root.userData.sceneId = scene.id;

  const assetsById = new Map<string, AssetSpec>();
  for (const asset of scene.assets ?? []) assetsById.set(asset.id, asset);

  // One shared MeshStandardMaterial per material id within this build;
  // a missing/unknown materialId falls back to the default material.
  const materialCache = new Map<string, THREE.MeshStandardMaterial>();
  const defaultMaterial = buildMaterial({
    id: "m_default",
    color: DEFAULT_MATERIAL_COLOR,
    emissive: "#000000",
    metalness: 0,
    roughness: 0.6,
    opacity: 1,
    doubleSide: false,
  });
  const materialFor = (materialId: string | undefined): THREE.MeshStandardMaterial => {
    if (!materialId) return defaultMaterial;
    let mat = materialCache.get(materialId);
    if (!mat) {
      const spec = materialsById.get(materialId);
      mat = spec ? buildMaterial(spec) : defaultMaterial;
      materialCache.set(materialId, mat);
    }
    return mat;
  };

  const nodes = new Map<string, THREE.Object3D>();
  const modelSlots: ModelSlot[] = [];
  const created: THREE.Object3D[] = [];

  for (const node of scene.nodes ?? []) {
    let obj: THREE.Object3D;
    switch (node.kind) {
      case "mesh":
        obj = new THREE.Mesh(
          node.primitive
            ? buildPrimitiveGeometry(node.primitive)
            : buildPrimitiveGeometry({ type: "box" }),
          materialFor(node.materialId),
        );
        break;
      case "light":
        obj = node.light ? buildLight(node.light) : new THREE.DirectionalLight();
        break;
      case "camera":
        obj = node.camera ? buildCamera(node.camera) : buildCamera({});
        break;
      case "model":
      case "part": {
        obj = new THREE.Group();
        const asset = node.modelAssetId
          ? assetsById.get(node.modelAssetId)
          : undefined;
        if (asset) {
          const slot: ModelSlot = { node: obj, asset };
          if (node.kind === "part") {
            slot.meshIndex = node.meshIndex;
            slot.primitiveIndex = node.primitiveIndex;
            if (node.materialId && materialsById.has(node.materialId)) {
              slot.material = materialFor(node.materialId);
            }
          }
          modelSlots.push(slot);
        }
        break;
      }
      case "group":
      default:
        // Unknown kinds degrade to an empty group rather than throwing.
        obj = new THREE.Group();
        break;
    }
    obj.name = node.name;
    obj.userData.nodeId = node.id;
    obj.userData.kind = node.kind;
    applyTransform(obj, node);
    nodes.set(node.id, obj);
    created.push(obj);
  }

  // Second pass: parent by spec.parent. A node's parent must exist in
  // the map and must not be the node itself; anything else parents to
  // the root (a dangling parent link must not drop the node).
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  for (const obj of created) {
    const spec = byId.get(obj.userData.nodeId as string);
    const parentId = spec?.parent;
    const parentObj =
      parentId && parentId !== obj.userData.nodeId ? nodes.get(parentId) : undefined;
    (parentObj ?? root).add(obj);
  }

  return { root, nodes, modelSlots, materials: materialCache };
}

/**
 * Clone a parsed template into a model slot. For a `model` node, clones
 * the complete template scene under the slot node; for a `part` node, clones
 * the specific mesh primitive (mesh index, then primitive index within
 * the mesh — matched against the template's primitiveMap when the
 * template was built by GLTFLoader, falling back to traversal-order
 * index when no map entry exists). The template itself is never
 * parented, so one template can serve many scenes/surfaces. Clones
 * share the template's geometries/materials;
 * disposeBuiltScene never disposes them. Returns the cloned objects.
 */
export function resolveModelSlot(
  slot: ModelSlot,
  template: ParsedTemplate,
): THREE.Object3D[] {
  const clones: THREE.Object3D[] = [];
  if (slot.meshIndex !== undefined) {
    const primitiveIndex = slot.primitiveIndex ?? 0;
    let mesh: THREE.Mesh | undefined;
    if (template.primitiveMap) {
      const idx = template.primitiveMap.findIndex(
        (entry) =>
          entry.meshIndex === slot.meshIndex &&
          entry.primitiveIndex === primitiveIndex,
      );
      if (idx >= 0) mesh = template.meshes[idx];
    }
    if (!mesh) mesh = template.meshes[slot.meshIndex];
    if (mesh) {
      const clone = mesh.clone(true);
      // A part's material override is drawn instead of the imported
      // material (the template's own is shared and never touched).
      if (slot.material) clone.material = slot.material;
      slot.node.add(clone);
      clones.push(clone);
    }
    return clones;
  }
  // Clone the whole hierarchy so skeleton references can be rebound even when
  // bones and meshes live under different roots. Keep the scene root itself:
  // its transform and animation bindings are part of the imported asset.
  const clone = cloneSkeleton(template.scene);
  clone.traverse((obj) => {
    if ((obj as THREE.SkinnedMesh).isSkinnedMesh) obj.userData.p3dOwnedSkeleton = true;
  });
  slot.node.add(clone);
  clones.push(clone);
  return clones;
}

/**
 * Reparent `child` under `newParent`, preserving its world transform
 * (THREE.Object3D.attach). Used by the editor's reparent flow and by
 * the T2 reparenting-math test.
 */
export function reparentPreservingWorld(
  child: THREE.Object3D,
  newParent: THREE.Object3D,
): void {
  newParent.attach(child);
}

/**
 * Set wireframe on the materials THIS build created (primitive
 * materials, marked at creation). Shared template materials reached
 * through model-slot clones are never touched — the template outlives
 * any one built scene and the wireframe toggle is a view pref, not
 * scene data.
 */
export function setBuiltWireframe(built: BuiltScene, value: boolean): void {
  const materials = new Set<THREE.Material>();
  built.root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const mat = (mesh as THREE.Mesh).material;
    if (mat) {
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        if (m.userData[OWNED_KEY]) materials.add(m);
      }
    }
  });
  for (const material of materials) {
    (material as THREE.MeshStandardMaterial).wireframe = value;
  }
}

/**
 * Dispose the geometries/materials THIS build created (primitive
 * geometries and MeshStandardMaterials, marked at creation). Shared
 * template geometry/material reached through model-slot clones is
 * never disposed — the template outlives any one built scene and the
 * last surface disposes it via ParsedTemplate.dispose().
 */
export function disposeBuiltScene(built: BuiltScene): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const skeletons = new Set<THREE.Skeleton>();
  built.root.traverse((obj) => {
    const skinned = obj as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.userData.p3dOwnedSkeleton) skeletons.add(skinned.skeleton);
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry && mesh.geometry.userData[OWNED_KEY]) {
      geometries.add(mesh.geometry as THREE.BufferGeometry);
    }
    const mat = (mesh as THREE.Mesh).material;
    if (mat) {
      const list = Array.isArray(mat) ? mat : [mat];
      for (const m of list) {
        if (m.userData[OWNED_KEY]) materials.add(m);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const skeleton of skeletons) skeleton.dispose();
}
