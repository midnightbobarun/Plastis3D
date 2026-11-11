// tests/node/textures.test.ts — Tier 2 texture maps in the view (PR15, C-07, C-08).
//
// The cache (decode once, refcount, evict by decoded pixels, dispose once),
// the slot-to-material binding (including the shared metallic-roughness
// image), colour spaces, the flipY/orientation contract, and the part
// material override. No WebGL: three.js textures are plain objects in Node,
// and the decoder is injected.

import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import { buildSceneGraph, resolveModelSlot } from "../../src/scene/build";
import type { ParsedTemplate } from "../../src/scene/cache";
import {
  CACHE_PIXEL_BUDGET,
  MAX_IMAGE_PIXELS,
  SLOT_COLOR_SPACE,
  TextureCache,
  applyMaterialMaps,
  bindTexture,
  decodeWithBrowser,
  isTextureFailure,
  materialMapSlots,
} from "../../src/scene/textures";
import type { AssetSpec, MaterialSpec, SceneSpec } from "../../src/types";

function asset(id: string, width = 4, height = 4, format = "png"): AssetSpec {
  return {
    id,
    sha256: id.padEnd(64, "0"),
    file: `assets/${id}.png`,
    format,
    bytes: 100,
    originalName: `${id}.png`,
    sourceFormat: format,
    stats: { width, height },
  };
}

function material(id: string, maps: Partial<MaterialSpec> = {}): MaterialSpec {
  return { id, color: "#ffffff", emissive: "#000000", metalness: 0, roughness: 0.6, opacity: 1, doubleSide: false, ...maps };
}

const bytes = async () => new ArrayBuffer(8);

function cacheWith(decoded: { width: number; height: number }[] = [], budget?: number) {
  const closed: number[] = [];
  const decode = vi.fn(async () => {
    const next = decoded.shift() ?? { width: 4, height: 4 };
    const index = closed.length + decode.mock.calls.length;
    return { ...next, close: () => closed.push(index) };
  });
  return { cache: new TextureCache(decode, budget), decode, closed };
}

afterEach(() => vi.restoreAllMocks());

