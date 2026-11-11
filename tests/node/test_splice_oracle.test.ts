// tests/node/test_splice_oracle.test.ts — Tier 3 loader acceptance +
// fixture parity (PR8, Stage 3 §5 T3).
//
// Loads the checked-in tests/fixtures/spliced-export.glb (the real
// Python writer's spliced output, built by
// tests/fixtures/make_spliced_export_glb.py) with GLTFLoader in Node
// (three 0.180.0, loader.parseAsync on an ArrayBuffer — never load(),
// no fetch in Node for local files; the Node Buffer is copied to an
// exact ArrayBuffer first) and asserts the parse succeeds with 0
// errors, the hierarchy (moved group → box; model node → imported
// roots + spec child), and one moved part's world transform.
//
// This is loader acceptance + fixture parity, not a full glTF 2.0
// conformance claim: it does not validate the glTF JSON against the
// spec, check accessor bounds, or exercise extensions beyond
// KHR_lights_punctual (which this file declares via the spec's key
// light and the loader accepts).
//
// Name caveat, measured on three 0.180.0 (see also
// test_glb_roundtrip.test.ts): GLTFLoader sanitizes node names
// through PropertyBinding.sanitizeNodeName, so "Moved group" arrives
// as "Moved_group" and "Ship box" as "Ship_box". A multi-primitive
// glTF mesh node additionally arrives as a Group named after the mesh
// with one child Mesh per primitive; the spliced part meshes here are
// single-primitive, so each stays one Mesh with the mesh name — but
// two meshes share the name "hullMesh" (the exploded part and the
// Ship instance's copy), so GLTFLoader uniquifies the second one and
// name lookup must take the first in traversal order, which is the
// exploded (moved) part: the scene roots are ordered light, camera,
// Oracle wrapper, Ship, moved group, so the Oracle subtree is
// traversed before Ship. The same uniquification applies to the
// Ship instance's Hull/Wing/SrcCam nodes ("Hull_1", "Wing_1",
// "SrcCam_1") because the Oracle subtree already owns those names.
// Tests below assert on those loader-visible names and shapes.

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

function expected(): {
  movedPartWorld: number[];
  groupedBoxWorld: number[];
  shipChildren: string[];
  shipTranslation: number[];
  cameraYfovs: number[];
} {
  return JSON.parse(
    readFileSync(fixturePath("spliced-export.expected.json"), "utf-8"),
  ) as {
    movedPartWorld: number[];
    groupedBoxWorld: number[];
    shipChildren: string[];
    shipTranslation: number[];
    cameraYfovs: number[];
  };
}

describe("spliced GLB oracle (spliced-export.glb)", () => {
  it("parses with 0 errors: spliced camera first, cam_main second", async () => {
    const gltf = await loadGlb("spliced-export.glb");
    expect(gltf.cameras).toHaveLength(2);
    // The splice-copied camera precedes the spec cameras.
    const [spliced, main] = gltf.cameras as THREE.PerspectiveCamera[];
    expect(spliced.fov).toBeCloseTo(
      THREE.MathUtils.radToDeg(expected().cameraYfovs[0]),
      5,
    );
    expect(main.fov).toBeCloseTo(
      THREE.MathUtils.radToDeg(expected().cameraYfovs[1]),
      5,
    );
    // Scene roots, sanitized: light, camera, Oracle wrapper, Ship
    // model node, moved group (the generator adds the group last).
    expect(gltf.scene.children.map((c) => c.name)).toEqual([
      "Key_light",
      "Main_camera",
      "Oracle",
      "Ship",
      "Moved_group",
    ]);
  });

  it("model node parents the imported roots plus the spec child", async () => {
    const gltf = await loadGlb("spliced-export.glb");
    const ship = gltf.scene.getObjectByName("Ship") as THREE.Object3D;
    expect(ship).toBeDefined();
    expectVecClose(ship.position.toArray(), expected().shipTranslation);
    // Imported roots (Hull, Wing, SrcCam) first, then the spec child.
    // Loader-visible names: the Oracle subtree already owns "Hull",
    // "Wing", and "SrcCam", so GLTFLoader uniquifies Ship's copies
    // with a "_1" suffix (createUniqueName is document-wide), and
    // "Ship box" sanitizes to "Ship_box".
    expect(ship.children.map((c) => c.name)).toEqual([
      "Hull_1",
      "Wing_1",
      "SrcCam_1",
      "Ship_box",
    ]);
    // The Oracle wrapper holds the exploded Hull/Wing groups — plus
    // an empty group for the source camera node (the exploder makes
    // one group per glTF node; the camera itself is ignored).
    const oracle = gltf.scene.getObjectByName("Oracle") as THREE.Object3D;
    expect(oracle.children.map((c) => c.name)).toEqual([
      "Hull",
      "Wing",
      "SrcCam",
    ]);
  });

  it("moved group parents a box that keeps its local TRS", async () => {
    const gltf = await loadGlb("spliced-export.glb");
    gltf.scene.updateMatrixWorld(true);
    const group = gltf.scene.getObjectByName(
      "Moved_group",
    ) as THREE.Object3D;
    expectVecClose(group.position.toArray(), [2, 0, 0]);
    const box = group.children.find(
      (c) => c.name === "Grouped_box",
    ) as THREE.Object3D;
    expect(box).toBeDefined();
    expectVecClose(box.position.toArray(), [0, 1, 0]);
    const world = new THREE.Vector3();
    box.getWorldPosition(world);
    expectVecClose(world.toArray(), expected().groupedBoxWorld);
  });

  it("one moved part's world transform survives the splice", async () => {
    const gltf = await loadGlb("spliced-export.glb");
    gltf.scene.updateMatrixWorld(true);
    // First "hullMesh" in traversal order is the exploded part the
    // generator moved to [5, 0, 0]; the second is the Ship instance's
    // copy (uniquified by the loader). The part mesh's own geometry
    // is the unit box at the origin, so its world position is the
    // part node's world translation.
    const part = gltf.scene.getObjectByName("hullMesh") as THREE.Object3D;
    expect(part).toBeDefined();
    const world = new THREE.Vector3();
    part.getWorldPosition(world);
    expectVecClose(world.toArray(), expected().movedPartWorld);
  });
});
