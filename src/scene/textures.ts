// src/scene/textures.ts — texture maps in the view (PR15, correctness audit
// C-07 and C-08).
//
// A material's map fields (baseColorMap, normalMap, metallicRoughnessMap,
// emissiveMap) name an image asset (PNG or JPEG). This module fetches the
// bytes through the same byte route the model cache uses, decodes them once
// per (source, image, colour space), and binds them to the view's
// MeshStandardMaterial. It never imports the SDK, so it is testable in Node
// with an injected decoder.
//
// Conventions, shared with the exporter (plastis3d_scene/export_glb.py):
//  * Colour maps (base colour, emissive) are sRGB; data maps (normal,
//    metallic-roughness) are linear, so they get NoColorSpace.
//  * The primitive geometry carries three.js UVs (v up) and the exported file
//    carries glTF UVs (v down). The image is therefore decoded flipped
//    (`imageOrientation: "flipY"`, `texture.flipY = false`), so an upright
//    picture is upright in both. tests/node/primitive-uv.test.ts pins the UV
//    side of that bargain.
//  * Wrapping is RepeatWrapping, the glTF default the export's sampler
//    writes, because the primitive UVs run through the seam instead of
//    restarting at it.
//  * One metallic-roughness image serves both channels, as in glTF: green is
//    roughness and blue is metalness.
//
// Budget (C-07): the decoded pixels the cache holds are bounded, unused
// entries are evicted oldest-first, and every texture is disposed exactly
// once, when nothing holds it. The gateway refuses an image above 4096 x 4096
// (and a scene above four of them), so a header-lying file cannot reach here.

import * as THREE from "three";
import { ApiError } from "../api";
import type { AssetSpec, MaterialSpec } from "../types";

export type MapSlot = "baseColorMap" | "normalMap" | "metallicRoughnessMap" | "emissiveMap";

export const MAP_SLOTS: readonly MapSlot[] = [
  "baseColorMap",
  "normalMap",
  "metallicRoughnessMap",
  "emissiveMap",
];

export type MapColorSpace = "srgb" | "linear";

/** Colour maps are sRGB; data maps are linear. */
export const SLOT_COLOR_SPACE: Record<MapSlot, MapColorSpace> = {
  baseColorMap: "srgb",
  emissiveMap: "srgb",
  normalMap: "linear",
  metallicRoughnessMap: "linear",
};

/** Limits the gateway enforces (spec.py MAX_IMAGE_SIDE / MAX_IMAGE_PIXELS). */
export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_SIDE * MAX_IMAGE_SIDE;
/**
 * Decoded pixels the cache keeps while nothing uses them: one full-size image.
 * A texture a scene still uses is never evicted (the gateway bounds a scene to
 * four full-size images); an unused one stays only while there is room, so
 * choosing the same picture again is instant and clearing it frees the rest.
 */
export const CACHE_PIXEL_BUDGET = MAX_IMAGE_PIXELS;

export interface DecodedImage {
  width: number;
  height: number;
  close?: () => void;
}

export type DecodeImage = (bytes: ArrayBuffer, mimeType: string) => Promise<DecodedImage>;

/** The browser decoder: flipped so geometry UVs (v up) show an upright image. */
export const decodeWithBrowser: DecodeImage = (bytes, mimeType) =>
  createImageBitmap(new Blob([bytes], { type: mimeType }), {
    imageOrientation: "flipY",
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });

export function mimeTypeFor(asset: Pick<AssetSpec, "format">): string {
  return asset.format === "png" ? "image/png" : "image/jpeg";
}

export interface TextureFailure {
  failure: "asset-too-large" | "unavailable" | "too-large-to-decode";
}

export function isTextureFailure(value: THREE.Texture | TextureFailure): value is TextureFailure {
  return "failure" in value;
}

/** The map slots a material uses, with the image asset each names. */
export function materialMapSlots(spec: MaterialSpec): Array<[MapSlot, string]> {
  const out: Array<[MapSlot, string]> = [];
  for (const slot of MAP_SLOTS) {
    const id = spec[slot];
    if (typeof id === "string" && id.length > 0) out.push([slot, id]);
  }
  return out;
}

/** True for a stored image asset (not a model). */
export function isImageAsset(asset: AssetSpec | undefined): asset is AssetSpec {
  return !!asset && (asset.format === "png" || asset.format === "jpeg");
}