describe("TextureCache", () => {
  it("decodes once however many callers ask at the same time", async () => {
    const { cache, decode } = cacheWith();
    const a = asset("wood");
    const [first, second] = await Promise.all([
      cache.get("src", a, "srgb", bytes),
      cache.get("src", a, "srgb", bytes),
    ]);
    expect(first).toBe(second);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(cache.peek("src", a, "srgb")).toBe(first);
  });

  it("gives colour maps sRGB and data maps no colour space, as two textures of one image", async () => {
    const { cache } = cacheWith();
    const a = asset("wood");
    const srgb = (await cache.get("src", a, "srgb", bytes)) as THREE.Texture;
    const linear = (await cache.get("src", a, "linear", bytes)) as THREE.Texture;
    expect(srgb).not.toBe(linear);
    expect(srgb.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(linear.colorSpace).toBe(THREE.NoColorSpace);
    expect(SLOT_COLOR_SPACE).toEqual({
      baseColorMap: "srgb",
      emissiveMap: "srgb",
      normalMap: "linear",
      metallicRoughnessMap: "linear",
    });
  });

  it("follows the orientation contract: image decoded flipped, texture not flipped, REPEAT wrapping", async () => {
    const { cache } = cacheWith();
    const texture = (await cache.get("src", asset("wood"), "srgb", bytes)) as THREE.Texture;
    expect(texture.flipY).toBe(false);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
    expect(texture.generateMipmaps).toBe(true);
    const bitmap = vi.fn(async () => ({ width: 1, height: 1 }));
    vi.stubGlobal("createImageBitmap", bitmap);
    await decodeWithBrowser(new ArrayBuffer(4), "image/png");
    expect(bitmap).toHaveBeenCalledWith(expect.any(Blob), expect.objectContaining({ imageOrientation: "flipY" }));
    vi.unstubAllGlobals();
  });

  it("refuses an oversize image before fetching a byte", async () => {
    const { cache, decode } = cacheWith();
    const fetchBytes = vi.fn(bytes);
    const result = await cache.get("src", asset("huge", 5000, 100), "srgb", fetchBytes);
    expect(result).toEqual({ failure: "too-large-to-decode" });
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
    // A header that lied: the decoded bitmap is too big, so it is closed and refused.
    const lying = cacheWith([{ width: 9000, height: 9000 }]);
    const out = await lying.cache.get("src", asset("liar"), "srgb", bytes);
    expect(out).toEqual({ failure: "too-large-to-decode" });
    expect(lying.closed).toHaveLength(1);
  });

  it("types a failure, does not cache it, and retries next time", async () => {
    const { cache } = cacheWith();
    const a = asset("wood");
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new ApiError("ASSET_TOO_LARGE", "too big");
      if (calls === 2) throw new Error("network");
      return new ArrayBuffer(8);
    };
    expect(await cache.get("src", a, "srgb", flaky)).toEqual({ failure: "asset-too-large" });
    expect(await cache.get("src", a, "srgb", flaky)).toEqual({ failure: "unavailable" });
    const ok = await cache.get("src", a, "srgb", flaky);
    expect(isTextureFailure(ok)).toBe(false);
  });

  it("disposes a texture exactly once, when the last user lets go of a retired entry", async () => {
    const { cache, closed } = cacheWith();
    const texture = (await cache.get("src", asset("wood"), "srgb", bytes)) as THREE.Texture;
    const dispose = vi.spyOn(texture, "dispose");
    expect(cache.acquire(texture)).toBe(true);
    expect(cache.acquire(texture)).toBe(true);
    cache.clear("src"); // a profile switch retires it while two surfaces still draw it
    expect(dispose).not.toHaveBeenCalled();
    expect(cache.acquire(texture)).toBe(false); // retired entries take no new users
    cache.release(texture);
    expect(dispose).not.toHaveBeenCalled();
    cache.release(texture);
    expect(dispose).toHaveBeenCalledTimes(1);
    cache.release(texture); // a stray release does nothing
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(closed).toHaveLength(1);
  });

  it("a clear() during a decode does not let the late result into the cache", async () => {
    const { cache, closed } = cacheWith();
    const pending = cache.get("src", asset("wood"), "srgb", async () => {
      cache.clear("src");
      return new ArrayBuffer(8);
    });
    expect(await pending).toEqual({ failure: "unavailable" });
    expect(cache.stats().entries).toBe(0);
    expect(closed).toHaveLength(1);
  });

  it("evicts unused entries oldest-first past the pixel budget and never one in use", async () => {
    const side = 100;
    const { cache } = cacheWith(
      [1, 2, 3].map(() => ({ width: side, height: side })),
      2 * side * side, // room for two
    );
    const [a, b, c] = ["a", "b", "c"].map((n) => asset(n, side, side));
    const ta = (await cache.get("src", a, "srgb", bytes)) as THREE.Texture;
    const tb = (await cache.get("src", b, "srgb", bytes)) as THREE.Texture;
    expect(cache.acquire(ta)).toBe(true); // the oldest is in use
    const tc = (await cache.get("src", c, "srgb", bytes)) as THREE.Texture;
    await new Promise((resolve) => setTimeout(resolve, 5)); // the deferred eviction
    expect(cache.peek("src", a, "srgb")).toBe(ta); // in use: kept
    expect(cache.peek("src", b, "srgb")).toBeNull(); // oldest unused: evicted
    expect(cache.peek("src", c, "srgb")).toBe(tc);
    expect(cache.stats().pixels).toBeLessThanOrEqual(2 * side * side);
    expect(tb).toBeDefined();
  });

  it("keeps the idle budget to one full-size image", () => {
    expect(CACHE_PIXEL_BUDGET).toBe(MAX_IMAGE_PIXELS);
  });
});

describe("binding", () => {
  it("binds each slot to the right material property; one image carries both data channels", () => {
    const m = new THREE.MeshStandardMaterial();
    const t = new THREE.Texture();
    bindTexture(m, "baseColorMap", t);
    bindTexture(m, "normalMap", t);
    bindTexture(m, "emissiveMap", t);
    bindTexture(m, "metallicRoughnessMap", t);
    expect([m.map, m.normalMap, m.emissiveMap, m.metalnessMap, m.roughnessMap]).toEqual([t, t, t, t, t]);
    bindTexture(m, "metallicRoughnessMap", null);
    expect(m.metalnessMap).toBeNull();
    expect(m.roughnessMap).toBeNull();
  });

  it("lists only the slots a material fills", () => {
    expect(materialMapSlots(material("m"))).toEqual([]);
    expect(materialMapSlots(material("m", { baseColorMap: "a", normalMap: "b" }))).toEqual([
      ["baseColorMap", "a"],
      ["normalMap", "b"],
    ]);
  });
});

