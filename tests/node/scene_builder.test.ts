// tests/node/scene_builder.test.ts — Tier 2 (pure TS, Vitest) + Tier 3
// (headless Three.js, no WebGL context) tests for the PR4 builder core.
//
// Covers stage-4 §5 T2 (hierarchy from mock specs, node ids, Euler
// transforms, light targets, reparenting math, finiteness guards) and
// T3 (builder determinism, part-mapping against a known multi-primitive
// GLB). The modules under test import no @hermes/plugin-sdk, so no SDK
// stub is needed here.
//
// Part-mapping note (T3): PR7's exploder does not exist yet, so the
// view only consumes stats.parts — the test therefore FABRICATES the
// stats.parts entries from tests/fixtures/two-primitive.expected.json
// (computed by make_two_primitive_glb.py from the same box geometry
// the GLB embeds). GLTFLoader DOES run for real in Node (three 0.180.0,
// GLTFLoader.parseAsync on an ArrayBuffer, geometry-only fixture with
// no textures); nothing about the parse is faked.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ApiError, envelopeToScene, getAssetBytes, getScene, listScenes } from "../../src/api";
import type { RestFn } from "../../src/api";
import {
  buildCamera,
  buildLight,
  buildPrimitiveGeometry,
  buildSceneGraph,
  disposeBuiltScene,
  reparentPreservingWorld,
  resolveModelSlot,
} from "../../src/scene/build";
import type { BuiltScene, ModelSlot } from "../../src/scene/build";
import { createStatsPlaceholder, disposeStatsPlaceholder } from "../../src/scene/bounds";
import { TemplateCache, isTemplateFailure } from "../../src/scene/cache";
import { readTheme } from "../../src/theme";
import type {
  AssetPartStats,
  AssetSpec,
  MaterialSpec,
  NodeSpec,
  SceneEnvelope,
  SceneSpec,
} from "../../src/types";

// --- helpers ---------------------------------------------------------------

const DEFAULT_MATERIAL: MaterialSpec = {
  id: "m_default",
  color: "#c8ccd0",
  emissive: "#000000",
  metalness: 0,
  roughness: 0.6,
  opacity: 1,
  doubleSide: false,
};

function node(
  id: string,
  kind: NodeSpec["kind"],
  extra: Partial<NodeSpec> = {},
): NodeSpec {
  return {
    id,
    name: id,
    kind,
    transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
    parent: null,
    visible: true,
    ...extra,
  };
}

function scene(
  nodes: NodeSpec[],
  materials: MaterialSpec[] = [DEFAULT_MATERIAL],
  assets: AssetSpec[] = [],
): SceneSpec {
  return {
    schema: 1,
    id: "test-scene",
    name: "Test scene",
    revision: 1,
    units: "m",
    upAxis: "Y",
    createdAt: "",
    updatedAt: "",
    nodes,
    materials,
    assets,
  };
}

function materialMap(materials: MaterialSpec[]): Map<string, MaterialSpec> {
  return new Map(materials.map((m) => [m.id, m]));
}

function expectVec3(
  actual: { toArray: () => number[] },
  expected: [number, number, number],
): void {
  const [x, y, z] = actual.toArray();
  expect(x).toBeCloseTo(expected[0], 6);
  expect(y).toBeCloseTo(expected[1], 6);
  expect(z).toBeCloseTo(expected[2], 6);
}

