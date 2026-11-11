// src/types.ts — TypeScript types mirroring the scene JSON (schema 1).
//
// Source of truth is the Python side: plastis3d_scene/spec.py (Node,
// Material, Asset, AssetStats, AssetPartStats, Transform, Primitive,
// Light, Camera) and dashboard/plugin_api.py (list / envelope shapes).
// These types are kept in sync BY HAND; if the Python schema changes,
// update this file in the same PR. Any divergence found while writing
// this file is noted at the bottom.
//
// Conventions carried over from spec.py:
//   - Rotation is Euler XYZ in degrees, three.js Euler order "XYZ"
//     (R = Rx * Ry * Rz).
//   - Node/material ids match ^[A-Za-z][A-Za-z0-9_-]{0,63}$; scene ids
//     match ^[a-z0-9-]{1,64}$ (enforced server-side, not here).
//   - A Primitive is FLAT in JSON: { type: "box", width: 1, ... } —
//     the params live on the object itself, not under a `params` key
//     (Primitive.to_dict() in spec.py).

export const SCHEMA_VERSION = 3;
export const UNITS = "m";
export const UP_AXIS = "Y";

/** [x, y, z] triple. */
export type Vec3 = [number, number, number];

/** { min, max } axis-aligned bounds, each a [x, y, z] triple. */
export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export interface Transform {
  /** Translation in metres. Default [0, 0, 0]. */
  t: Vec3;
  /** Euler XYZ rotation in degrees. Default [0, 0, 0]. */
  r: Vec3;
  /** Scale. Default [1, 1, 1]. */
  s: Vec3;
}

export type PrimitiveType =
  | "box"
  | "sphere"
  | "cylinder"
  | "cone"
  | "torus"
  | "plane"
  | "capsule";

/**
 * One primitive, flat JSON shape: the type plus its parameters.
 * Parameter names and defaults match PRIMITIVE_DEFAULTS in
 * plastis3d_scene/primitives.py exactly:
 *   box:      width 1, height 1, depth 1
 *   sphere:   radius 0.5, widthSegments 16, heightSegments 12
 *   cylinder: radiusTop 0.5, radiusBottom 0.5, height 1, radialSegments 16
 *   cone:     radius 0.5, height 1, radialSegments 16
 *   torus:    radius 0.5, tube 0.15, radialSegments 12, tubularSegments 24
 *   plane:    width 1, height 1
 *   capsule:  radius 0.25, length 1, capSegments 4, radialSegments 8
 */
export interface PrimitiveSpec {
  type: PrimitiveType;
  width?: number;
  height?: number;
  depth?: number;
  radius?: number;
  radiusTop?: number;
  radiusBottom?: number;
  tube?: number;
  length?: number;
  widthSegments?: number;
  heightSegments?: number;
  radialSegments?: number;
  tubularSegments?: number;
  capSegments?: number;
}

export type LightType = "directional" | "point" | "spot";

export interface LightSpec {
  type: LightType;
  /** CSS hex color, e.g. "#ffffff". Default "#ffffff". */
  color: string;
  /** Default 1.0. */
  intensity: number;
  /** Point/spot only: range in metres. */
  distance?: number;
  /** Point/spot only: physical decay exponent. */
  decay?: number;
  /** Spot only: cone angle in degrees. */
  angle?: number;
  /** Spot only: penumbra 0..1. */
  penumbra?: number;
}

export interface CameraSpec {
  type: "perspective";
  /** Vertical field of view in degrees. Default 40. */
  fov: number;
  /** Default 0.01. */
  near: number;
  /** Default 500. */
  far: number;
}

export type ClipChannelTarget = "translation" | "rotation" | "scale";

export interface ClipChannel {
  target: ClipChannelTarget;
  /** Times in seconds, strictly increasing and >= 0. */
  times: number[];
  /** One vec3 per time; rotation values are Euler XYZ degrees. */
  values: Vec3[];
}

export interface Clip {
  id?: string;
  name?: string;
  duration?: number;
  channels: ClipChannel[];
}

export type NodeKind = "group" | "mesh" | "light" | "camera" | "model" | "part" | "splat";

