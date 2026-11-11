import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, it } from "vitest";

it("exported follow-path motion agrees in world space under sheared ancestor frames", async () => {
  const bytes = Uint8Array.from(readFileSync(new URL("../fixtures/follow-path.glb", import.meta.url)));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, "");
  const rail = gltf.scene.getObjectByName("Rail")!, rider = gltf.scene.getObjectByName("Rider")!;
  expect(rail).toBeDefined(); expect(rider).toBeDefined();
  expect(gltf.animations).toHaveLength(1);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations[0]);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  for (const t of [0, 0.25, 0.5, 0.75, 1, 1.5, 2]) {
    mixer.setTime(t); gltf.scene.updateMatrixWorld(true);
    const expected = new THREE.Vector3(t - 1, 0, 0).applyMatrix4(rail.matrixWorld);
    const actual = rider.getWorldPosition(new THREE.Vector3());
    expect(actual.distanceTo(expected)).toBeLessThan(5e-6);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
});
