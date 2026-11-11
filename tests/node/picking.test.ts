import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { decodeMesh, encodeMesh } from "../../src/scene/bake";
import { buildTopology, faceRegion, verticesOf } from "../../src/scene/meshEdit";
import type { EditMesh } from "../../src/scene/meshEdit";
import { accelerate, disposeAccelerated, geometryOf, marquee, nearestEdge, nearestWeld, pickFace, refit } from "../../src/scene/picking";

function boxMesh(): EditMesh {
  const g = new THREE.BoxGeometry(1, 1, 1);
  return { positions: Float32Array.from(g.getAttribute("position").array), normals: Float32Array.from(g.getAttribute("normal").array), uvs: Float32Array.from(g.getAttribute("uv").array), indices: Uint32Array.from(g.getIndex()!.array) };
}

function setup() {
  const data = boxMesh();
  const mesh = new THREE.Mesh(geometryOf(data), new THREE.MeshBasicMaterial());
  accelerate(mesh);
  mesh.updateMatrixWorld(true);
  return { data, mesh, topology: buildTopology(data) };
}

describe("picking on the edit copy", () => {
  it("uses an instance BVH and raycast, never a prototype", () => {
    const before = THREE.Mesh.prototype.raycast;
    const { mesh } = setup();
    expect(THREE.Mesh.prototype.raycast).toBe(before);
    expect(Object.prototype.hasOwnProperty.call(mesh, "raycast")).toBe(true);
    expect((mesh.geometry as unknown as { boundsTree?: unknown }).boundsTree).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(THREE.BufferGeometry.prototype, "computeBoundsTree")).toBe(false);
    expect(new THREE.Mesh().raycast).toBe(before); // other meshes are untouched
  });

  it("a known ray hits the expected face, vertex and edge", () => {
    const { data, mesh, topology } = setup();
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0.4, 5, 0.4), new THREE.Vector3(0, -1, 0));
    const hit = pickFace(mesh, raycaster)!;
    expect(hit.point.y).toBeCloseTo(0.5, 5);
    expect(topology.faceNormals[hit.face * 3 + 1]).toBeCloseTo(1, 5);
    expect(faceRegion(data, topology, hit.face).length).toBe(2);
    const local = mesh.worldToLocal(hit.point.clone());
    const weld = nearestWeld(data, topology, hit.face, local);
    const corner = topology.members[weld][0] * 3;
    expect([data.positions[corner], data.positions[corner + 2]].map(Math.abs)).toEqual([0.5, 0.5]); // the nearest corner of the top face
    const edge = nearestEdge(data, topology, hit.face, new THREE.Vector3(0.5, 0.5, 0.1));
    const [a, b] = topology.edges[edge];
    const ends = [a, b].map((w) => { const v = topology.members[w][0] * 3; return [data.positions[v], data.positions[v + 1], data.positions[v + 2]]; });
    expect(ends.every((p) => Math.abs(p[0] - 0.5) < 1e-6 && Math.abs(p[1] - 0.5) < 1e-6)).toBe(true); // the x = +0.5 top edge
    expect(pickFace(mesh, new THREE.Raycaster(new THREE.Vector3(5, 5, 5), new THREE.Vector3(0, 1, 0)))).toBeNull();
  });

  it("refits after the positions move", () => {
    const { data, mesh } = setup();
    for (let v = 0; v < data.positions.length / 3; v++) data.positions[v * 3 + 1] += 2;
    refit(mesh);
    const hit = pickFace(mesh, new THREE.Raycaster(new THREE.Vector3(0, 9, 0), new THREE.Vector3(0, -1, 0)))!;
    expect(hit.point.y).toBeCloseTo(2.5, 5);
    disposeAccelerated(mesh);
  });

  it("a marquee selects only what it covers and is not fooled by faces in front", () => {
    const { data, mesh, topology } = setup();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const all = marquee(mesh, data, topology, camera, "vertex", { x0: -1, y0: -1, x1: 1, y1: 1 });
    // Looking straight down -z at a cube: the four back corners are hidden behind the front face.
    expect(all.ids.length).toBe(4);
    expect(all.truncated).toBe(false);
    const none = marquee(mesh, data, topology, camera, "vertex", { x0: 0.9, y0: 0.9, x1: 1, y1: 1 });
    expect(none.ids).toEqual([]);
    const faces = marquee(mesh, data, topology, camera, "face", { x0: -0.05, y0: -0.05, x1: 0.05, y1: 0.05 });
    expect(faces.ids.every((f) => topology.faceNormals[f * 3 + 2] > 0.99)).toBe(true);
    expect(verticesOf(data, topology, "vertex", all.ids).size).toBe(12);
  });

  it("the arrays survive the base64 round trip, and malformed drafts are refused", () => {
    const data = boxMesh();
    const encoded = encodeMesh(data);
    const back = decodeMesh(encoded)!;
    expect(Array.from(back.positions)).toEqual(Array.from(data.positions));
    expect(Array.from(back.indices)).toEqual(Array.from(data.indices));
    expect(Array.from(back.uvs!)).toEqual(Array.from(data.uvs!));
    expect(decodeMesh({ ...encoded, indices: encodeMesh({ ...data, indices: Uint32Array.from([0, 1, 999]) }).indices })).toBeNull();
    expect(decodeMesh({ positions: "", normals: "", indices: "" })).toBeNull();
    expect(decodeMesh({ positions: "@@@", normals: "x", indices: "y" })).toBeNull();
    expect(decodeMesh(null)).toBeNull();
  });
});
