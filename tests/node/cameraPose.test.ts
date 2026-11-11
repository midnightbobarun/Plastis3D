// tests/node/cameraPose.test.ts — E-09 orbit pose store (Tier 2).
//
// Covers src/state/cameraPose.ts: the pose is per surface (chrome),
// not per scene or source; the two surfaces are independent; the
// default is the reset-view pose; getters and setters copy, so no
// caller can alias the stored pose. The harness test
// (pose-pinning.spec.ts) proves the Viewport restores the stored pose
// across a cold scene switch.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAMERA_POSE,
  getCameraPose,
  setCameraPose,
} from "../../src/state/cameraPose";

describe("cameraPose store", () => {
  it("starts at the reset-view default on both surfaces", () => {
    expect(getCameraPose("editor")).toEqual({
      position: [4, 3, 6],
      target: [0, 0, 0],
    });
    expect(getCameraPose("pane")).toEqual({
      position: [4, 3, 6],
      target: [0, 0, 0],
    });
    expect(DEFAULT_CAMERA_POSE).toEqual({
      position: [4, 3, 6],
      target: [0, 0, 0],
    });
  });

  it("the two surfaces are independent", () => {
    const orbited = {
      position: [-0.701, 0.431, 7.767] as [number, number, number],
      target: [0.5, 0.25, -0.125] as [number, number, number],
    };
    setCameraPose("pane", orbited);
    expect(getCameraPose("pane")).toEqual(orbited);
    // The editor surface is untouched by the pane's orbit.
    expect(getCameraPose("editor")).toEqual({
      position: [4, 3, 6],
      target: [0, 0, 0],
    });
    setCameraPose("editor", orbited);
    expect(getCameraPose("editor")).toEqual(orbited);
    expect(getCameraPose("pane")).toEqual(orbited);
    // Restore the defaults so later tests (and the harness) start clean.
    setCameraPose("pane", DEFAULT_CAMERA_POSE);
    setCameraPose("editor", DEFAULT_CAMERA_POSE);
  });

  it("getters return copies: mutating the result does not change the store", () => {
    const pose = getCameraPose("pane");
    pose.position[0] = 99;
    pose.target[1] = 99;
    expect(getCameraPose("pane").position[0]).not.toBe(99);
    expect(getCameraPose("pane").target[1]).not.toBe(99);
  });

  it("setters copy: mutating the passed pose after the set does not change the store", () => {
    const pose = {
      position: [1, 2, 3] as [number, number, number],
      target: [0, 0, 0] as [number, number, number],
    };
    setCameraPose("editor", pose);
    pose.position[0] = 99;
    expect(getCameraPose("editor").position[0]).toBe(1);
    setCameraPose("editor", DEFAULT_CAMERA_POSE);
  });
});