/** Point one slot of a view material at a texture (or at none). */
export function bindTexture(
  material: THREE.MeshStandardMaterial,
  slot: MapSlot,
  texture: THREE.Texture | null,
): void {
  switch (slot) {
    case "baseColorMap":
      material.map = texture;
      break;
    case "normalMap":
      material.normalMap = texture;
      break;
    case "metallicRoughnessMap":
      material.metalnessMap = texture;
      material.roughnessMap = texture;
      break;
    case "emissiveMap":
      material.emissiveMap = texture;
      break;
  }
  material.needsUpdate = true;
}

interface Entry {
  texture: THREE.Texture;
  image: DecodedImage;
  pixels: number;
  users: number;
  retired: boolean;
}

export class TextureCache {
  private cache = new Map<string, Entry>();
  private byTexture = new Map<THREE.Texture, Entry>();
  private inFlight = new Map<string, Promise<THREE.Texture | TextureFailure>>();
  private epochs = new Map<string, number>();

  constructor(
    private readonly decode: DecodeImage = decodeWithBrowser,
    private readonly pixelBudget: number = CACHE_PIXEL_BUDGET,
  ) {}

  private key(sourceKey: string, asset: AssetSpec, space: MapColorSpace): string {
    return `${sourceKey}\n${asset.sha256}\n${space}`;
  }

  /** The cached texture, if decoded already (so a rebuild shows it with no gap). */
  peek(sourceKey: string, asset: AssetSpec, space: MapColorSpace): THREE.Texture | null {
    const entry = this.cache.get(this.key(sourceKey, asset, space));
    if (!entry || entry.retired) return null;
    return entry.texture;
  }

  acquire(texture: THREE.Texture): boolean {
    const entry = this.byTexture.get(texture);
    if (!entry || entry.retired) return false;
    entry.users++;
    return true;
  }

  release(texture: THREE.Texture): void {
    const entry = this.byTexture.get(texture);
    if (!entry || entry.users === 0) return;
    entry.users--;
    if (entry.retired && entry.users === 0) this.destroy(entry);
    this.evict();
  }

  private destroy(entry: Entry): void {
    this.byTexture.delete(entry.texture);
    entry.texture.dispose();
    entry.image.close?.();
  }

  private retire(entry: Entry): void {
    entry.retired = true;
    if (entry.users === 0) this.destroy(entry);
  }

  /** Drop unused entries, oldest first, while the decoded pixels exceed the budget. */
  private evict(): void {
    let total = 0;
    for (const entry of this.cache.values()) total += entry.pixels;
    for (const [key, entry] of this.cache) {
      if (total <= this.pixelBudget) break;
      if (entry.users > 0) continue;
      this.cache.delete(key);
      total -= entry.pixels;
      this.destroy(entry);
    }
  }

  /** Cached entries and their summed decoded pixels (for tests and telemetry). */
  stats(): { entries: number; pixels: number } {
    let pixels = 0;
    for (const entry of this.cache.values()) pixels += entry.pixels;
    return { entries: this.cache.size, pixels };
  }

