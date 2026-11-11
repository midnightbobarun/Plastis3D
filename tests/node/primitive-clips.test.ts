import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { capturePrimitiveKey, primitiveClips, validPrimitiveClips } from "../../src/scene/primitiveClips";
import type { Clip } from "../../src/types";

const clip: Clip = { duration: 2, channels: [
  { target: "translation", times: [0, 1], values: [[0, 0, 0], [2, 0, 0]] },
  { target: "rotation", times: [0, 1], values: [[0, 0, 0], [0, 90, 0]] },
] };
describe("primitive clip playback", () => {
  it("samples translation linearly and rotations with quaternion slerp", () => {
    const root = new THREE.Group();
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(primitiveClips([clip])[0]);
    action.play(); mixer.update(0.5);
    expect(root.position.x).toBeCloseTo(1);
    expect(root.quaternion.angleTo(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 4, 0)))).toBeCloseTo(0);
    mixer.stopAllAction(); mixer.uncacheRoot(root);
  });
  it("preserves an authored full turn through intermediate rotation keys", () => {
    const spin: Clip = { duration: 4, channels: [{ target: "rotation", times: [0, 1, 2, 3, 4], values: [[0,0,0], [0,90,0], [0,180,0], [0,270,0], [0,360,0]] }] };
    expect(validPrimitiveClips([spin])).toBe(true);
    const root = new THREE.Group();
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(primitiveClips([spin])[0]).play();
    mixer.update(1.5);
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, THREE.MathUtils.degToRad(135), 0));
    expect(root.quaternion.clone().normalize().angleTo(expected)).toBeLessThan(0.0001);
    mixer.stopAllAction();
  });
  it("matches sampled motion after GLB export and re-import", async () => {
    const bytes = Uint8Array.from(readFileSync(new URL("../fixtures/primitive-clip.glb", import.meta.url)));
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer, "");
    expect(gltf.animations).toHaveLength(1);
    expect(gltf.animations[0].duration).toBeCloseTo(2);
    const loadedNode = gltf.scene.getObjectByName("AnimatedBox")!;
    const exportedMixer = new THREE.AnimationMixer(gltf.scene);
    exportedMixer.clipAction(gltf.animations[0]).play();
    const viewNode = new THREE.Group();
    const viewMixer = new THREE.AnimationMixer(viewNode);
    viewMixer.clipAction(primitiveClips([clip])[0]).play();
    for (const delta of [0.25, 0.25, 0.5, 0.5]) {
      exportedMixer.update(delta); viewMixer.update(delta);
      expect(loadedNode.position.distanceTo(viewNode.position)).toBeLessThan(0.0001);
      expect(loadedNode.quaternion.clone().normalize().angleTo(viewNode.quaternion.clone().normalize())).toBeLessThan(0.0001);
    }
    exportedMixer.stopAllAction(); viewMixer.stopAllAction();
  });
  it("rejects invalid legacy key data and captures without changing its source", () => {
    expect(validPrimitiveClips([clip])).toBe(true);
    const bad = structuredClone(clip); bad.channels[0].times = [0, 0];
    expect(validPrimitiveClips([bad])).toBe(false);
    const ambiguous = structuredClone(clip); ambiguous.channels[1].values[1] = [90, 90, 90];
    expect(validPrimitiveClips([ambiguous])).toBe(false);
    const root = new THREE.Group(); root.position.x = 3;
    const captured = capturePrimitiveKey([clip], 0, root, 0.5);
    expect(captured[0].channels[0].times).toEqual([0, 0.5, 1]);
    expect(captured[0].channels[0].values[1]).toEqual([3, 0, 0]);
    expect(clip.channels[0].times).toEqual([0, 1]);
  });
});
