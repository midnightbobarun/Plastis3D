// tests/node/weld-loader.test.ts — Tier 3 loader acceptance for a welded asset (PR19).
//
// tests/fixtures/weld-source.glb is two quads with a UV seam on their shared
// edge and one degenerate triangle; weld-result.glb is what the Python weld
// makes of it (tests/fixtures/make_welded_glb.py). GLTFLoader must accept the
// result, and the result must keep what the weld promises: the seam, the
// attributes, the shape, and no degenerate triangle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";

async function load(name: string): Promise<THREE.Mesh> {
  const bytes = readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const gltf = await new GLTFLoader().parseAsync(copy.buffer, "");
  let mesh: THREE.Mesh | undefined;
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) mesh = o as THREE.Mesh;
  });
  return mesh!;
}

const triangles = (m: THREE.Mesh) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;

describe("the welded fixture loads in GLTFLoader and keeps what a weld promises", () => {
  it("the source is unindexed with duplicates and a degenerate triangle", async () => {
    const source = await load("weld-source.glb");
    expect(source.geometry.attributes.position.count).toBe(15);
    expect(source.geometry.index).toBeNull();
    expect(triangles(source)).toBe(5);
  });

  it("the result has merged duplicates, an index, and no degenerate triangle", async () => {
    const result = await load("weld-result.glb");
    expect(result.geometry.attributes.position.count).toBe(8);
    expect(result.geometry.index?.count).toBe(12);
    expect(triangles(result)).toBe(4);
    const box = new THREE.Box3().setFromBufferAttribute(result.geometry.attributes.position as THREE.BufferAttribute);
    expect(box.min.toArray()).toEqual([0, 0, 0]);
    expect(box.max.toArray()).toEqual([2, 1, 0]); // the far degenerate corner (5, 5, 5) is gone
    expect(result.geometry.attributes.normal).toBeDefined();
    expect(result.geometry.attributes.uv).toBeDefined();
  });

  it("the UV seam survived: two vertices share a position but not a UV", async () => {
    const result = await load("weld-result.glb");
    const position = result.geometry.attributes.position;
    const uv = result.geometry.attributes.uv;
    const onSeam: number[] = [];
    for (let i = 0; i < position.count; i++) {
      if (position.getX(i) === 1 && position.getY(i) === 0) onSeam.push(uv.getX(i));
    }
    expect(onSeam.sort()).toEqual([0, 1]);
  });

  it("every triangle of the result has area", async () => {
    const result = await load("weld-result.glb");
    const p = result.geometry.attributes.position;
    const index = result.geometry.index!;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let t = 0; t < index.count; t += 3) {
      a.fromBufferAttribute(p, index.getX(t));
      b.fromBufferAttribute(p, index.getX(t + 1));
      c.fromBufferAttribute(p, index.getX(t + 2));
      expect(new THREE.Triangle(a, b, c).getArea()).toBeGreaterThan(1e-9);
    }
  });
});
