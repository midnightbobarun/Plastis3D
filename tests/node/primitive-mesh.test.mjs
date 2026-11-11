// tests/node/primitive-mesh.test.mjs — Tier 3 mesh oracle (PR6, Stage 3 §5 T3).
//
// GLTFLoader (three 0.180.0, Node, no WebGL) loads the GLB the real
// Python writer produced (tests/fixtures/primitive-mesh.glb) and checks
// it against tests/fixtures/primitive-mesh.json: quantized POSITION /
// NORMAL hashes per primitive, the floor rotation, cam_main's yfov, and
// the moved-group parenting.
//
// Canonical hash form (the authority is
// tests/fixtures/make_primitive_mesh_glb.py::quantized_hash — mirrored
// here exactly): for one primitive, take the generated positions then
// normals, round each float to float32 first (the Node side already sees
// float32 values from the loader), format each with
// `v === 0 ? "0.00000" : v.toFixed(5)` (so -0.0 formats as "0.00000",
// matching Python's `f"{(0.0 if v == 0 else v):.5f}"`), join all values
// with ",", and take the SHA-256 hex of that UTF-8 text.
//
// Caveats (stage-3.md §5 T3): use loader.parseAsync(ArrayBuffer) —
// never load() (no fetch in Node for local files); slice the Node Buffer
// to its exact ArrayBuffer first (Buffer.slice() shares the Node pool,
// so .buffer on a slice would hand GLTFLoader the whole pool).
// This proves loader acceptance and fixture parity; it is not a full
// glTF 2.0 conformance claim.
//
// Name caveat, measured on three 0.180.0: GLTFLoader sanitizes every
// node/mesh/camera name through PropertyBinding.sanitizeNodeName
// (GLTFParser.createUniqueName), so a glTF name with spaces arrives
// with underscores — "Moved group" -> "Moved_group", "Main camera" ->
// "Main_camera", "Grouped box" -> "Grouped_box". Single-word names
// are unchanged. Tests below look nodes up by their loader-visible
// (sanitized) name, derived from the fixture names with loaderName().
// The writer is NOT wrong here: the GLB JSON still carries the spaced
// names; this is loader-side renaming only.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";