  /**
   * Decode the image on first use. Never throws: a failure is typed, is not
   * cached, and a later call retries.
   */
  async get(
    sourceKey: string,
    asset: AssetSpec,
    space: MapColorSpace,
    fetchBytes: (sha256: string) => Promise<ArrayBuffer>,
  ): Promise<THREE.Texture | TextureFailure> {
    const key = this.key(sourceKey, asset, space);
    const cached = this.cache.get(key);
    if (cached && !cached.retired) {
      this.cache.delete(key);
      this.cache.set(key, cached); // most recently used last
      return cached.texture;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const width = asset.stats?.width;
    const height = asset.stats?.height;
    if (
      typeof width === "number" &&
      typeof height === "number" &&
      (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)
    ) {
      return { failure: "too-large-to-decode" }; // refused before any bytes are fetched
    }

    const epoch = this.epochs.get(sourceKey) ?? 0;
    this.epochs.set(sourceKey, epoch);
    let task!: Promise<THREE.Texture | TextureFailure>;
    task = (async (): Promise<THREE.Texture | TextureFailure> => {
      let image: DecodedImage | null = null;
      try {
        const bytes = await fetchBytes(asset.sha256);
        if (!(bytes instanceof ArrayBuffer)) return { failure: "unavailable" };
        image = await this.decode(bytes, mimeTypeFor(asset));
        if (
          image.width > MAX_IMAGE_SIDE ||
          image.height > MAX_IMAGE_SIDE ||
          image.width * image.height > MAX_IMAGE_PIXELS
        ) {
          image.close?.();
          return { failure: "too-large-to-decode" };
        }
        // A clear() for this source while we decoded: do not resurrect it.
        if ((this.epochs.get(sourceKey) ?? 0) !== epoch) {
          image.close?.();
          return { failure: "unavailable" };
        }
        const texture = new THREE.Texture(image as unknown as THREE.Texture["image"]);
        texture.colorSpace = space === "srgb" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.flipY = false; // the bitmap was decoded flipped (see the header)
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = 4;
        texture.needsUpdate = true;
        texture.userData.assetId = asset.id;
        const entry: Entry = {
          texture,
          image,
          pixels: image.width * image.height,
          users: 0,
          retired: false,
        };
        this.cache.set(key, entry);
        this.byTexture.set(texture, entry);
        // Let waiting consumers acquire before the budget is enforced.
        setTimeout(() => this.evict(), 0);
        return texture;
      } catch (err) {
        image?.close?.();
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

  /** Drop a source's textures (profile switch) or all of them. */
  clear(sourceKey?: string): void {
    const matches = (key: string) => sourceKey === undefined || key.startsWith(`${sourceKey}\n`);
    if (sourceKey === undefined) {
      for (const k of this.epochs.keys()) this.epochs.set(k, (this.epochs.get(k) ?? 0) + 1);
    } else {
      this.epochs.set(sourceKey, (this.epochs.get(sourceKey) ?? 0) + 1);
    }
    for (const key of [...this.inFlight.keys()]) if (matches(key)) this.inFlight.delete(key);
    for (const [key, entry] of [...this.cache.entries()]) {
      if (!matches(key)) continue;
      this.cache.delete(key);
      this.retire(entry);
    }
  }
}

export const sharedTextureCache = new TextureCache();

export interface ApplyMapsOptions {
  materials: ReadonlyMap<string, THREE.MeshStandardMaterial>;
  materialSpecs: ReadonlyMap<string, MaterialSpec>;
  assets: ReadonlyMap<string, AssetSpec>;
  sourceKey: string;
  cache: TextureCache;
  fetchBytes: (sha256: string) => Promise<ArrayBuffer>;
  /** False once the build these materials belong to has been disposed. */
  isCurrent: () => boolean;
  /** Called after a texture is bound, so the view can redraw. */
  onBound?: () => void;
}

export interface AppliedMaps {
  /** Every texture this build acquired; release each when the build is disposed. */
  held: THREE.Texture[];
  /** Settles when every slot has been bound or has failed. */
  done: Promise<void>;
}

/**
 * Bind the textures every built material asks for. A texture already in the
 * cache is bound at once (a rebuild after an edit shows no untextured frame);
 * the rest load in the background. A slot whose image cannot be had is left
 * unbound, so the material keeps its plain colour.
 */
export function applyMaterialMaps(options: ApplyMapsOptions): AppliedMaps {
  const held: THREE.Texture[] = [];
  const pending: Array<Promise<void>> = [];
  const take = (material: THREE.MeshStandardMaterial, slot: MapSlot, texture: THREE.Texture) => {
    if (!options.isCurrent() || !options.cache.acquire(texture)) return;
    held.push(texture);
    bindTexture(material, slot, texture);
    options.onBound?.();
  };
  for (const [id, material] of options.materials) {
    const spec = options.materialSpecs.get(id);
    if (!spec) continue;
    for (const [slot, assetId] of materialMapSlots(spec)) {
      const asset = options.assets.get(assetId);
      if (!isImageAsset(asset)) continue;
      const space = SLOT_COLOR_SPACE[slot];
      const ready = options.cache.peek(options.sourceKey, asset, space);
      if (ready) {
        take(material, slot, ready);
        continue;
      }
      pending.push(
        options.cache
          .get(options.sourceKey, asset, space, options.fetchBytes)
          .then((result) => {
            if (!isTextureFailure(result)) take(material, slot, result);
          }),
      );
    }
  }
  return { held, done: Promise.all(pending).then(() => undefined) };
}
