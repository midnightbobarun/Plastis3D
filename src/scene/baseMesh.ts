import { COPY } from "../copy";
// src/scene/baseMesh.ts — the un-modified geometry a modifier stack starts from (PR25).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { getAssetBytes } from "../api";
import type { RestFn } from "../api";
import type { AssetSpec, NodeSpec, PrimitiveSpec, SceneSpec } from "../types";
import { buildPrimitiveGeometry } from "./build";
import { geometryToMesh } from "./modifiers";
import type { ModifierGeneratorParams } from "./modifiers";
import type { EditMesh } from "./meshEdit";

/** A built-in shape's mesh, in the node's own space. */
export function meshFromPrimitive(primitive: PrimitiveSpec): EditMesh {
  const geometry = buildPrimitiveGeometry(primitive);
  const mesh = geometryToMesh(geometry);
  geometry.dispose();
  return mesh;
}

/** One primitive of a stored model file, in the part's own space (the part's transform stays on the node). */
export async function meshFromAsset(rest: RestFn, asset: AssetSpec, meshIndex: number | undefined, primitiveIndex: number | undefined): Promise<EditMesh> {
  return (await loadAssetMesh(rest, asset, meshIndex, primitiveIndex)).mesh;
}

/** Return the proven source pair as well, so legacy recovery survives history rollover. */
export async function loadAssetMesh(rest: RestFn, asset: AssetSpec, meshIndex: number | undefined, primitiveIndex: number | undefined): Promise<{ mesh: EditMesh; meshIndex: number; primitiveIndex: number }> {
  const bytes = await getAssetBytes(rest, asset.sha256);
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  let group: THREE.Object3D | undefined;
  try {
    const definitions = gltf.parser.json.meshes ?? [];
    if (meshIndex === undefined || primitiveIndex === undefined) {
      const choices: Array<[number, number]> = [];
      definitions.forEach((definition: { primitives: unknown[] }, mi: number) => definition.primitives.forEach((_: unknown, pi: number) => choices.push([mi, pi])));
      if (choices.length !== 1) throw new Error(COPY.modifierAmbiguousBase);
      [meshIndex, primitiveIndex] = choices[0];
    }
    if (!Number.isInteger(meshIndex) || meshIndex < 0 || !Number.isInteger(primitiveIndex) || primitiveIndex < 0 || !definitions[meshIndex]?.primitives?.[primitiveIndex]) throw new Error(COPY.modifierMissingPrimitive);
    group = (await gltf.parser.getDependency("mesh", meshIndex)) as THREE.Object3D;
    const primitives: THREE.Mesh[] = [];
    group.traverse((child) => { if ((child as THREE.Mesh).isMesh) primitives.push(child as THREE.Mesh); });
    const found = primitives[primitiveIndex];
    if (!found) throw new Error(COPY.modifierMissingPrimitive);
    return { mesh: geometryToMesh(found.geometry), meshIndex, primitiveIndex };
  } finally {
    // This loader is private to this operation; copy attributes before releasing its resources.
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    for (const root of [...gltf.scenes, ...(group ? [group] : [])]) root.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) geometries.add(mesh.geometry);
      for (const material of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose());
    textures.forEach((t) => { t.dispose(); if (typeof ImageBitmap !== "undefined" && t.image instanceof ImageBitmap) t.image.close(); });
  }
}

/** Recover old selection only when stored metadata/history gives exactly one answer.
 * Undefined asks the loader to accept only a truly single-primitive asset. */
export function modifierBaseSelection(node: NodeSpec, scene: SceneSpec): [number, number] | [undefined, undefined] {
  if (node.generator?.type !== "modifiers") return [node.meshIndex ?? 0, node.primitiveIndex ?? 0];
  const params = node.generator.params as ModifierGeneratorParams;
  if (params.baseMeshIndex !== undefined && params.basePrimitiveIndex !== undefined) return [params.baseMeshIndex, params.basePrimitiveIndex];
  const choices = new Map<string, [number, number]>();
  const visit = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || depth > 12) return;
    const row = value as Record<string, unknown>;
    if (row.id === node.id && row.modelAssetId === params.baseAssetId && row.kind === "part") {
      const pair: [number, number] = [Number(row.meshIndex ?? 0), Number(row.primitiveIndex ?? 0)];
      choices.set(pair.join(":"), pair);
    }
    Object.values(row).forEach((child) => visit(child, depth + 1));
  };
  visit(scene.history);
  if (choices.size > 1) throw new Error(COPY.modifierConflictingBase);
  return [...choices.values()][0] ?? [undefined, undefined];
}
