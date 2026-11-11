// src/scene/picking.ts — sub-object picking on the edit copy (PR24).
//
// three-mesh-bvh is used on the edit copy ONLY, never for whole-node orbit picking, and
// never by patching a prototype (catalog rule 8): the BVH and the accelerated raycast
// are set on this one geometry and this one mesh instance.
import * as THREE from "three";
import { MeshBVH, acceleratedRaycast } from "three-mesh-bvh";
import type { EditMesh, PickMode, Topology } from "./meshEdit";

/** The per-frame budget for picks and drags (ms). Marquee and pick work stops at it. */
export const FRAME_BUDGET_MS = 8;

export function geometryOf(mesh: EditMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  if (mesh.uvs) geometry.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
  if (mesh.colors) geometry.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 4));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  return geometry;
}

/** Give one mesh instance its own BVH and accelerated raycast. No prototype is touched. */
export function accelerate(mesh: THREE.Mesh): void {
  const geometry = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
  geometry.boundsTree = new MeshBVH(geometry);
  mesh.raycast = acceleratedRaycast as unknown as THREE.Mesh["raycast"];
}

/** After positions changed in place: update the attributes and refit the existing BVH. */
export function refit(mesh: THREE.Mesh): void {
  const geometry = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
  geometry.attributes.position.needsUpdate = true;
  geometry.attributes.normal.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundsTree?.refit();
}

export function disposeAccelerated(mesh: THREE.Mesh): void {
  const geometry = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
  geometry.boundsTree = undefined;
  geometry.dispose();
}

export interface FaceHit { face: number; point: THREE.Vector3 }

/** The nearest triangle under the raycaster, or null. */
export function pickFace(mesh: THREE.Mesh, raycaster: THREE.Raycaster): FaceHit | null {
  const saved = raycaster.firstHitOnly;
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const hits = raycaster.intersectObject(mesh, false);
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = saved;
  const hit = hits[0];
  if (!hit || hit.faceIndex === undefined || hit.faceIndex === null) return null;
  return { face: hit.faceIndex, point: hit.point.clone() };
}

/** The weld id of the triangle corner nearest a LOCAL-space point. */
export function nearestWeld(mesh: EditMesh, topology: Topology, face: number, local: THREE.Vector3): number {
  let best = -1, bestDistance = Infinity;
  for (let k = 0; k < 3; k++) {
    const v = mesh.indices[face * 3 + k];
    const d = Math.hypot(mesh.positions[v * 3] - local.x, mesh.positions[v * 3 + 1] - local.y, mesh.positions[v * 3 + 2] - local.z);
    if (d < bestDistance) { bestDistance = d; best = topology.weld[v]; }
  }
  return best;
}

/** The edge index of the triangle edge nearest a LOCAL-space point. */
export function nearestEdge(mesh: EditMesh, topology: Topology, face: number, local: THREE.Vector3): number {
  let best = -1, bestDistance = Infinity;
  const p = mesh.positions;
  for (let k = 0; k < 3; k++) {
    const e = topology.faceEdges[face][k];
    if (e < 0) continue;
    const a = mesh.indices[face * 3 + k] * 3, b = mesh.indices[face * 3 + ((k + 1) % 3)] * 3;
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const dx = p[b] - ax, dy = p[b + 1] - ay, dz = p[b + 2] - az;
    const lengthSq = dx * dx + dy * dy + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((local.x - ax) * dx + (local.y - ay) * dy + (local.z - az) * dz) / lengthSq));
    const d = Math.hypot(ax + dx * t - local.x, ay + dy * t - local.y, az + dz * t - local.z);
    if (d < bestDistance) { bestDistance = d; best = e; }
  }
  return best;
}

export interface MarqueeResult { ids: number[]; truncated: boolean }

/**
 * Select inside a screen rectangle (NDC, x/y in -1..1). A welded vertex, edge (both ends) or
 * face (centroid) counts when it projects inside AND the surface in front of it, found
 * through the BVH, does not hide it. Above `OCCLUSION_LIMIT` candidates the occlusion test
 * is skipped (the rectangle then selects through the mesh) and the work stops at the frame
 * budget, reporting `truncated`.
 */
