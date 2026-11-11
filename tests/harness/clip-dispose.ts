import * as THREE from "three";
import { TemplateCache, isTemplateFailure } from "../../src/scene/cache";
import { disposeBuiltScene, resolveModelSlot } from "../../src/scene/build";
import { ClipPlayer } from "../../src/scene/clipPlayback";
import type { AssetSpec } from "../../src/types";

async function run() {
  const renderer = new THREE.WebGLRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(0, 1, 6);
  renderer.render(scene, camera);
  const baseline = { ...renderer.info.memory };
  const asset = { sha256: "fixture", bytes: 4000, stats: { tris: 5, drawable: true } } as AssetSpec;
  const cache = new TemplateCache();
  const bytes = await (await fetch("/tests/fixtures/skin-clip-morph.glb")).arrayBuffer();
  for (let i = 0; i < 3; i++) {
    const template = await cache.get("source", asset, async () => bytes);
    if (!template || isTemplateFailure(template) || !cache.acquire(template)) throw Error("fixture failed to load");
    const root = new THREE.Group();
    const node = new THREE.Group(); root.add(node); scene.add(root);
    const [clone] = resolveModelSlot({ node, asset }, template);
    const player = new ClipPlayer(clone, template.animations ?? []);
    player.play(); player.update(0.5); renderer.render(scene, camera);
    player.dispose(); scene.remove(root);
    disposeBuiltScene({ root, nodes: new Map(), modelSlots: [], materials: new Map() });
    cache.clear("source"); cache.release(template);
    renderer.render(scene, camera);
  }
  const after = { ...renderer.info.memory };
  renderer.dispose();
  return { baseline, after };
}
run().then((value) => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch((error: unknown) => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
