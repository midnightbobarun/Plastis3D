// src/editor/buildSnowman.ts — the canned snowman spec (Phase 0, 0-D).
//
// Pure, Node-testable: returns `{ nodes, materials }` for a `build`
// PATCH. No SDK import, no DOM.
//
// Canonical spec (decided in
// docs/planning/stages/ui-ux-fix-decisions-and-follow-ups-2026-11-07.md,
// D-IMPL-01): the skill's recipe is canonical — three spheres, a cone
// hat, and a thin cylinder scarf, ~1.8 m tall. The UI doc's First-run
// section describes "stacked spheres, cone nose, cylinder hat"; the
// cone nose and cylinder hat are NOT in this spec (see D-IMPL-01).
//
// Geometry (stacked, Y-up, meters): base sphere r=0.35 (top 0.70),
// middle sphere r=0.27 (centre 0.97, top 1.24), head sphere r=0.20
// (centre 1.44, top 1.64), scarf cylinder r=0.30 × h=0.05 at the neck
// joint (y=1.24), hat cone r=0.21 × h=0.20 (centre 1.71, tip 1.81).
// Total height 1.81 m — "about 1.8 m".
//
// Materials: the builder lists `m_default` explicitly. A `build`
// without `materials` would keep the scene's current materials (a
// fresh scene already has `m_default` — confirmed against
// plastis3d_scene/mutate.py `_op_build`), but listing it makes the
// payload self-contained and behaves the same against the mock host,
// which has no server-side defaults. Every node references it.
//
// No light/camera in the payload. The view-only fill light illuminates
// the sample; a build never re-adds scene lights or cameras.

import type { MaterialSpec, NodeSpec, PrimitiveSpec } from "../types";

export interface SnowmanSpec {
  nodes: NodeSpec[];
  materials: MaterialSpec[];
}

/**
 * `m_default`: #c8ccd0, metalness 0, roughness 0.6
 * (plastis3d_scene/spec.py `default_material`; mirrored in
 * src/editor/AddMenu.tsx `DEFAULT_MATERIAL` — defined here, not
 * imported, because AddMenu imports the SDK and this module must stay
 * Node-testable).
 */
export const SNOWMAN_DEFAULT_MATERIAL: MaterialSpec = {
  id: "m_default",
  color: "#c8ccd0",
  emissive: "#000000",
  metalness: 0,
  roughness: 0.6,
  opacity: 1,
  doubleSide: false,
};

function meshNode(
  id: string,
  name: string,
  y: number,
  primitive: PrimitiveSpec,
): NodeSpec {
  return {
    id,
    name,
    kind: "mesh",
    transform: { t: [0, y, 0], r: [0, 0, 0], s: [1, 1, 1] },
    parent: null,
    visible: true,
    primitive,
    materialId: "m_default",
  };
}

/** The canned snowman spec for a `build` PATCH. */
export function buildSnowman(): SnowmanSpec {
  return {
    nodes: [
      meshNode("snow_base", "Base", 0.35, {
        type: "sphere",
        radius: 0.35,
        widthSegments: 16,
        heightSegments: 12,
      }),
      meshNode("snow_middle", "Middle", 0.97, {
        type: "sphere",
        radius: 0.27,
        widthSegments: 16,
        heightSegments: 12,
      }),
      meshNode("snow_head", "Head", 1.44, {
        type: "sphere",
        radius: 0.2,
        widthSegments: 16,
        heightSegments: 12,
      }),
      meshNode("snow_scarf", "Scarf", 1.24, {
        type: "cylinder",
        radiusTop: 0.3,
        radiusBottom: 0.3,
        height: 0.05,
        radialSegments: 16,
      }),
      meshNode("snow_hat", "Hat", 1.71, {
        type: "cone",
        radius: 0.21,
        height: 0.2,
        radialSegments: 16,
      }),
    ],
    materials: [{ ...SNOWMAN_DEFAULT_MATERIAL }],
  };
}
