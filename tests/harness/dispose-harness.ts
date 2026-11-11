// tests/harness/dispose-harness.ts — the Tier 4 dispose testbed.
//
// A dedicated page (dispose.html) that drives the real scene builder
// (src/scene/build.ts — the same code the viewport uses) against a real
// WebGLRenderer under SwiftShader: build the fixture scene, render it,
// dispose it, ten times, and report renderer.info.memory before and
// after. The assertion lives in dispose.spec.ts.
//
// The scene under test also holds persistent resources the loop never
// touches — a GridHelper and the RoomEnvironment PMREM texture, the
// same two the viewport keeps — so the baseline is NON-zero and the
// assertion is "counters return to baseline", NOT absolute zero
// (dispose decrements only resources the test itself created).
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { buildSceneGraph, disposeBuiltScene } from "../../src/scene/build";
import { fixtureSceneSpec } from "./fixture-scene";
import { ContactShadow, InfiniteGrid, SelectionOutline } from "../../src/viewport/stage";

export interface DisposeResult {
  error?: string;
  baselineGeometries?: number;
  baselineTextures?: number;
  baselinePrograms?: number;
  afterGeometries?: number;
  afterTextures?: number;
  afterPrograms?: number;
  builds?: number;
  /** PR32 (C-07): create, use and dispose the stage effects N times. */
  stageCycles?: number;
  afterStageGeometries?: number;
  afterStageTextures?: number;
}

declare global {
  interface Window {
    __plastis3dDispose?: DisposeResult;
  }
}

function report(result: DisposeResult): void {
  window.__plastis3dDispose = result;
  const el = document.getElementById("dispose-result");
  if (el) el.textContent = JSON.stringify(result);
}

async function run(): Promise<void> {
  const mount = document.getElementById("dispose-mount");
  if (!mount) {
    report({ error: "no #dispose-mount element" });
    return;
  }
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch (error) {
    report({
      error: `no WebGL2 context: ${(error as Error).message || String(error)}`,
    });
    return;
  }
  renderer.setSize(800, 600);
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 800 / 600, 0.1, 100);
  camera.position.set(4, 3, 6);
  camera.lookAt(0, 0, 0);

  // Persistent resources, mirroring the viewport: grid + PMREM env.
  const grid = new THREE.GridHelper(10, 10);
  scene.add(grid);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  const spec = fixtureSceneSpec();
  const materialsById = new Map(spec.materials.map((m) => [m.id, m]));

  // Baseline: render once with only the persistent resources.
  renderer.render(scene, camera);
  const baselineGeometries = renderer.info.memory.geometries;
  const baselineTextures = renderer.info.memory.textures;
  const baselinePrograms = renderer.info.programs?.length ?? 0;

  const builds = 10;
  for (let i = 0; i < builds; i++) {
    const built = buildSceneGraph(spec, materialsById);
    scene.add(built.root);
    renderer.render(scene, camera);
    scene.remove(built.root);
    disposeBuiltScene(built);
  }

  // PR32 / C-07: the studio stage effects (infinite grid, contact
  // shadow with its two render targets, selection outline with its
  // mask target) are created, rendered with a built scene, and disposed
  // ten times; the counters must come back to the baseline too.
  const stageCycles = 10;
  for (let i = 0; i < stageCycles; i++) {
    const built = buildSceneGraph(spec, materialsById);
    scene.add(built.root);
    const g = new InfiniteGrid();
    const shadow = new ContactShadow();
    const outline = new SelectionOutline();
    scene.add(g.mesh);
    scene.add(shadow.group);
    g.update(camera, new THREE.Vector3());
    shadow.render(renderer, scene, built.root, [g.mesh]);
    renderer.render(scene, camera);
    outline.render(renderer, scene, camera, [
      { objects: [...built.nodes.values()].slice(0, 2), strength: 1 },
    ]);
    scene.remove(g.mesh);
    scene.remove(shadow.group);
    g.dispose();
    shadow.dispose();
    outline.dispose();
    scene.remove(built.root);
    disposeBuiltScene(built);
  }
  renderer.render(scene, camera);
  const afterStageGeometries = renderer.info.memory.geometries;
  const afterStageTextures = renderer.info.memory.textures;

  // Settle with one final render of the persistent scene only.
  renderer.render(scene, camera);
  report({
    stageCycles,
    afterStageGeometries,
    afterStageTextures,
    baselineGeometries,
    baselineTextures,
    baselinePrograms,
    afterGeometries: renderer.info.memory.geometries,
    afterTextures: renderer.info.memory.textures,
    afterPrograms: renderer.info.programs?.length ?? 0,
    builds,
  });

  // Clean up (the page is done; the result is already reported).
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
  envRT.dispose();
  pmrem.dispose();
  renderer.dispose();
}

void run();