/** Serialise a built scene for the determinism test. */
function summarize(built: BuiltScene): unknown {
  const entries: unknown[] = [];
  for (const [id, obj] of [...built.nodes.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const entry: Record<string, unknown> = {
      id,
      kind: obj.userData.kind,
      parent: obj.parent === built.root ? "root" : obj.parent?.userData.nodeId,
      position: obj.position.toArray(),
      rotation: obj.rotation.toArray(),
      scale: obj.scale.toArray(),
      visible: obj.visible,
    };
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      const geometry = mesh.geometry as THREE.BufferGeometry & {
        parameters?: Record<string, unknown>;
      };
      geometry.computeBoundingBox();
      entry.geometry = {
        type: geometry.type,
        parameters: geometry.parameters ?? null,
        positionCount: geometry.attributes.position.count,
        bounds: {
          min: geometry.boundingBox?.min.toArray(),
          max: geometry.boundingBox?.max.toArray(),
        },
      };
      const mat = mesh.material as THREE.MeshStandardMaterial;
      entry.material = {
        color: `#${mat.color.getHexString()}`,
        roughness: mat.roughness,
        metalness: mat.metalness,
        opacity: mat.opacity,
        transparent: mat.transparent,
        side: mat.side,
      };
    }
    entries.push(entry);
  }
  return entries;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // A real copy: Buffer.slice() shares the Node pool, so .buffer on a
  // slice would hand GLTFLoader the whole pool (wrong offset/length).
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

// --- T2: hierarchy ---------------------------------------------------------

describe("buildSceneGraph hierarchy", () => {
  it("creates one Object3D per spec node, parented by spec.parent", () => {
    const built = buildSceneGraph(
      scene([
        node("g1", "group"),
        node("m1", "mesh", {
          parent: "g1",
          primitive: { type: "box" },
          materialId: "m_default",
        }),
        node("m2", "mesh", {
          parent: "m1",
          primitive: { type: "sphere" },
          materialId: "m_default",
        }),
        node("l1", "light", {
          light: { type: "directional", color: "#ffffff", intensity: 3 },
        }),
        node("c1", "camera", {
          camera: { type: "perspective", fov: 40, near: 0.01, far: 500 },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    expect(built.nodes.size).toBe(5);
    for (const id of ["g1", "m1", "m2", "l1", "c1"]) {
      expect(built.nodes.get(id)?.userData.nodeId).toBe(id);
    }
    expect(built.nodes.get("m1")?.parent).toBe(built.nodes.get("g1"));
    expect(built.nodes.get("m2")?.parent).toBe(built.nodes.get("m1"));
    expect(built.nodes.get("g1")?.parent).toBe(built.root);
    expect(built.nodes.get("l1")?.parent).toBe(built.root);
    expect(built.root.children).toContain(built.nodes.get("g1"));
  });

  it("a group has no mesh; mesh/camera/light nodes have the right type", () => {
    const built = buildSceneGraph(
      scene([
        node("g1", "group"),
        node("m1", "mesh", { primitive: { type: "box" }, materialId: "m_default" }),
        node("l1", "light", { light: { type: "point", color: "#ffffff", intensity: 1 } }),
        node("c1", "camera", { camera: { type: "perspective", fov: 40, near: 0.01, far: 500 } }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const group = built.nodes.get("g1");
    expect(group).toBeInstanceOf(THREE.Group);
    expect((group as THREE.Mesh).isMesh).toBeFalsy();
    expect(built.nodes.get("m1")).toBeInstanceOf(THREE.Mesh);
    expect(built.nodes.get("l1")).toBeInstanceOf(THREE.Light);
    expect(built.nodes.get("c1")).toBeInstanceOf(THREE.PerspectiveCamera);
    const camera = built.nodes.get("c1") as THREE.PerspectiveCamera;
    expect(camera.fov).toBe(40);
    expect(camera.near).toBe(0.01);
    expect(camera.far).toBe(500);
  });

  it("a dangling parent id falls back to the root instead of dropping the node", () => {
    const built = buildSceneGraph(
      scene([node("m1", "mesh", { parent: "no-such-node", primitive: { type: "box" } })]),
      materialMap([DEFAULT_MATERIAL]),
    );
    expect(built.nodes.get("m1")?.parent).toBe(built.root);
  });

  it("an unknown kind degrades to an empty group rather than throwing", () => {
    const built = buildSceneGraph(
      scene([node("x1", "bogus-kind" as NodeSpec["kind"])]),
      materialMap([DEFAULT_MATERIAL]),
    );
    expect(built.nodes.get("x1")).toBeInstanceOf(THREE.Group);
  });
});

// --- T2: transforms ----------------------------------------------------------

describe("transforms (Euler XYZ, degrees)", () => {
  it("applies local TRS: position, degrees-to-radians XYZ rotation, scale", () => {
    const built = buildSceneGraph(
      scene([
        node("m1", "mesh", {
          primitive: { type: "box" },
          materialId: "m_default",
          transform: { t: [1, 2, 3], r: [30, 45, 60], s: [2, 3, 4] },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const obj = built.nodes.get("m1") as THREE.Object3D;
    expectVec3(obj.position, [1, 2, 3]);
    expect(obj.rotation.order).toBe("XYZ");
    expect(obj.rotation.x).toBeCloseTo((30 * Math.PI) / 180, 10);
    expect(obj.rotation.y).toBeCloseTo((45 * Math.PI) / 180, 10);
    expect(obj.rotation.z).toBeCloseTo((60 * Math.PI) / 180, 10);
    expectVec3(obj.scale, [2, 3, 4]);
  });

  it("local -Z follows the stored Euler (r=[0,90,0] aims -Z at -X)", () => {
    const built = buildSceneGraph(
      scene([
        node("m1", "mesh", {
          primitive: { type: "box" },
          transform: { t: [0, 0, 0], r: [0, 90, 0], s: [1, 1, 1] },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const obj = built.nodes.get("m1") as THREE.Object3D;
    const minusZ = new THREE.Vector3(0, 0, -1).applyEuler(obj.rotation);
    expectVec3(minusZ, [-1, 0, 0]);
  });

  it("the default light rig aims at the origin (spec.py verified values)", () => {
    const built = buildSceneGraph(
      scene([
        node("light_key", "light", {
          transform: { t: [4, 6, 3], r: [-63.4349, 30.807, 45.6876], s: [1, 1, 1] },
          light: { type: "directional", color: "#ffffff", intensity: 3 },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const light = built.nodes.get("light_key") as THREE.Object3D;
    const minusZ = new THREE.Vector3(0, 0, -1).applyEuler(light.rotation);
    const toOrigin = light.position.clone().negate().normalize();
    expect(minusZ.dot(toOrigin)).toBeGreaterThan(0.9999);
  });

  it("a plane lies on XY facing +Z; r=[-90,0,0] makes it a floor", () => {
    const built = buildSceneGraph(
      scene([
        node("floor", "mesh", {
          primitive: { type: "plane", width: 4, height: 4 },
          transform: { t: [0, 0, 0], r: [-90, 0, 0], s: [1, 1, 1] },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const obj = built.nodes.get("floor") as THREE.Object3D;
    const normal = new THREE.Vector3(0, 0, 1).applyEuler(obj.rotation);
    expectVec3(normal, [0, 1, 0]);
  });
});

// --- T2: primitives + materials ----------------------------------------------

describe("primitives and materials", () => {
  it("uses the spec defaults for every primitive type", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["box", { width: 1, height: 1, depth: 1 }],
      ["sphere", { radius: 0.5, widthSegments: 16, heightSegments: 12 }],
      ["cylinder", { radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 16 }],
      ["cone", { radius: 0.5, height: 1, radialSegments: 16 }],
      ["torus", { radius: 0.5, tube: 0.15, radialSegments: 12, tubularSegments: 24 }],
      ["plane", { width: 1, height: 1 }],
      // Three.js names the spec's `length` parameter `height`
      // (CapsuleGeometry(radius, height, capSegments, radialSegments)).
      ["capsule", { radius: 0.25, height: 1, capSegments: 4, radialSegments: 8 }],
    ];
    for (const [type, expected] of cases) {
      const geometry = buildPrimitiveGeometry({ type: type as never }) as THREE.BufferGeometry & {
        parameters: Record<string, unknown>;
      };
      for (const [key, value] of Object.entries(expected)) {
        expect(
          geometry.parameters[key],
          `${type}.${key}`,
        ).toBe(value);
      }
      geometry.dispose();
    }
  });

  it("applies material color/roughness/metalness/emissive/opacity/doubleSide", () => {
    const mat: MaterialSpec = {
      id: "m_glass",
      color: "#336699",
      emissive: "#110022",
      metalness: 0.25,
      roughness: 0.1,
      opacity: 0.5,
      doubleSide: true,
    };
    const built = buildSceneGraph(
      scene([
        node("m1", "mesh", { primitive: { type: "box" }, materialId: "m_glass" }),
      ]),
      materialMap([DEFAULT_MATERIAL, mat]),
    );
    const mesh = built.nodes.get("m1") as THREE.Mesh;
    const material = mesh.material as THREE.MeshStandardMaterial;
    expect(`#${material.color.getHexString()}`).toBe("#336699");
    expect(`#${material.emissive.getHexString()}`).toBe("#110022");
    expect(material.metalness).toBe(0.25);
    expect(material.roughness).toBe(0.1);
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);
    expect(material.side).toBe(THREE.DoubleSide);
  });

  it("transparent is false at opacity 1 and an unknown material falls back to default", () => {
    const built = buildSceneGraph(
      scene([
        node("m1", "mesh", { primitive: { type: "box" }, materialId: "m_default" }),
        node("m2", "mesh", { primitive: { type: "box" }, materialId: "m_missing" }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const opaque = (built.nodes.get("m1") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(opaque.transparent).toBe(false);
    const fallback = (built.nodes.get("m2") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(`#${fallback.color.getHexString()}`).toBe("#c8ccd0");
  });
});

// --- T2: lights ----------------------------------------------------------------

describe("lights", () => {
  it("parents the directional target at local (0,0,-1) with rotation from the stored Euler", () => {
    const built = buildSceneGraph(
      scene([
        node("light_key", "light", {
          transform: { t: [4, 6, 3], r: [-63.4349, 30.807, 45.6876], s: [1, 1, 1] },
          light: { type: "directional", color: "#ffffff", intensity: 3 },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const light = built.nodes.get("light_key") as THREE.DirectionalLight;
    expect(light.target.parent).toBe(light);
    expectVec3(light.target.position, [0, 0, -1]);
    // The beam direction (light -> target in world space) is the local
    // -Z axis under the stored Euler, i.e. it points at the origin.
    built.root.updateMatrixWorld(true);
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    light.getWorldPosition(from);
    light.target.getWorldPosition(to);
    const beam = to.sub(from).normalize();
    const toOrigin = from.clone().negate().normalize();
    expect(beam.dot(toOrigin)).toBeGreaterThan(0.9999);
  });

  it("spot lights convert angle degrees to radians and pass penumbra/distance/decay", () => {
    const spot = buildLight({
      type: "spot",
      color: "#ffffff",
      intensity: 2,
      distance: 10,
      decay: 2,
      angle: 30,
      penumbra: 0.5,
    }) as THREE.SpotLight;
    expect(spot.angle).toBeCloseTo((30 * Math.PI) / 180, 10);
    expect(spot.penumbra).toBe(0.5);
    expect(spot.distance).toBe(10);
    expect(spot.decay).toBe(2);
    expect(spot.target.parent).toBe(spot);
    expectVec3(spot.target.position, [0, 0, -1]);
  });

  it("point lights carry distance/decay and have no target child", () => {
    const point = buildLight({
      type: "point",
      color: "#ffffff",
      intensity: 1,
      distance: 5,
      decay: 1,
    }) as THREE.PointLight;
    expect(point.distance).toBe(5);
    expect(point.decay).toBe(1);
    expect(point.children.length).toBe(0);
  });

  it("buildCamera guards a degenerate near/far pair", () => {
    const camera = buildCamera({ fov: 40, near: 0, far: 0 });
    expect(camera.near).toBe(0.01);
    expect(camera.far).toBeGreaterThan(camera.near);
  });
});

// --- T2: reparenting ------------------------------------------------------------

describe("reparenting", () => {
  it("reparentPreservingWorld keeps world position and orientation", () => {
    const built = buildSceneGraph(
      scene([
        node("g1", "group", {
          transform: { t: [10, 0, 0], r: [0, 90, 0], s: [1, 1, 1] },
        }),
        node("m1", "mesh", {
          parent: "g1",
          primitive: { type: "box" },
          transform: { t: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
        }),
      ]),
      materialMap([DEFAULT_MATERIAL]),
    );
    const child = built.nodes.get("m1") as THREE.Object3D;
    built.root.updateMatrixWorld(true);
    const beforePos = new THREE.Vector3();
    const beforeQuat = new THREE.Quaternion();
    child.getWorldPosition(beforePos);
    child.getWorldQuaternion(beforeQuat);
    // Group at (10,0,0) rotated 90 deg about Y: child local (1,0,0)
    // lands at world (10,0,-1).
    expectVec3(beforePos, [10, 0, -1]);

    reparentPreservingWorld(child, built.root);
    built.root.updateMatrixWorld(true);
    const afterPos = new THREE.Vector3();
    const afterQuat = new THREE.Quaternion();
    child.getWorldPosition(afterPos);
    child.getWorldQuaternion(afterQuat);
    expect(child.parent).toBe(built.root);
    expectVec3(afterPos, [10, 0, -1]);
    expect(afterQuat.angleTo(beforeQuat)).toBeCloseTo(0, 10);
    // ... and the local transform now carries the world transform.
    expectVec3(child.position, [10, 0, -1]);
  });
});

// --- T2: finiteness guards ------------------------------------------------------

describe("number finiteness guards", () => {
  it("NaN/Infinity in a transform or param produces no NaN matrix", () => {
    const built = buildSceneGraph(
      scene([
        node("bad", "mesh", {
          primitive: { type: "box", width: Number.NaN, height: Number.POSITIVE_INFINITY },
          materialId: "m_default",
          transform: {
            t: [Number.NaN, Number.POSITIVE_INFINITY, 1],
            r: [Number.NaN, 0, 0],
            s: [Number.POSITIVE_INFINITY, 1, 1],
          },
        }),
        node("bad-sphere", "mesh", {
          primitive: { type: "sphere", radius: Number.NEGATIVE_INFINITY },
          materialId: "m_default",
        }),
        node("bad-light", "light", {
          light: { type: "directional", color: "#ffffff", intensity: Number.NaN },
        }),
        node("bad-cam", "camera", {
          camera: { type: "perspective", fov: Number.NaN, near: Number.NaN, far: Number.NaN },
        }),
      ]),
      materialMap([
        {
          ...DEFAULT_MATERIAL,
          opacity: Number.NaN,
          roughness: Number.POSITIVE_INFINITY,
        },
      ]),
    );
    built.root.updateMatrixWorld(true);
    built.root.traverse((obj) => {
      for (const value of obj.matrixWorld.elements) {
        expect(Number.isFinite(value), `${obj.userData.nodeId} matrix`).toBe(true);
      }
      for (const value of obj.matrix.elements) {
        expect(Number.isFinite(value), `${obj.userData.nodeId} matrix`).toBe(true);
      }
    });
    // And the guards replaced the bad values with the spec defaults.
    const bad = built.nodes.get("bad") as THREE.Object3D;
    expectVec3(bad.position, [0, 0, 1]);
    expectVec3(bad.scale, [1, 1, 1]);
    const badGeometry = (built.nodes.get("bad") as THREE.Mesh).geometry as THREE.BoxGeometry;
    expect(badGeometry.parameters.width).toBe(1);
    expect(badGeometry.parameters.height).toBe(1);
    const badSphere = (built.nodes.get("bad-sphere") as THREE.Mesh).geometry as THREE.SphereGeometry;
    expect(badSphere.parameters.radius).toBe(0.5);
    const badLight = built.nodes.get("bad-light") as THREE.DirectionalLight;
    expect(badLight.intensity).toBe(1);
    const badCam = built.nodes.get("bad-cam") as THREE.PerspectiveCamera;
    expect(badCam.fov).toBe(40);
    const badMat = (built.nodes.get("bad") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    expect(badMat.opacity).toBe(1);
    expect(badMat.roughness).toBe(0.6);
  });
});

// --- T3: builder determinism ---------------------------------------------------

describe("builder determinism", () => {
  it("identical JSON produces an identical hierarchy", () => {
    const json = JSON.stringify(
      scene([
        node("g1", "group", { transform: { t: [1, 0, 0], r: [0, 30, 0], s: [1, 1, 1] } }),
        node("m1", "mesh", {
          parent: "g1",
          primitive: { type: "torus", radius: 0.7, tube: 0.2 },
          materialId: "m_default",
          transform: { t: [0, 1, 0], r: [10, 20, 30], s: [2, 2, 2] },
        }),
        node("m2", "mesh", {
          primitive: { type: "capsule" },
          materialId: "m_default",
          transform: { t: [-1, 0, 2], r: [0, 0, 45], s: [1, 1, 1] },
        }),
        node("l1", "light", {
          light: { type: "spot", color: "#ffeecc", intensity: 2, angle: 25, penumbra: 0.3 },
          transform: { t: [4, 6, 3], r: [-63.4349, 30.807, 45.6876], s: [1, 1, 1] },
        }),
        node("c1", "camera", {
          camera: { type: "perspective", fov: 40, near: 0.01, far: 500 },
        }),
      ]),
    );
    const a = buildSceneGraph(JSON.parse(json) as SceneSpec, materialMap([DEFAULT_MATERIAL]));
    const b = buildSceneGraph(JSON.parse(json) as SceneSpec, materialMap([DEFAULT_MATERIAL]));
    expect(summarize(b)).toEqual(summarize(a));
    disposeBuiltScene(a);
    disposeBuiltScene(b);
  });
});

// --- T3: part mapping -----------------------------------------------------------

describe("part mapping (two-primitive GLB fixture)", () => {
  const glbBytes = (): ArrayBuffer =>
    toArrayBuffer(readFileSync(fixturePath("two-primitive.glb")));
  const expectedParts = (): AssetPartStats[] =>
    (JSON.parse(readFileSync(fixturePath("two-primitive.expected.json"), "utf-8")) as {
      parts: AssetPartStats[];
    }).parts;

  function assetFor(parts: AssetPartStats[]): AssetSpec {
    return {
      id: "a_fixture",
      sha256: "0".repeat(64),
      file: "two-primitive.glb",
      format: "glb",
      bytes: 2184,
      originalName: "two-primitive.glb",
      sourceFormat: "glb",
      stats: {
        tris: 36,
        verts: 108,
        meshes: 2,
        drawable: true,
        parts,
      },
    };
  }

  it("GLTFLoader parses the fixture in Node and the cache maps (mesh, primitive)", async () => {
    const parts = expectedParts();
    const asset = assetFor(parts);
    const cache = new TemplateCache();
    let fetches = 0;
    const template = await cache.get("test-source", asset, async () => {
      fetches += 1;
      return glbBytes();
    });
    expect(template).not.toBeNull();
    expect(isTemplateFailure(template)).toBe(false);
    if (!template || isTemplateFailure(template)) return;
    expect(fetches).toBe(1);
    expect(template.meshes.length).toBe(3);
    expect(template.primitiveMap).toEqual([
      { meshIndex: 0, primitiveIndex: 0 },
      { meshIndex: 0, primitiveIndex: 1 },
      { meshIndex: 1, primitiveIndex: 0 },
    ]);
    // A second get for the same sourceKey + sha256 reuses the parse.
    const again = await cache.get("test-source", asset, async () => {
      fetches += 1;
      return glbBytes();
    });
    expect(again).toBe(template);
    expect(fetches).toBe(1);
    cache.clear();
  });

  it("each part node's cloned mesh bounds match the per-part bounds in stats.parts", async () => {
    const parts = expectedParts();
    const asset = assetFor(parts);
    const cache = new TemplateCache();
    const template = await cache.get("test-source", asset, async () => glbBytes());
    expect(template).not.toBeNull();
    expect(isTemplateFailure(template)).toBe(false);
    if (!template || isTemplateFailure(template)) return;

    const partNodes = parts.map((part, i) =>
      node(`part${i}`, "part", {
        modelAssetId: asset.id,
        meshIndex: part.meshIndex,
        primitiveIndex: part.primitiveIndex,
      }),
    );
    const built = buildSceneGraph(
      scene(
        [
          node("model1", "model", { modelAssetId: asset.id }),
          ...partNodes,
        ],
        [DEFAULT_MATERIAL],
        [asset],
      ),
      materialMap([DEFAULT_MATERIAL]),
    );
    expect(built.modelSlots.length).toBe(4);

    // The template itself is never parented into the built scene.
    expect(template.scene.parent).toBeNull();

    for (const slot of built.modelSlots) {
      const clones = resolveModelSlot(slot, template);
      expect(clones.length).toBeGreaterThan(0);
      for (const clone of clones) {
        expect(clone.parent).toBe(slot.node);
        // Clones are new objects sharing the template's geometry —
        // never the template's own meshes.
        expect(template.meshes.includes(clone as THREE.Mesh)).toBe(false);
      }
    }

    // Model node: the full template scene is cloned as one hierarchy.
    const modelNode = built.nodes.get("model1") as THREE.Group;
    expect(modelNode.children.length).toBe(1);
    const modelMeshes: THREE.Mesh[] = [];
    modelNode.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) modelMeshes.push(obj as THREE.Mesh);
    });
    expect(modelMeshes.length).toBe(3);

    // Part nodes: each cloned mesh's world bounds match stats.parts.
    built.root.updateMatrixWorld(true);
    for (let i = 0; i < parts.length; i += 1) {
      const slot = built.modelSlots.find(
        (s) => (s.node.userData.nodeId as string) === `part${i}`,
      ) as ModelSlot;
      expect(slot).toBeDefined();
      expect(slot.node.children.length).toBe(1);
      const clone = slot.node.children[0];
      const box = new THREE.Box3().setFromObject(clone);
      expect(box.min.toArray().map((v) => Number(v.toFixed(6)))).toEqual(
        parts[i].bounds.min,
      );
      expect(box.max.toArray().map((v) => Number(v.toFixed(6)))).toEqual(
        parts[i].bounds.max,
      );
    }
    cache.clear();
  });

  it("the cache returns null above the draw cap / when not drawable, and a typed failure on fetch failure — never throws", async () => {
    const cache = new TemplateCache();
    let fetches = 0;
    const countingFetch = async (): Promise<ArrayBuffer> => {
      fetches += 1;
      return glbBytes();
    };
    const base = assetFor(expectedParts());

    const overCap: AssetSpec = {
      ...base,
      stats: { ...base.stats, tris: 100_001 },
    };
    await expect(cache.get("s", overCap, countingFetch)).resolves.toBeNull();
    expect(fetches).toBe(0);

    const trisNull: AssetSpec = { ...base, stats: { ...base.stats, tris: null } };
    await expect(cache.get("s", trisNull, countingFetch)).resolves.toBeNull();
    expect(fetches).toBe(0);

    const notDrawable: AssetSpec = {
      ...base,
      stats: { ...base.stats, drawable: false },
    };
    await expect(cache.get("s", notDrawable, countingFetch)).resolves.toBeNull();
    expect(fetches).toBe(0);

    // G-13: a fetch failure is a typed failure, not null — and a 413
    // keeps its kind, so the caller can blame the byte route, never
    // the triangle cap.
    const failingFetch = async (): Promise<ArrayBuffer> => {
      throw new Error("gateway down");
    };
    await expect(cache.get("s", base, failingFetch)).resolves.toEqual({
      failure: "unavailable",
    });
    const tooLargeFetch = async (): Promise<ArrayBuffer> => {
      throw new ApiError("ASSET_TOO_LARGE", "ASSET_TOO_LARGE asset too large");
    };
    await expect(cache.get("s", base, tooLargeFetch)).resolves.toEqual({
      failure: "asset-too-large",
    });

    // A failure is not cached as a template or as null: the next get
    // re-fetches and parses.
    const template = await cache.get("s", base, countingFetch);
    expect(template).not.toBeNull();
    expect(isTemplateFailure(template)).toBe(false);
    expect(fetches).toBe(1);
    const other = await cache.get("other-source", base, countingFetch);
    expect(other).not.toBeNull();
    expect(other).not.toBe(template);
    expect(fetches).toBe(2);
    cache.clear("s");
    const reparsed = await cache.get("s", base, countingFetch);
    expect(reparsed).not.toBeNull();
    expect(reparsed).not.toBe(template);
    expect(fetches).toBe(3);
    cache.clear();
  });
});

// --- api.ts ---------------------------------------------------------------------

describe("api wrappers", () => {
  const summaries = [{ id: "a", name: "A", revision: 1, updatedAt: "2026-11-07T00:00:00Z" }];

  it("listScenes returns the scenes array from an ok payload", async () => {
    const rest: RestFn = async () => ({ ok: true, scenes: summaries }) as never;
    await expect(listScenes(rest)).resolves.toEqual(summaries);
  });

  it("listScenes turns a resolved {ok:false} payload into a typed ApiError", async () => {
    const rest: RestFn = async () =>
      ({ ok: false, code: "STORE_BUSY", message: "busy" }) as never;
    const error = await listScenes(rest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("STORE_BUSY");
  });

  it("listScenes turns a rejection into a typed ApiError (never a hang)", async () => {
    const rest: RestFn = async () => {
      throw new Error("mock host: ctx.rest has no backend");
    };
    const error = await listScenes(rest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("REST_FAILED");
  });

  it("envelopeToScene uses envelope.scene.schema when present, else 1", () => {
    const base: SceneEnvelope = {
      ok: true,
      scene: { id: "a", revision: 2, units: "m", upAxis: "Y" },
      nodes: [],
      materials: [],
      assets: [],
      stats: { tris: 0, verts: 0, materials: 0, nodes: 0 },
      feedback: { canUndo: false, canRedo: false, defaultsAdded: [], historyTruncated: false },
    };
    const withSchema: SceneEnvelope = {
      ...base,
      scene: { ...base.scene, schema: 2 },
    };
    expect(envelopeToScene(withSchema, "A").schema).toBe(2);
    // An older envelope with no schema field falls back to 1.
    expect(envelopeToScene(base, "A").schema).toBe(1);
  });

  it("getScene returns the envelope and maps a 404 payload to SCENE_NOT_FOUND", async () => {
    const envelope = {
      ok: true,
      scene: { id: "a", revision: 2, units: "m", upAxis: "Y" },
      nodes: [],
      materials: [],
      assets: [],
      stats: { tris: 0, verts: 0, materials: 0, nodes: 0 },
      feedback: { canUndo: false, canRedo: false, defaultsAdded: [], historyTruncated: false },
    };
    const okRest: RestFn = async (path) => {
      expect(path).toBe("/scenes/a");
      return envelope as never;
    };
    await expect(getScene(okRest, "a")).resolves.toEqual(envelope);

    const missingRest: RestFn = async () =>
      ({ ok: false, code: "SCENE_NOT_FOUND", message: "no scene" }) as never;
    const error = await getScene(missingRest, "nope").catch((e: unknown) => e);
    expect((error as ApiError).code).toBe("SCENE_NOT_FOUND");
  });

  it("getAssetBytes returns bytes, and maps the 501 NOT_IMPLEMENTED payload to a typed failure", async () => {
    const bytes = new ArrayBuffer(8);
    const okRest: RestFn = async (path) => {
      expect(path).toBe(`/assets/${"a".repeat(64)}`);
      return bytes as never;
    };
    await expect(getAssetBytes(okRest, "a".repeat(64))).resolves.toBe(bytes);

    const notImplementedRest: RestFn = async () =>
      ({ ok: false, code: "NOT_IMPLEMENTED", message: "pending PR7" }) as never;
    const error = await getAssetBytes(notImplementedRest, "b".repeat(64)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NOT_IMPLEMENTED");

    const rejectingRest: RestFn = async () => {
      throw new Error("transport failure");
    };
    const rejected = await getAssetBytes(rejectingRest, "c".repeat(64)).catch(
      (e: unknown) => e,
    );
    expect((rejected as ApiError).code).toBe("REST_FAILED");

    // A resolved JSON payload is not bytes (ctx.rest JSON-parses): typed failure.
    const jsonRest: RestFn = async () => ({ ok: true }) as never;
    const jsonError = await getAssetBytes(jsonRest, "d".repeat(64)).catch(
      (e: unknown) => e,
    );
    expect((jsonError as ApiError).code).toBe("BAD_RESPONSE");
  });
});

// --- disposal + bounds placeholder ----------------------------------------------

describe("disposeBuiltScene and stats placeholder", () => {
  it("disposes geometries/materials this build created, never shared template geometry", async () => {
    const parts = (JSON.parse(
      readFileSync(fixturePath("two-primitive.expected.json"), "utf-8"),
    ) as { parts: AssetPartStats[] }).parts;
    const asset: AssetSpec = {
      id: "a_fixture",
      sha256: "0".repeat(64),
      file: "two-primitive.glb",
      format: "glb",
      bytes: 2184,
      originalName: "two-primitive.glb",
      sourceFormat: "glb",
      stats: { tris: 36, verts: 108, meshes: 2, drawable: true, parts },
    };
    const cache = new TemplateCache();
    const template = await cache.get("s", asset, async () =>
      toArrayBuffer(readFileSync(fixturePath("two-primitive.glb"))),
    );
    expect(template).not.toBeNull();
    expect(isTemplateFailure(template)).toBe(false);
    if (!template || isTemplateFailure(template)) return;

    const built = buildSceneGraph(
      scene(
        [
          node("m1", "mesh", { primitive: { type: "box" }, materialId: "m_default" }),
          node("m2", "mesh", { primitive: { type: "sphere" }, materialId: "m_default" }),
          node("model1", "model", { modelAssetId: asset.id }),
        ],
        [DEFAULT_MATERIAL],
        [asset],
      ),
      materialMap([DEFAULT_MATERIAL]),
    );
    const slot = built.modelSlots[0];
    resolveModelSlot(slot, template);

    let disposedPrimitiveGeometries = 0;
    let disposedMaterials = 0;
    let disposedTemplateGeometries = 0;
    built.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.addEventListener("dispose", () => {
          disposedPrimitiveGeometries += 1;
        });
      }
    });
    for (const mesh of template.meshes) {
      mesh.geometry.addEventListener("dispose", () => {
        disposedTemplateGeometries += 1;
      });
    }
    const material = (built.nodes.get("m1") as THREE.Mesh).material as THREE.MeshStandardMaterial;
    material.addEventListener("dispose", () => {
      disposedMaterials += 1;
    });

    disposeBuiltScene(built);
    // Two primitive geometries (box + sphere) and the one shared
    // material (both meshes use m_default) are disposed exactly once.
    expect(disposedPrimitiveGeometries).toBe(2);
    expect(disposedMaterials).toBe(1);
    expect(disposedTemplateGeometries).toBe(0);
    // Disposing twice is safe.
    expect(() => disposeBuiltScene(built)).not.toThrow();
    cache.clear();
  });

  it("createStatsPlaceholder draws the stats bounds and carries stats in userData", () => {
    const asset: AssetSpec = {
      id: "a_big",
      sha256: "f".repeat(64),
      file: "big.glb",
      format: "glb",
      bytes: 1,
      originalName: "big.glb",
      sourceFormat: "glb",
      stats: {
        tris: 500_000,
        verts: 250_000,
        drawable: false,
        bounds: { min: [-2, -1, -3], max: [4, 5, 6] },
      },
    };
    const placeholder = createStatsPlaceholder(asset);
    expect(placeholder.box.min.toArray()).toEqual([-2, -1, -3]);
    expect(placeholder.box.max.toArray()).toEqual([4, 5, 6]);
    expect(placeholder.group.userData.assetId).toBe("a_big");
    expect(
      (placeholder.group.userData.stats as { tris?: number }).tris,
    ).toBe(500_000);
    expect(placeholder.group.userData.hasBounds).toBe(true);
    expect(() => disposeStatsPlaceholder(placeholder)).not.toThrow();

    const noBounds: AssetSpec = { ...asset, stats: { tris: null, drawable: false } };
    const fallback = createStatsPlaceholder(noBounds);
    expect(fallback.box.min.toArray()).toEqual([-0.5, -0.5, -0.5]);
    expect(fallback.box.max.toArray()).toEqual([0.5, 0.5, 0.5]);
    expect(fallback.group.userData.hasBounds).toBe(false);
  });
});

// --- theme ----------------------------------------------------------------------

describe("readTheme", () => {
  it("returns empty strings with no document (Node)", () => {
    expect(readTheme()).toEqual({
      background: "",
      accent: "",
      stroke: "",
      textSecondary: "",
      red: "",
      blue: "",
    });
  });

  // N-01 walk-up: fake DOM elements with transparent / non-transparent
  // backgrounds. getComputedStyle is stubbed per element identity.
  function fakeEl(
    backgroundColor: string,
    parentElement: unknown,
    vars: Record<string, string> = {},
  ): unknown {
    return { parentElement, __bg: backgroundColor, __vars: vars };
  }

  function stubDocument(body: unknown): void {
    vi.stubGlobal(
      "getComputedStyle",
      (el: { __bg?: string; __vars?: Record<string, string> }) => ({
        backgroundColor: el.__bg ?? "",
        getPropertyValue: (name: string) => el.__vars?.[name] ?? "",
      }),
    );
    vi.stubGlobal("document", {
      body,
      documentElement: fakeEl("", null),
    });
  }

  it("walks up from the mount element until the background is not transparent", () => {
    const body = fakeEl("rgba(0, 0, 0, 0)", null, {
      "--ui-accent": "rgb(1, 2, 3)",
      "--ui-stroke-secondary": "rgb(4, 5, 6)",
      "--ui-text-secondary": "rgb(7, 8, 9)",
    });
    const section = fakeEl("rgb(10, 20, 30)", body);
    const mount = fakeEl("rgba(0, 0, 0, 0)", section);
    stubDocument(body);
    try {
      const theme = readTheme(mount as Element);
      expect(theme.background).toBe("rgb(10, 20, 30)");
      expect(theme.accent).toBe("rgb(1, 2, 3)");
      expect(theme.stroke).toBe("rgb(4, 5, 6)");
      expect(theme.textSecondary).toBe("rgb(7, 8, 9)");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("takes the mount element's own background when it is not transparent", () => {
    const body = fakeEl("rgb(200, 200, 200)", null);
    const mount = fakeEl("rgb(10, 20, 30)", body);
    stubDocument(body);
    try {
      expect(readTheme(mount as Element).background).toBe("rgb(10, 20, 30)");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns an empty background when the whole chain is transparent", () => {
    const body = fakeEl("rgba(0, 0, 0, 0)", null);
    const mount = fakeEl("", body);
    stubDocument(body);
    try {
      expect(readTheme(mount as Element).background).toBe("");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults to the body when no element is passed", () => {
    const body = fakeEl("rgb(9, 9, 9)", null);
    stubDocument(body);
    try {
      expect(readTheme().background).toBe("rgb(9, 9, 9)");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
