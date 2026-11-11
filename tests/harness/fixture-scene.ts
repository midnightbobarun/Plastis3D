// tests/harness/fixture-scene.ts — the one-scene Tier 4 fixture.
//
// Shared by the mock host (ctx.rest serves it) and the dispose harness
// (it builds it directly). The scene is the default rig from
// plastis3d_scene/spec.py — light_key (directional, t=[4,6,3]) and
// cam_main (perspective, fov 40, t=[4,3,6]) — plus a box, a sphere, and
// a group with a child box, enough for the viewport test to prove
// primitives render and the hierarchy parents correctly.
//
// Stats are the analytic primitive counts (spec.compute_stats): box 12
// tris / 24 verts, sphere (16x12 segments) 352 tris / 221 verts, child
// box 12 / 24 — 376 tris, 269 verts, 1 material, 6 nodes. The sphere
// count is 2*ws*(hs-1): pole rows emit one triangle per column (PR5
// fix of the PR4 owed item; three.js SphereGeometry emits 352, not 384).

import type {
  SceneEnvelope,
  SceneSpec,
  SceneSummary,
} from "../../src/types";

export const FIXTURE_SCENE_ID = "demo-scene";
export const FIXTURE_SCENE_NAME = "Demo Scene";

export function fixtureSceneSpec(): SceneSpec {
  return {
    schema: 1,
    id: FIXTURE_SCENE_ID,
    name: FIXTURE_SCENE_NAME,
    revision: 1,
    units: "m",
    upAxis: "Y",
    createdAt: "2026-11-07T00:00:00Z",
    updatedAt: "2026-11-07T00:00:00Z",
    nodes: [
      {
        id: "light_key",
        name: "Key light",
        kind: "light",
        transform: { t: [4, 6, 3], r: [-63.4349, 30.807, 45.6876], s: [1, 1, 1] },
        parent: null,
        visible: true,
        light: { type: "directional", color: "#ffffff", intensity: 3 },
      },
      {
        id: "cam_main",
        name: "Main camera",
        kind: "camera",
        transform: { t: [4, 3, 6], r: [-26.5651, 30.807, 14.3633], s: [1, 1, 1] },
        parent: null,
        visible: true,
        camera: { type: "perspective", fov: 40, near: 0.01, far: 500 },
      },
      {
        id: "n_box",
        name: "Box",
        kind: "mesh",
        transform: { t: [0, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] },
        parent: null,
        visible: true,
        primitive: { type: "box", width: 1, height: 1, depth: 1 },
        materialId: "m_default",
      },
      {
        id: "n_sphere",
        name: "Sphere",
        kind: "mesh",
        transform: { t: [1.5, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] },
        parent: null,
        visible: true,
        primitive: {
          type: "sphere",
          radius: 0.5,
          widthSegments: 16,
          heightSegments: 12,
        },
        materialId: "m_default",
      },
      {
        id: "n_group",
        name: "Group",
        kind: "group",
        transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
        parent: null,
        visible: true,
      },
      {
        id: "n_inner",
        name: "Inner box",
        kind: "mesh",
        transform: { t: [-1.5, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] },
        parent: "n_group",
        visible: true,
        primitive: { type: "box", width: 0.5, height: 0.5, depth: 0.5 },
        materialId: "m_default",
      },
    ],
    materials: [
      {
        id: "m_default",
        color: "#c8ccd0",
        emissive: "#000000",
        metalness: 0,
        roughness: 0.6,
        opacity: 1,
        doubleSide: false,
      },
    ],
    assets: [],
  };
}

/** GET /scenes -> { ok, scenes: [{ id, name, revision, updatedAt }] }. */
export function fixtureSceneList(): SceneSummary[] {
  return [
    {
      id: FIXTURE_SCENE_ID,
      name: FIXTURE_SCENE_NAME,
      revision: 1,
      updatedAt: "2026-11-07T00:00:00Z",
    },
  ];
}

/** GET /scenes/{id} -> the feedback envelope (no history stacks). */
export function fixtureSceneEnvelope(): SceneEnvelope {
  const spec = fixtureSceneSpec();
  return {
    ok: true,
    scene: {
      id: spec.id,
      revision: spec.revision,
      units: "m",
      upAxis: "Y",
    },
    nodes: spec.nodes,
    materials: spec.materials,
    assets: spec.assets,
    stats: { tris: 376, verts: 269, materials: 1, nodes: 6 },
    feedback: {
      canUndo: false,
      canRedo: false,
      defaultsAdded: [],
      historyTruncated: false,
    },
  };
}
