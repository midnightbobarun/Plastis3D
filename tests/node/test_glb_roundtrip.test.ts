// tests/node/test_glb_roundtrip.test.ts — Tier 3 loader acceptance +
// fixture parity (PR6, Stage 3 §5 T3).
//
// Loads the checked-in tests/fixtures/primitive-mesh.glb (the real
// Python writer's output) AND tests/fixtures/two-primitive.glb (the
// hand-built two-primitive fixture) with GLTFLoader in Node
// (three 0.180.0, loader.parseAsync on an ArrayBuffer — never load(),
// no fetch in Node for local files; the Node Buffer is sliced to its
// exact ArrayBuffer first) and asserts the parse succeeds with 0
// errors, the mesh counts, hierarchy, and node transforms survive the
// round trip.
//
// This is loader acceptance + fixture parity, not a full glTF 2.0
// conformance claim: it does not validate the glTF JSON against the
// spec, check accessor bounds, or exercise extensions beyond
// KHR_lights_punctual (which primitive-mesh.glb declares and the
// loader accepts).
//
// Name caveat, measured on three 0.180.0 (see also
// primitive-mesh.test.mjs): GLTFLoader sanitizes node names through
// PropertyBinding.sanitizeNodeName, so "Moved group" arrives as
// "Moved_group" and "Main camera" as "Main_camera". A multi-primitive
// glTF mesh node additionally arrives as a Group named after the mesh
// with one child Mesh per primitive, named `<mesh>_<1-based index>`
// ("mesh0" -> Group with Meshes "mesh0_1", "mesh0_2"); a
// single-primitive mesh stays one Mesh with the mesh name. Tests below
// assert on those loader-visible names and shapes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // A real copy: Buffer.slice() shares the Node pool, so .buffer on a
  // slice would hand GLTFLoader the whole pool (wrong offset/length).
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function loadGlb(name: string): Promise<GLTF> {
  const loader = new GLTFLoader();
  return loader.parseAsync(toArrayBuffer(readFileSync(fixturePath(name))), "");
}

function meshesOf(gltf: GLTF): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  gltf.scene.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
  });
  return meshes;
}

function expectVecClose(
  actual: number[],
  expected: number[],
  tolerance = 1e-5,
): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(
      Math.abs(actual[i] - expected[i]),
      `component ${i}: got ${actual[i]}, want ${expected[i]}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

describe("GLB round trip (primitive-mesh.glb)", () => {
  it("parses with 0 errors, 9 meshes, 1 camera, 11 scene roots", async () => {
    const gltf = await loadGlb("primitive-mesh.glb");
    expect(gltf.scene.children).toHaveLength(11);
    expect(meshesOf(gltf)).toHaveLength(9);
    expect(gltf.cameras).toHaveLength(1);
    expect(gltf.scene.children.map((c) => c.name)).toEqual([
      "Key_light",
      "Main_camera",
      "Box",
      "Sphere",
      "Cylinder",
      "Cone",
      "Torus",
      "Plane",
      "Capsule",
      "Floor",
      "Moved_group",
    ]);
  });

  it("preserves node transforms through the round trip", async () => {
    const gltf = await loadGlb("primitive-mesh.glb");
    const byName = new Map(gltf.scene.children.map((c) => [c.name, c]));
    // Unmoved primitives: identity TRS.
    for (const name of ["Box", "Sphere", "Cylinder", "Cone", "Torus", "Plane", "Capsule"]) {
      const obj = byName.get(name) as THREE.Object3D;
      expectVecClose(obj.position.toArray(), [0, 0, 0]);
      expectVecClose(obj.scale.toArray(), [1, 1, 1]);
      expect(obj.quaternion.equals(new THREE.Quaternion())).toBe(true);
    }
    // Floor: r = [-90, 0, 0] -> quaternion (-√½, 0, 0, √½).
    const floor = byName.get("Floor") as THREE.Object3D;
    expectVecClose(
      floor.quaternion.toArray(),
      [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    );
    // Moved group + grouped box keep their local translations.
    const group = byName.get("Moved_group") as THREE.Object3D;
    expectVecClose(group.position.toArray(), [2, 0, 0]);
    const groupedBox = group.children.find(
      (c) => c.name === "Grouped_box",
    ) as THREE.Object3D;
    expect(groupedBox).toBeDefined();
    expectVecClose(groupedBox.position.toArray(), [0, 1, 0]);
    // Main camera and key light keep their rig translations.
    expectVecClose(
      (byName.get("Main_camera") as THREE.Object3D).position.toArray(),
      [4, 3, 6],
    );
    expectVecClose(
      (byName.get("Key_light") as THREE.Object3D).position.toArray(),
      [4, 6, 3],
    );
  });

  it("the grouped box's world transform follows its parent group", async () => {
    const gltf = await loadGlb("primitive-mesh.glb");
    gltf.scene.updateMatrixWorld(true);
    const groupedBox = gltf.scene.getObjectByName(
      "Grouped_box",
    ) as THREE.Object3D;
    const world = new THREE.Vector3();
    groupedBox.getWorldPosition(world);
    expectVecClose(world.toArray(), [2, 1, 0]);
  });
});

describe("GLB round trip (two-primitive.glb)", () => {
  it("parses with 0 errors: 2 meshes, 3 primitives, 2 scene roots", async () => {
    const gltf = await loadGlb("two-primitive.glb");
    expect(gltf.scene.children).toHaveLength(2);
    const meshes = meshesOf(gltf);
    expect(meshes).toHaveLength(3);
    // mesh0 carries two primitives, so the loader makes it a Group
    // with two child Meshes ("mesh0_1", "mesh0_2"); mesh1 stays one
    // Mesh. Traversal order is mesh0-prim0, mesh0-prim1, mesh1-prim0.
    const mesh0Node = gltf.scene.children[0];
    expect(mesh0Node.name).toBe("mesh0");
    expect((mesh0Node as THREE.Group).isGroup).toBe(true);
    expect(mesh0Node.children.map((c) => c.name)).toEqual([
      "mesh0_1",
      "mesh0_2",
    ]);
    expect(gltf.scene.children[1].name).toBe("mesh1");
    expect(meshes.map((m) => m.name)).toEqual(["mesh0_1", "mesh0_2", "mesh1"]);
  });

  it("preserves the per-primitive bounds and identity transforms", async () => {
    const gltf = await loadGlb("two-primitive.glb");
    const expected = JSON.parse(
      readFileSync(fixturePath("two-primitive.expected.json"), "utf-8"),
    ) as {
      parts: Array<{
        meshIndex: number;
        primitiveIndex: number;
        bounds: { min: number[]; max: number[] };
      }>;
    };
    const meshes = meshesOf(gltf);
    expect(meshes).toHaveLength(expected.parts.length);
    for (let i = 0; i < expected.parts.length; i += 1) {
      const mesh = meshes[i];
      // No TRS stored in the fixture: identity transform.
      expectVecClose(mesh.position.toArray(), [0, 0, 0]);
      expectVecClose(mesh.scale.toArray(), [1, 1, 1]);
      expect(mesh.quaternion.equals(new THREE.Quaternion())).toBe(true);
      // 36 non-indexed vertices per box.
      expect(mesh.geometry.attributes.position.count).toBe(36);
      mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox as THREE.Box3;
      expectVecClose(box.min.toArray(), expected.parts[i].bounds.min, 1e-6);
      expectVecClose(box.max.toArray(), expected.parts[i].bounds.max, 1e-6);
    }
  });
});
