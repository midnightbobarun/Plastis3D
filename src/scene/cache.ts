// src/scene/cache.ts — parsed-GLB template cache (Stage 4, PR4 §4.1;
// the cache half is the PR7 split — see stage-3.md §3 — landed here
// because the builder needs it for model/part slots).
//
// One parsed template per sourceKey + sha256; clones come from
// resolveModelSlot (build.ts), never by re-parsing. The template is
// not in any scene.
//
// Draw-cap gate: GLTFLoader is called ONLY when
//   asset.stats.drawable === true AND asset.stats.tris is a number
//   <= DRAW_CAP_TRIS (100,000).
// Above the cap, tris null, or drawable false, get() returns null and
// the caller shows stats + bounds instead (see bounds.ts) — it never
// calls GLTFLoader and never throws out of get(). A fetch/parse
// failure returns a typed failure instead of null (G-13):
// { failure: "asset-too-large" } for a 413 ASSET_TOO_LARGE,
// { failure: "unavailable" } for anything else — so the caller can
// blame the byte route, never the triangle cap. Failures are not
// cached; a later retry re-fetches.
//
// The 100,000-triangle cap is PROVISIONAL (stage-4 §2): the number was
// invented, not measured — PR1 did not replace it with the largest mesh
// that orbits without freezing the shell. It is recorded here as
// DRAW_CAP_TRIS so the measurement PR can replace it in one place.
//
// This module MUST NOT import @hermes/plugin-sdk. The bytes come from
// the caller-supplied fetchBytes (in the pane: api.getAssetBytes bound
// to ctx.rest), so this cache stays testable in Node.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AssetSpec } from "../types";
import { ApiError } from "../api";
import { DRAW_CAP_TRIS } from "./build";

export { DRAW_CAP_TRIS };

/**
 * The draw-cap gate, as a pure function of the asset stats (G-13):
 * the single source of truth for why an asset is not fetched. get()
 * uses it, and the caller (Viewport resolveModelSlots) uses it to
 * classify a null return into the overlay reason. Order matters:
 * over-cap first (a number above the cap), then tris null (not
 * triangles — the import path nulls tris exactly when a primitive is
 * not TRIANGLES), then drawable false.
 */
export type TemplateGateReason = "over-cap" | "not-triangles" | "not-drawable";

export function templateGate(asset: AssetSpec): TemplateGateReason | null {
  const stats = asset.stats ?? {};
  const tris = stats.tris;
  if (typeof tris === "number" && Number.isFinite(tris) && tris > DRAW_CAP_TRIS) {
    return "over-cap";
  }
  if (typeof tris !== "number" || !Number.isFinite(tris)) {
    return "not-triangles";
  }
  if (stats.drawable !== true) return "not-drawable";
  return null;
}

/**
 * A typed fetch failure (G-13): the failure kind survives the cache
 * instead of collapsing to null, so the caller can tell a 413
 * byte-route refusal (ASSET_TOO_LARGE) from any other fetch/parse
 * failure. A failure is NOT cached as a template and NOT cached as
 * null — the in-flight entry is dropped in `finally`, so a later
 * retry re-fetches.
 */
export interface TemplateFailure {
  failure: "asset-too-large" | "unavailable";
}

export function isTemplateFailure(
  value: ParsedTemplate | TemplateFailure | null,
): value is TemplateFailure {
  return value !== null && "failure" in value;
}

/** One parsed GLB template, owned by the cache. */
export interface ParsedTemplate {
  /** The parsed glTF scene (never parented into a built scene). */
  scene: THREE.Group;
  /** Animation clips are immutable and shared; mixers belong to clones. */
  animations?: THREE.AnimationClip[];
  /** Every THREE.Mesh in traversal order. */
  meshes: THREE.Mesh[];
  /**
   * One entry per meshes[] element: the glTF (meshIndex,
   * primitiveIndex) that produced it, read from the loader's
   * parser.associations. Absent when the parse did not expose
   * associations (then resolveModelSlot falls back to traversal-order
   * indexing by meshIndex).
   */
  primitiveMap?: Array<{ meshIndex: number; primitiveIndex: number }>;
  /** Free the template's geometries/materials. Call only when no
   * built scene still clones from it (the last surface disposes). */
  dispose(): void;
}

function disposeTemplate(template: ParsedTemplate): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  template.scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry as THREE.BufferGeometry);
    const mat = (mesh as THREE.Mesh).material;
    if (mat) {
      for (const m of Array.isArray(mat) ? mat : [mat]) materials.add(m);
    }
  });
  const textures = new Set<THREE.Texture>();
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
}