export interface NodeSpec {
  id: string;
  name: string;
  kind: NodeKind;
  transform: Transform;
  /** Parent node id, or null for a scene root. */
  parent: string | null;
  visible: boolean;
  primitive?: PrimitiveSpec;
  materialId?: string;
  light?: LightSpec;
  camera?: CameraSpec;
  /** Model/part nodes: the asset this node references. */
  modelAssetId?: string;
  splatAssetId?: string;
  /** Part nodes: glTF mesh index within the asset. */
  meshIndex?: number;
  /** Part nodes: primitive index within that glTF mesh. */
  primitiveIndex?: number;
  clips?: Clip[];
  /** Schema 2: how a baked part was made (D-EXT-02). Never drives rendering; the asset does. */
  generator?: { type: string; version: number; params: Record<string, unknown>; baseAssetId?: string };
}

export interface MaterialSpec {
  id: string;
  /** CSS hex color, e.g. "#c8ccd0". */
  color: string;
  name?: string;
  /** CSS hex color. Default "#000000". */
  emissive: string;
  /** Default 0.0. */
  metalness: number;
  /** Default 0.6. */
  roughness: number;
  /** Default 1.0. */
  opacity: number;
  /** Default false. */
  doubleSide: boolean;
  /** Texture maps (PR15): asset ids, optional. */
  baseColorMap?: string;
  normalMap?: string;
  metallicRoughnessMap?: string;
  emissiveMap?: string;
}

/** Per-part bounds for one mesh primitive (editable-imports plan §2). */
export interface AssetPartStats {
  meshIndex: number;
  primitiveIndex: number;
  tris: number;
  verts: number;
  bounds: Bounds;
}

/**
 * Descriptive stats for an imported asset. All keys optional; the
 * agent never authors stats (import_model does, PR7). `stats` is the
 * one open object in the closed schema: it may grow descriptive keys
 * without a schema bump.
 */
export interface AssetStats {
  tris?: number | null;
  verts?: number | null;
  materials?: number | null;
  meshes?: number | null;
  clips?: number | null;
  skins?: number | null;
  bounds?: Bounds | null;
  ignored?: string[];
  internals?: string[];
  /** False (or tris null) means the view must not call GLTFLoader. */
  drawable?: boolean | null;
  parts?: AssetPartStats[];
  /** Image assets (PR15): pixel size read from the header. */
  width?: number;
  height?: number;
}

export interface AssetSpec {
  id: string;
  sha256: string;
  file: string;
  format: string;
  bytes: number;
  originalName: string;
  sourceFormat: string;
  stats: AssetStats;
}

export interface HistoryEntry {
  label: string;
  at: string;
  undo?: Record<string, unknown>;
  redo?: Record<string, unknown>;
}

export interface SceneSpec {
  schema: number;
  id: string;
  name: string;
  revision: number;
  units: string;
  upAxis: string;
  createdAt: string;
  updatedAt: string;
  nodes: NodeSpec[];
  materials: MaterialSpec[];
  assets: AssetSpec[];
  history?: {
    undo: HistoryEntry[];
    redo: HistoryEntry[];
    limit: number;
  };
}

/** One row of GET /scenes. */
export interface SceneSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  /** PR14: the revision the stored thumbnail shows, or null when there is none. */
  thumbnailRevision?: number | null;
}

/** Scene stats as computed by spec.compute_stats. */
export interface SceneStats {
  tris: number;
  verts: number;
  materials: number;
  nodes: number;
}

/** The feedback envelope returned by GET /scenes/{id} (and every
 * successful tool/route result). See spec.FeedbackEnvelope. */
export interface SceneEnvelope {
  ok: true;
  scene: {
    id: string;
    revision: number;
    units: string;
    upAxis: string;
    /**
     * Schema version of the scene document (PR6: the envelope carries
     * it so a reader can see the version before parsing). Optional:
     * older envelopes predate it. A reader refuses a newer schema
     * with SCHEMA_NEWER instead of stripping fields it does not
     * understand (standalone-editor.md "Schema evolution").
     */
    schema?: number;
  };
  nodes: NodeSpec[];
  materials: MaterialSpec[];
  assets: AssetSpec[];
  stats: SceneStats;
  feedback: {
    canUndo: boolean;
    canRedo: boolean;
    defaultsAdded: string[];
    historyTruncated: boolean;
  };
}

// ---------------------------------------------------------------------------
// Divergences from spec.py found while writing this file: none.
//   - Light.decay is Optional[int] in Python; typed as number here
//     (three.js accepts a float; the value is passed through as-is).
//   - AssetStats fields are Optional[...] in Python and omitted from
//     to_dict() when None; typed as `T | null` optional here so both
//     the omitted and explicit-null JSON shapes are accepted.
//   - Python Primitive carries params in a dict and flattens them in
//     to_dict(); PrimitiveSpec above is the flattened JSON shape.
// ---------------------------------------------------------------------------
