import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { loadAssetMesh, meshFromAsset, modifierBaseSelection } from "../../src/scene/baseMesh";
import type { RestFn } from "../../src/api";
import type { AssetSpec, NodeSpec, SceneSpec } from "../../src/types";

const asset = { sha256: "a".repeat(64) } as AssetSpec;
const restFor = (file: string): RestFn => async <T>() => {
  const bytes = readFileSync(new URL(`../fixtures/${file}`, import.meta.url));
  return Uint8Array.from(bytes).buffer as T;
};
afterEach(() => vi.restoreAllMocks());

it("loads the exact selected primitive and releases privately loaded geometry on success and refusal", async () => {
  const disposed = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
  const rest = restFor("two-primitive.glb");
  const first = await meshFromAsset(rest, asset, 0, 0);
  const second = await meshFromAsset(rest, asset, 0, 1);
  expect(Array.from(first.positions)).not.toEqual(Array.from(second.positions));
  const count = disposed.mock.calls.length;
  expect(count).toBeGreaterThanOrEqual(4);
  await expect(meshFromAsset(rest, asset, 0, 2)).rejects.toThrow(/primitive is missing/);
  await expect(meshFromAsset(rest, asset, -1, 0)).rejects.toThrow(/primitive is missing/);
  expect(disposed.mock.calls.length).toBeGreaterThan(count);
  expect(first.positions.every(Number.isFinite)).toBe(true); // copying survives disposal
});

it("accepts an unspecified legacy base only when the GLB has exactly one primitive", async () => {
  await expect(meshFromAsset(restFor("two-primitive.glb"), asset, undefined, undefined)).rejects.toThrow(/no saved selection/);
  const loaded = await loadAssetMesh(restFor("mesh-import-stl.glb"), asset, undefined, undefined);
  expect([loaded.meshIndex, loaded.primitiveIndex]).toEqual([0, 0]);
  expect(loaded.mesh.positions.length).toBeGreaterThan(0);
});

it("uses persisted nonzero selection and recovers only unambiguous original history", () => {
  const node = { id: "n", kind: "part", meshIndex: 0, primitiveIndex: 0, generator: { type: "modifiers", params: { baseAssetId: "base" } } } as unknown as NodeSpec;
  const old = { id: "n", kind: "part", modelAssetId: "base", meshIndex: 2, primitiveIndex: 3 };
  const scene = { history: { undo: [{ undo: { nodes: [old] } }], redo: [] } } as unknown as SceneSpec;
  expect(modifierBaseSelection(node, scene)).toEqual([2, 3]);
  expect(modifierBaseSelection({ ...node, generator: { type: "modifiers", version: 1, params: { baseAssetId: "base", baseMeshIndex: 4, basePrimitiveIndex: 5 } } }, scene)).toEqual([4, 5]);
  expect(modifierBaseSelection(node, { ...scene, history: undefined })).toEqual([undefined, undefined]);
  scene.history!.redo.push({ label: "old", at: "", redo: { nodes: [{ ...old, primitiveIndex: 1 }] } });
  expect(() => modifierBaseSelection(node, scene)).toThrow(/conflicting/);
});
