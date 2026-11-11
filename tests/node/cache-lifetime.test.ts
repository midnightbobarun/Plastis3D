import { expect, it, vi } from "vitest";
import * as THREE from "three";
const pending = vi.hoisted(() => ({ parse: null as null | (() => void), dispose: vi.fn() }));
vi.mock("three/addons/loaders/GLTFLoader.js", () => ({ GLTFLoader: class {
  async parseAsync() {
    await new Promise<void>((resolve) => { pending.parse = resolve; });
    const scene = new THREE.Group();
    const geometry = new THREE.BufferGeometry();
    geometry.dispose = pending.dispose;
    scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    return { scene };
  }
} }));
import { TemplateCache, isTemplateFailure } from "../../src/scene/cache";
import type { AssetSpec } from "../../src/types";
const asset = { sha256: "a", stats: { drawable: true, tris: 10 } } as AssetSpec;
it("defers clear disposal until the last active clone releases", async () => {
  const cache = new TemplateCache();
  const task = cache.get("source", asset, async () => new ArrayBuffer(0));
  await Promise.resolve(); pending.parse!();
  const result = await task;
  if (!result || isTemplateFailure(result)) throw new Error("parse failed");
  expect(cache.acquire(result)).toBe(true);
  cache.clear("source");
  expect(pending.dispose).not.toHaveBeenCalled();
  cache.release(result);
  expect(pending.dispose).toHaveBeenCalledTimes(1);
});
it("does not publish a parse completed after clear", async () => {
  pending.dispose.mockClear();
  const cache = new TemplateCache();
  const task = cache.get("source", asset, async () => new ArrayBuffer(0));
  await Promise.resolve(); cache.clear(); pending.parse!();
  expect(isTemplateFailure(await task)).toBe(true);
  expect(pending.dispose).toHaveBeenCalledTimes(1);
});

it("evicts unused least-recent templates but keeps active ones", async () => {
  pending.dispose.mockClear();
  const cache = new TemplateCache();
  const held: import("../../src/scene/cache").ParsedTemplate[] = [];
  for (let i = 0; i < 4; i++) {
    const item = { sha256: String(i), stats: { drawable: true, tris: 100000 } } as AssetSpec;
    const task = cache.get("s", item, async () => new ArrayBuffer(0));
    await Promise.resolve(); pending.parse!();
    const template = await task;
    if (!template || isTemplateFailure(template)) throw new Error("parse failed");
    expect(cache.acquire(template)).toBe(true);
    held.push(template);
  }
  cache.release(held[1]);
  expect(pending.dispose).toHaveBeenCalledTimes(1);
  expect(cache.acquire(held[0])).toBe(true);
  cache.clear();
  cache.release(held[0]);
  cache.release(held[0]);
  cache.release(held[2]);
  cache.release(held[3]);
  expect(pending.dispose).toHaveBeenCalledTimes(4);
});