describe("applyMaterialMaps", () => {
  function setup(current = () => true) {
    const { cache } = cacheWith();
    const wood = asset("wood");
    const materials = new Map([["m_wood", new THREE.MeshStandardMaterial()]]);
    const specs = new Map([
      ["m_wood", material("m_wood", { baseColorMap: "wood", emissiveMap: "wood", normalMap: "model" })],
    ]);
    const assets = new Map<string, AssetSpec>([
      ["wood", wood],
      ["model", { ...asset("model"), format: "glb", sourceFormat: "glb" }],
    ]);
    const onBound = vi.fn();
    const run = () =>
      applyMaterialMaps({
        materials,
        materialSpecs: specs,
        assets,
        sourceKey: "src",
        cache,
        fetchBytes: bytes,
        isCurrent: current,
        onBound,
      });
    return { cache, wood, materials, run, onBound };
  }

  it("binds as textures load, skips a non-image asset, and holds what it acquired", async () => {
    const { materials, run, onBound } = setup();
    const applied = run();
    await applied.done;
    const m = materials.get("m_wood")!;
    expect(m.map).toBeInstanceOf(THREE.Texture);
    expect(m.emissiveMap).toBeInstanceOf(THREE.Texture);
    expect(m.normalMap).toBeNull();
    expect(applied.held).toHaveLength(2);
    expect(onBound).toHaveBeenCalledTimes(2);
    // Both slots are colour maps of one image: one decode, one texture.
    expect(m.map).toBe(m.emissiveMap);
  });

  it("binds at once when the texture is already decoded (a rebuild shows no untextured frame)", async () => {
    const { cache, wood, materials, run } = setup();
    await run().done;
    const second = new Map([["m_wood", new THREE.MeshStandardMaterial()]]);
    const m2 = second.get("m_wood")!;
    const applied = applyMaterialMaps({
      materials: second,
      materialSpecs: new Map([["m_wood", material("m_wood", { baseColorMap: "wood" })]]),
      assets: new Map([["wood", wood]]),
      sourceKey: "src",
      cache,
      fetchBytes: bytes,
      isCurrent: () => true,
    });
    expect(m2.map).toBeInstanceOf(THREE.Texture); // before any await
    expect(applied.held).toHaveLength(1);
    expect(materials.size).toBe(1);
  });

  it("binds nothing once its build has been disposed", async () => {
    let current = true;
    const { materials, run } = setup(() => current);
    const applied = run();
    current = false;
    await applied.done;
    expect(materials.get("m_wood")!.map).toBeNull();
    expect(applied.held).toEqual([]);
  });

  it("leaves a material plain when its image cannot be had", async () => {
    const { cache, wood } = setup();
    const m = new THREE.MeshStandardMaterial();
    const applied = applyMaterialMaps({
      materials: new Map([["m", m]]),
      materialSpecs: new Map([["m", material("m", { baseColorMap: "wood" })]]),
      assets: new Map([["wood", wood]]),
      sourceKey: "other",
      cache,
      fetchBytes: async () => {
        throw new Error("offline");
      },
      isCurrent: () => true,
    });
    await applied.done;
    expect(m.map).toBeNull();
    expect(applied.held).toEqual([]);
  });
});

describe("the built scene", () => {
  const scene = (): SceneSpec =>
    ({
      id: "s",
      name: "S",
      revision: 1,
      schema: 1,
      units: "meters",
      up: "Y",
      materials: [material("m_part"), material("m_box", { baseColorMap: "wood" })],
      assets: [
        { ...asset("model"), format: "glb", sourceFormat: "glb" },
        asset("wood"),
      ],
      nodes: [
        { id: "n_box", name: "Box", kind: "mesh", parent: null, visible: true, primitive: { type: "box" }, materialId: "m_box", transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } },
        { id: "n_part", name: "Part", kind: "part", parent: null, visible: true, modelAssetId: "model", meshIndex: 0, primitiveIndex: 0, materialId: "m_part", transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } },
        { id: "n_plain", name: "Plain part", kind: "part", parent: null, visible: true, modelAssetId: "model", meshIndex: 0, primitiveIndex: 0, transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] } },
      ],
      history: { undo: [], redo: [] },
    }) as unknown as SceneSpec;

  it("exposes the view material for every material a node uses", () => {
    const s = scene();
    const built = buildSceneGraph(s, new Map(s.materials.map((m) => [m.id, m])));
    expect([...built.materials.keys()].sort()).toEqual(["m_box", "m_part"]);
  });

  it("draws a part with its override material, and leaves the template's alone", () => {
    const s = scene();
    const built = buildSceneGraph(s, new Map(s.materials.map((m) => [m.id, m])));
    const slot = built.modelSlots.find((x) => x.node.userData.nodeId === "n_part")!;
    const plain = built.modelSlots.find((x) => x.node.userData.nodeId === "n_plain")!;
    expect(slot.material).toBe(built.materials.get("m_part"));
    expect(plain.material).toBeUndefined();

    const templateMaterial = new THREE.MeshStandardMaterial({ color: "#123456" });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), templateMaterial);
    const template = { scene: new THREE.Group(), meshes: [mesh], dispose() {} } as unknown as ParsedTemplate;
    const [overridden] = resolveModelSlot(slot, template) as THREE.Mesh[];
    expect(overridden.material).toBe(slot.material);
    expect(mesh.material).toBe(templateMaterial); // the shared template is untouched
    const [untouched] = resolveModelSlot(plain, template) as THREE.Mesh[];
    expect(untouched.material).toBe(templateMaterial);
  });
});
