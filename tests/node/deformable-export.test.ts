// tests/node/deformable-export.test.ts — Tier 3 loader acceptance (PR13).
//
// tests/fixtures/deformable-export.glb is what the Python exporter writes for
// two locked instances of a rig (one two-bone skin, one clip with a bone
// rotation and a morph-weights channel, one morph target); see
// tests/fixtures/make_skin_clip_morph_glb.py. GLTFLoader must accept it and
// hand back what PR13 promises survives export: a skeleton per instance, a
// playable clip per instance, and the morph target with its weight.
//
// Loader acceptance, not a glTF conformance claim.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";

async function load(name: string): Promise<GLTF> {
  const bytes = readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new GLTFLoader().parseAsync(copy.buffer, "");
}

function all<T extends THREE.Object3D>(gltf: GLTF, test: (o: THREE.Object3D) => boolean): T[] {
  const found: T[] = [];
  gltf.scene.traverse((o) => {
    if (test(o)) found.push(o as T);
  });
  return found;
}

describe("the exported deformable rig loads in GLTFLoader", () => {
  // GLTFLoader makes node names unique, so the second instance's copies of
  // "bone0", "bone1" and "Morpher" arrive as "bone0_1", "bone1_1", "Morpher_1".

  it("keeps one skeleton per instance, with both bones", async () => {
    const gltf = await load("deformable-export.glb");
    const skinned = all<THREE.SkinnedMesh>(gltf, (o) => (o as THREE.SkinnedMesh).isSkinnedMesh);
    expect(skinned).toHaveLength(2);
    const boneNames = skinned.map((m) => m.skeleton.bones.map((b) => b.name));
    expect(boneNames).toContainEqual(["bone0", "bone1"]);
    expect(boneNames).toContainEqual(["bone0_1", "bone1_1"]);
    // Two instances: the skeletons do not share bone objects.
    expect(new Set(skinned.flatMap((m) => m.skeleton.bones)).size).toBe(4);
  });

  it("keeps one clip per instance, each animating its own instance only", async () => {
    const gltf = await load("deformable-export.glb");
    expect(gltf.animations).toHaveLength(2);
    expect(gltf.animations.map((clip) => clip.name)).toEqual(["[2:0] Rig A / bend", "[3:0] Rig B / bend"]);
    expect(new Set(gltf.animations.map((clip) => clip.name)).size).toBe(2);
    for (const clip of gltf.animations) {
      expect(clip.duration).toBeCloseTo(1, 5);
      expect(clip.tracks).toHaveLength(2);
    }
    const targets = gltf.animations.map((clip) => clip.tracks.map((t) => t.name).sort());
    expect(targets).toContainEqual(["Morpher.morphTargetInfluences", "bone1.quaternion"]);
    expect(targets).toContainEqual(["Morpher_1.morphTargetInfluences", "bone1_1.quaternion"]);

    // Play only the second instance's clip to its end: its bone bends and the
    // first instance's bone stays at rest.
    const second = gltf.animations[targets.findIndex((t) => t[1] === "bone1_1.quaternion")];
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const named = THREE.AnimationClip.findByName(gltf.animations, second.name)!;
    expect(named).toBe(second);
    const action = mixer.clipAction(named);
    action.setLoop(THREE.LoopOnce, 1); // a repeating clip wraps to 0 at its end
    action.clampWhenFinished = true;
    action.play();
    mixer.setTime(1);
    const first = gltf.scene.getObjectByName("bone1")!;
    const other = gltf.scene.getObjectByName("bone1_1")!;
    expect(other.quaternion.z).toBeCloseTo(Math.sin(0.25), 4);
    expect(first.quaternion.z).toBeCloseTo(0, 6);
  });

  it("keeps the morph target and its starting weight", async () => {
    const gltf = await load("deformable-export.glb");
    const morphers = all<THREE.Mesh>(
      gltf,
      (o) => (o as THREE.Mesh).isMesh && !!(o as THREE.Mesh).morphTargetInfluences,
    );
    expect(morphers).toHaveLength(2);
    for (const mesh of morphers) {
      expect(mesh.morphTargetInfluences).toEqual([0.5]);
      const target = mesh.geometry.morphAttributes.position;
      expect(target).toHaveLength(1);
      expect(Array.from(target![0].array.slice(0, 3))).toEqual([0, 0, 1]);
    }
  });

  it("places the second instance where the scene put it", async () => {
    const gltf = await load("deformable-export.glb");
    const b = gltf.scene.getObjectByName("Rig_B")!;
    expect(b.position.x).toBe(5);
    expect(gltf.scene.getObjectByName("Rig_A")!.position.x).toBe(0);
  });
});
