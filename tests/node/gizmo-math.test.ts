// tests/node/gizmo-math.test.ts — Tier 2 tests for the GizmoManager's
// pure helpers (Stage 5, PR5). No DOM, no SDK import: the world-delta
// computation the multi-select drag is built on.
//
// The behavioral check is a round-trip through three.js itself: compute
// a local position for a world-space target, apply it, and assert the
// object lands on the target in world space (within float epsilon).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  applyLocal,
  captureLocal,
  quaternionToEulerDegrees,
  transformsEqual,
  worldPositionToLocal,
} from "../../src/gizmos/GizmoManager";

const EPSILON = 1e-9;

describe("worldPositionToLocal", () => {
  it("round-trips through a rotated + translated parent", () => {
    const parent = new THREE.Group();
    parent.position.set(1, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0, "XYZ");
    const child = new THREE.Object3D();
    child.position.set(1, 0, 0);
    parent.add(child);
    parent.updateMatrixWorld(true);

    const world = child.getWorldPosition(new THREE.Vector3());
    const local = worldPositionToLocal(child, world);
    expect(local.x).toBeCloseTo(1, 9);
    expect(local.y).toBeCloseTo(0, 9);
    expect(local.z).toBeCloseTo(0, 9);
  });

  it("a world delta lands on the target world position", () => {
    const parent = new THREE.Group();
    parent.position.set(1, 0, 0);
    parent.rotation.set(0, Math.PI / 2, 0, "XYZ");
    const child = new THREE.Object3D();
    child.position.set(0, 0, 0);
    parent.add(child);
    parent.updateMatrixWorld(true);

    const startWorld = child.getWorldPosition(new THREE.Vector3());
    const delta = new THREE.Vector3(1, 0, 0);
    const targetWorld = startWorld.clone().add(delta);
    const local = worldPositionToLocal(child, targetWorld);
    child.position.copy(local);
    parent.updateMatrixWorld(true);
    const landed = child.getWorldPosition(new THREE.Vector3());
    expect(landed.x).toBeCloseTo(targetWorld.x, 9);
    expect(landed.y).toBeCloseTo(targetWorld.y, 9);
    expect(landed.z).toBeCloseTo(targetWorld.z, 9);
    // The delta is world-space: under a 90-degree Y parent it is NOT
    // the local (1, 0, 0) — it is rotated into the parent's frame.
    expect(local.x).toBeCloseTo(0, 9);
    expect(local.z).toBeCloseTo(1, 9);
  });

  it("returns the world position itself when unparented", () => {
    const obj = new THREE.Object3D();
    const world = new THREE.Vector3(3, 2, 1);
    const local = worldPositionToLocal(obj, world);
    expect(local.x).toBe(3);
    expect(local.y).toBe(2);
    expect(local.z).toBe(1);
  });
});

describe("quaternionToEulerDegrees", () => {
  it("round-trips Euler XYZ degrees", () => {
    const euler = new THREE.Euler(
      (30 * Math.PI) / 180,
      (45 * Math.PI) / 180,
      (60 * Math.PI) / 180,
      "XYZ",
    );
    const q = new THREE.Quaternion().setFromEuler(euler);
    const [x, y, z] = quaternionToEulerDegrees(q);
    expect(x).toBeCloseTo(30, 9);
    expect(y).toBeCloseTo(45, 9);
    expect(z).toBeCloseTo(60, 9);
  });

  it("identity is zero", () => {
    const [x, y, z] = quaternionToEulerDegrees(new THREE.Quaternion());
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
  });
});

describe("captureLocal / applyLocal", () => {
  it("round-trips a transform onto another object", () => {
    const source = new THREE.Object3D();
    source.position.set(1, 2, 3);
    source.rotation.set(0.1, 0.2, 0.3, "XYZ");
    source.scale.set(2, 3, 4);
    const captured = captureLocal(source);
    const target = new THREE.Object3D();
    applyLocal(target, captured);
    expect(target.position.x).toBeCloseTo(1, 9);
    expect(target.position.y).toBeCloseTo(2, 9);
    expect(target.position.z).toBeCloseTo(3, 9);
    expect(target.scale.x).toBeCloseTo(2, 9);
    expect(target.scale.y).toBeCloseTo(3, 9);
    expect(target.scale.z).toBeCloseTo(4, 9);
    const recaptured = captureLocal(target);
    expect(recaptured.r[0]).toBeCloseTo(captured.r[0], 9);
    expect(recaptured.r[1]).toBeCloseTo(captured.r[1], 9);
    expect(recaptured.r[2]).toBeCloseTo(captured.r[2], 9);
  });
});

describe("transformsEqual", () => {
  it("is true for identical transforms and false past epsilon", () => {
    const a = { t: [0, 0, 0] as [number, number, number], r: [0, 0, 0] as [number, number, number], s: [1, 1, 1] as [number, number, number] };
    const same = { ...a, t: [0, 0, 0] as [number, number, number] };
    expect(transformsEqual(a, same)).toBe(true);
    const moved = { ...a, t: [1e-6, 0, 0] as [number, number, number] };
    expect(transformsEqual(a, moved)).toBe(false);
    expect(transformsEqual(a, moved, 1e-5)).toBe(true);
    expect(EPSILON).toBe(1e-9);
  });
});