export const OCCLUSION_LIMIT = 4000;
export function marquee(
  mesh: THREE.Mesh, editMesh: EditMesh, topology: Topology, camera: THREE.Camera, mode: PickMode,
  rect: { x0: number; y0: number; x1: number; y1: number }, budgetMs = FRAME_BUDGET_MS * 4,
): MarqueeResult {
  const started = performance.now();
  const world = mesh.matrixWorld;
  const minX = Math.min(rect.x0, rect.x1), maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1), maxY = Math.max(rect.y0, rect.y1);
  const v = new THREE.Vector3();
  const project = (index: number): THREE.Vector3 | null => {
    v.set(editMesh.positions[index * 3], editMesh.positions[index * 3 + 1], editMesh.positions[index * 3 + 2]).applyMatrix4(world);
    const world3 = v.clone();
    v.project(camera);
    if (v.z < -1 || v.z > 1) return null;
    (v as THREE.Vector3 & { world?: THREE.Vector3 }).world = world3;
    return v;
  };
  const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  const candidates: Array<{ id: number; points: THREE.Vector3[] }> = [];
  let truncated = false;
  const tick = (i: number) => { if ((i & 255) === 0 && performance.now() - started > budgetMs) truncated = true; return truncated; };
  if (mode === "vertex") {
    for (let w = 0; w < topology.members.length; w++) {
      if (tick(w)) break;
      const p = project(topology.members[w][0]);
      if (p && inside(p.x, p.y)) candidates.push({ id: w, points: [(p as THREE.Vector3 & { world: THREE.Vector3 }).world] });
    }
  } else if (mode === "edge") {
    for (let e = 0; e < topology.edges.length; e++) {
      if (tick(e)) break;
      const a = project(topology.members[topology.edges[e][0]][0]);
      const ax = a ? a.x : 0, ay = a ? a.y : 0, aw = a ? (a as THREE.Vector3 & { world: THREE.Vector3 }).world.clone() : null;
      const b = project(topology.members[topology.edges[e][1]][0]);
      if (a && b && inside(ax, ay) && inside(b.x, b.y) && aw) candidates.push({ id: e, points: [aw.clone().add((b as THREE.Vector3 & { world: THREE.Vector3 }).world).multiplyScalar(0.5)] });
    }
  } else {
    const faces = editMesh.indices.length / 3;
    const c = new THREE.Vector3();
    for (let f = 0; f < faces; f++) {
      if (tick(f)) break;
      c.set(0, 0, 0);
      for (let k = 0; k < 3; k++) { const i = editMesh.indices[f * 3 + k]; c.x += editMesh.positions[i * 3] / 3; c.y += editMesh.positions[i * 3 + 1] / 3; c.z += editMesh.positions[i * 3 + 2] / 3; }
      c.applyMatrix4(world);
      const world3 = c.clone();
      c.project(camera);
      if (c.z >= -1 && c.z <= 1 && inside(c.x, c.y)) candidates.push({ id: f, points: [world3] });
    }
  }
  if (candidates.length > OCCLUSION_LIMIT) return { ids: candidates.map((x) => x.id), truncated };
  const raycaster = new THREE.Raycaster();
  (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const ids: number[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if ((i & 63) === 0 && performance.now() - started > budgetMs) { truncated = true; ids.push(...candidates.slice(i).map((x) => x.id)); break; }
    const target = candidates[i].points[0];
    const direction = target.clone().sub(origin);
    const distance = direction.length();
    raycaster.set(origin, direction.normalize());
    raycaster.far = Math.max(0, distance - Math.max(1e-3, distance * 1e-3));
    raycaster.near = 0;
    if (raycaster.intersectObject(mesh, false).length === 0) ids.push(candidates[i].id);
  }
  return { ids, truncated };
}