export class TemplateCache {
  private cache = new Map<string, ParsedTemplate>();
  private entries = new Map<ParsedTemplate, { users: number; triangles: number; retired: boolean }>();
  private evict(): void {
    let total = [...this.cache.values()].reduce((n, t) => n + (this.entries.get(t)?.triangles ?? 0), 0);
    for (const [key, template] of this.cache) {
      if (total <= 300_000) break;
      const entry = this.entries.get(template)!;
      if (entry.users) continue;
      this.cache.delete(key);
      total -= entry.triangles;
      this.entries.delete(template);
      template.dispose();
    }
  }
  acquire(template: ParsedTemplate): boolean {
    const entry = this.entries.get(template);
    if (!entry || entry.retired) return false;
    entry.users++;
    return true;
  }
  release(template: ParsedTemplate): void {
    const entry = this.entries.get(template);
    if (!entry || entry.users === 0) return;
    entry.users--;
    if (entry.retired && entry.users === 0) {
      this.entries.delete(template);
      template.dispose();
    }
    this.evict();
  }
  private retire(template: ParsedTemplate): void {
    const entry = this.entries.get(template);
    if (!entry) return;
    entry.retired = true;
    if (!entry.users) { this.entries.delete(template); template.dispose(); }
  }
  private inFlight = new Map<
    string,
    Promise<ParsedTemplate | TemplateFailure | null>
  >();
  /** Bumped by clear() so a late in-flight parse cannot resurrect a
   * purged entry (e.g. after a sourceKey switch). */
  private epochs = new Map<string, number>();

  private key(sourceKey: string, sha256: string): string {
    return `${sourceKey}\n${sha256}`;
  }

  /**
   * Return the parsed template for (sourceKey, asset.sha256), parsing
   * it on first use. Returns null when the asset is over the draw cap,
   * not drawable, or tris is null (the gate — see templateGate); a
   * typed failure when the bytes could not be fetched or parsed
   * (`asset-too-large` for a 413 ASSET_TOO_LARGE, `unavailable`
   * otherwise). Never throws.
   */
  async get(
    sourceKey: string,
    asset: AssetSpec,
    fetchBytes: (sha256: string) => Promise<ArrayBuffer>,
  ): Promise<ParsedTemplate | TemplateFailure | null> {
    if (templateGate(asset) !== null) {
      return null;
    }
    const key = this.key(sourceKey, asset.sha256);
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached; }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const epoch = this.epochs.get(sourceKey) ?? 0;
    this.epochs.set(sourceKey, epoch);
    let task!: Promise<ParsedTemplate | TemplateFailure | null>;
    task = (async (): Promise<ParsedTemplate | TemplateFailure | null> => {
      try {
        const bytes = await fetchBytes(asset.sha256);
        if (!(bytes instanceof ArrayBuffer)) return { failure: "unavailable" };
        const loader = new GLTFLoader();
        const gltf = await loader.parseAsync(bytes, "");
        const meshes: THREE.Mesh[] = [];
        gltf.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
        });
        const template: ParsedTemplate = {
          scene: gltf.scene,
          animations: gltf.animations,
          meshes,
          dispose: () => disposeTemplate(template),
        };
        // Record which glTF (mesh, primitive) each traversal-order mesh
        // came from, when the parser exposes it (three 0.180:
        // parser.associations maps Mesh -> { meshes, primitives }).
        const associations = (
          gltf as unknown as {
            parser?: {
              associations?: Map<
                THREE.Object3D,
                { meshes?: number; primitives?: number }
              >;
            };
          }
        ).parser?.associations;
        if (associations) {
          const map: Array<{ meshIndex: number; primitiveIndex: number }> = [];
          let complete = true;
          for (const mesh of meshes) {
            const entry = associations.get(mesh);
            if (
              entry === undefined ||
              typeof entry.meshes !== "number" ||
              typeof entry.primitives !== "number"
            ) {
              complete = false;
              break;
            }
            map.push({ meshIndex: entry.meshes, primitiveIndex: entry.primitives });
          }
          if (complete) template.primitiveMap = map;
        }
        // A clear() for this sourceKey while the parse was in flight
        // means the caller no longer wants this template (profile
        // switch): drop it instead of caching a stale entry.
        if ((this.epochs.get(sourceKey) ?? 0) !== epoch) {
          template.dispose();
          return { failure: "unavailable" };
        }
        this.cache.set(key, template);
        this.entries.set(template, { users: 0, triangles: asset.stats.tris ?? 0, retired: false });
        // Allow waiting consumers to acquire before enforcing the budget.
        setTimeout(() => this.evict(), 0);
        return template;
      } catch (err) {
        // Fetch failure, malformed GLB, or a loader error (including
        // the gateway's 501 until PR7): no template, no throw. A 413
        // ASSET_TOO_LARGE keeps its kind so the caller can blame the
        // byte route, never the triangle cap.
        if (err instanceof ApiError && err.code === "ASSET_TOO_LARGE") {
          return { failure: "asset-too-large" };
        }
        return { failure: "unavailable" };
      } finally {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Drop cached templates. With no argument, drops everything; with a
   * sourceKey, drops only that source's templates (profile switch must
   * purge the old source immediately — stage-4 §6.1). Disposes the
   * dropped templates; in-flight parses for the cleared source resolve
   * to null instead of caching.
   */
  clear(sourceKey?: string): void {
    if (sourceKey === undefined) {
      this.inFlight.clear();
      for (const template of this.cache.values()) this.retire(template);
      this.cache.clear();
      for (const key of this.epochs.keys()) {
        this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1);
      }
      return;
    }
    this.epochs.set(sourceKey, (this.epochs.get(sourceKey) ?? 0) + 1);
    for (const key of this.inFlight.keys()) if (key.startsWith(`${sourceKey}\n`)) this.inFlight.delete(key);
    for (const [key, template] of [...this.cache.entries()]) {
      if (key.startsWith(`${sourceKey}\n`)) {
        this.retire(template);
        this.cache.delete(key);
      }
    }
  }
}

export const sharedTemplateCache = new TemplateCache();