function fixturePath(name) {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/** The fixture GLB bytes as an exact ArrayBuffer (see header comment). */
function glbArrayBuffer() {
  const bytes = readFileSync(fixturePath("primitive-mesh.glb"));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function fixtureJson() {
  return JSON.parse(readFileSync(fixturePath("primitive-mesh.json"), "utf-8"));
}

/** SHA-256 hex of the canonical quantized text (see header comment). */
function quantizedHash(positions, normals) {
  const values = [];
  for (const v of [...positions, ...normals]) {
    values.push(v === 0 ? "0.00000" : v.toFixed(5));
  }
  return createHash("sha256").update(values.join(","), "utf8").digest("hex");
}

/** The loader-visible name of a glTF node name (spaces -> underscores). */
function loaderName(name) {
  return name.replace(/ /g, "_");
}

async function loadFixture() {
  const loader = new GLTFLoader();
  return loader.parseAsync(glbArrayBuffer(), "");
}

/** Meshes of the parsed scene, keyed by glTF node name. */
function meshesByName(gltf) {
  const byName = new Map();
  gltf.scene.traverse((obj) => {
    if (obj.isMesh) byName.set(obj.name, obj);
  });
  return byName;
}

function expectVecClose(actual, expected, tolerance = 1e-5) {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    expect(
      Math.abs(actual[i] - expected[i]),
      `component ${i}: got ${actual[i]}, want ${expected[i]}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

describe("primitive-mesh oracle (Python writer GLB under GLTFLoader)", () => {
  it("re-hashes every primitive's POSITION/NORMAL arrays to the fixture hash", async () => {
    const expected = fixtureJson();
    const gltf = await loadFixture();
    const meshes = meshesByName(gltf);
    // The glTF node names are the capitalized primitive names; the
    // fixture JSON lists the primitive types in the same order.
    const nodeName = {
      box: "Box",
      sphere: "Sphere",
      cylinder: "Cylinder",
      cone: "Cone",
      torus: "Torus",
      plane: "Plane",
      capsule: "Capsule",
    };
    for (const primitive of expected.primitives) {
      const mesh = meshes.get(nodeName[primitive.type]);
      expect(mesh, `mesh node ${nodeName[primitive.type]}`).toBeDefined();
      const geometry = mesh.geometry;
      const positions = geometry.attributes.position.array;
      const normals = geometry.attributes.normal.array;
      expect(positions.length / 3, `${primitive.type} verts`).toBe(
        primitive.verts,
      );
      // Indexed geometry: one triangle per 3 indices.
      expect(geometry.index.count / 3, `${primitive.type} tris`).toBe(
        primitive.tris,
      );
      expect(
        quantizedHash(positions, normals),
        `${primitive.type} quantized hash`,
      ).toBe(primitive.hash);
    }
    // The floor is a second plane node; its geometry hashes the same.
    const floor = meshes.get("Floor");
    expect(floor).toBeDefined();
    expect(
      quantizedHash(
        floor.geometry.attributes.position.array,
        floor.geometry.attributes.normal.array,
      ),
      "Floor quantized hash",
    ).toBe(
      expected.primitives.find((p) => p.type === "plane").hash,
    );
    // The grouped box is a second box node with the box hash.
    const groupedBox = meshes.get(loaderName("Grouped box"));
    expect(groupedBox).toBeDefined();
    expect(
      quantizedHash(
        groupedBox.geometry.attributes.position.array,
        groupedBox.geometry.attributes.normal.array,
      ),
      "Grouped box quantized hash",
    ).toBe(expected.primitives.find((p) => p.type === "box").hash);
  });

  it("the floor node maps (0, 1, 0) to (0, 0, -1) under its world quaternion", async () => {
    const expected = fixtureJson();
    const gltf = await loadFixture();
    gltf.scene.updateMatrixWorld(true);
    const floor = gltf.scene.getObjectByName("Floor");
    expect(floor).toBeDefined();
    const quaternion = new THREE.Quaternion();
    floor.getWorldQuaternion(quaternion);
    const mapped = new THREE.Vector3(...expected.floor.point).applyQuaternion(
      quaternion,
    );
    expectVecClose(mapped.toArray(), expected.floor.expected, 1e-5);
  });

  it("cam_main's camera yfov equals the fixture yfov", async () => {
    const expected = fixtureJson();
    const gltf = await loadFixture();
    // The writer names the node "Main camera" (the spec node id is
    // cam_main); the loader sanitizes it to "Main_camera" (see header).
    // The camera object carries the yfov as fov in degrees.
    expect(gltf.cameras).toHaveLength(1);
    const camera = gltf.cameras[0];
    expect(camera.name).toBe("Main_camera");
    expect(camera.isPerspectiveCamera).toBe(true);
    const yfov = (camera.fov * Math.PI) / 180;
    expect(Math.abs(yfov - expected.yfov)).toBeLessThanOrEqual(1e-5);
  });

  it("the grouped box is a child of the moved group, whose translation is preserved", async () => {
    const expected = fixtureJson();
    const gltf = await loadFixture();
    const group = gltf.scene.getObjectByName(
      loaderName(expected.groupChild.group),
    );
    const child = gltf.scene.getObjectByName(
      loaderName(expected.groupChild.child),
    );
    expect(group).toBeDefined();
    expect(child).toBeDefined();
    expect(child.parent).toBe(group);
    expectVecClose(group.position.toArray(), [2, 0, 0], 1e-5);
    expectVecClose(child.position.toArray(), [0, 1, 0], 1e-5);
    // The child is not a scene root.
    expect(gltf.scene.children).not.toContain(child);
    // World position follows the group: (2, 0, 0) + (0, 1, 0).
    gltf.scene.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    child.getWorldPosition(world);
    expectVecClose(world.toArray(), [2, 1, 0], 1e-5);
  });
});
