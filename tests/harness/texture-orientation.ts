import * as THREE from "three";
import { buildPrimitiveGeometry } from "../../src/scene/build";
import { bindTexture, isTextureFailure, TextureCache } from "../../src/scene/textures";
import type { AssetSpec } from "../../src/types";

// An asymmetric fixture catches horizontal/vertical inversions that the old symmetric image missed.
async function run() {
  const source = document.createElement("canvas");
  source.width = source.height = 64;
  const context = source.getContext("2d")!;
  for (const [x, y, color] of [[0, 0, "#f00000"], [32, 0, "#00f000"], [0, 32, "#0000f0"], [32, 32, "#f0f000"]] as const) {
    context.fillStyle = color; context.fillRect(x, y, 32, 32);
  }
  const blob = await new Promise<Blob>(resolve => source.toBlob(value => resolve(value!), "image/png"));
  const bytes = await blob.arrayBuffer();
  const asset: AssetSpec = { id: "orientation", sha256: "orientation", file: "assets/orientation.png", format: "png", sourceFormat: "png", originalName: "orientation.png", bytes: bytes.byteLength, stats: { width: 64, height: 64 } };
  const cache = new TextureCache();
  const texture = await cache.get("orientation", asset, "srgb", async () => bytes);
  if (isTextureFailure(texture)) throw Error("Browser texture decoding failed");
  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  renderer.setSize(128, 128); renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.append(renderer.domElement);
  const material = new THREE.MeshStandardMaterial({ color: "white", roughness: 1, metalness: 0 });
  bindTexture(material, "baseColorMap", texture);
  const geometry = buildPrimitiveGeometry({ type: "box", width: 1, height: 1, depth: 1 });
  const mesh = new THREE.Mesh(geometry, material);
  const scene = new THREE.Scene(); scene.add(mesh, new THREE.AmbientLight(0xffffff, Math.PI));
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  const faces = [
    { name: "+Z", at: [0, 0, 3], up: [0, 1, 0] }, { name: "-Z", at: [0, 0, -3], up: [0, 1, 0] },
    { name: "+X", at: [3, 0, 0], up: [0, 1, 0] }, { name: "-X", at: [-3, 0, 0], up: [0, 1, 0] },
    { name: "+Y", at: [0, 3, 0], up: [0, 0, -1] }, { name: "-Y", at: [0, -3, 0], up: [0, 0, 1] },
  ];
  const results = [];
  try {
    const gl = renderer.getContext();
    for (const face of faces) {
      camera.position.fromArray(face.at); camera.up.fromArray(face.up); camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      const colors = [[48, 48], [80, 48], [48, 80], [80, 80]].map(([x, y]) => {
        const pixel = new Uint8Array(4);
        gl.readPixels(x, 127 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return Array.from(pixel.slice(0, 3));
      });
      results.push({ face: face.name, colors });
    }
  } finally {
    geometry.dispose(); material.dispose(); cache.clear(); renderer.dispose();
  }
  return results;
}

run().then(results => { document.getElementById("result")!.textContent = JSON.stringify({ results }); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
