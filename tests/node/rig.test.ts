import { describe, expect, it } from "vitest";
import { defaultDraft, draftFromParams, eulerToQuat, poseRotations, quatToEuler, toParams, validateDraft } from "../../src/scene/rig";

describe("rig settings", () => {
  it("the default draft is two bones up the bounds and is valid", () => {
    const d = defaultDraft({ min: [-1, 0, -1], max: [1, 2, 1] });
    expect(d.bones.map((b) => [b.head[1], b.tail[1]])).toEqual([[0, 1], [1, 2]]);
    expect(validateDraft(d)).toBeNull();
  });
  it("Euler degrees survive the quaternion round trip", () => {
    for (const e of [[0, 0, 45], [10, 20, 30], [-90, 0, 0]] as Array<[number, number, number]>) {
      const back = quatToEuler(eulerToQuat(e));
      e.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 2));
    }
  });
  it("params carry unit quaternions in time order and load back as the same draft", () => {
    const d = defaultDraft(null);
    d.clips[0].keys.reverse();
    const p = toParams(d);
    expect(p.clips[0].keys.map((k) => k.t)).toEqual([0, 1]);
    for (const k of p.clips[0].keys) expect(Math.hypot(...k.rotation)).toBeCloseTo(1, 6);
    const again = draftFromParams(p);
    expect(again.clips[0].keys[1].rotation[2]).toBeCloseTo(45, 2);
  });
  it("refuses loops, zero-length bones, duplicate times and removed bones", () => {
    const base = () => defaultDraft(null);
    let d = base(); d.bones[0].parent = "bone2"; expect(validateDraft(d)).toMatch(/loop/);
    d = base(); d.bones[0].tail = [...d.bones[0].head] as [number, number, number]; expect(validateDraft(d)).toMatch(/length/);
    d = base(); d.clips[0].keys[1].t = 0; expect(validateDraft(d)).toMatch(/increase/);
    d = base(); d.clips[0].keys[0].boneId = "ghost"; expect(validateDraft(d)).toMatch(/removed/);
    d = base(); d.bones.push({ ...d.bones[0] }); expect(validateDraft(d)).toMatch(/unique/);
  });
  it("the pose slerps between keys and a child follows its parent", () => {
    const d = defaultDraft(null);
    d.clips[0].keys = [{ t: 0, boneId: "bone1", rotation: [0, 0, 0] }, { t: 1, boneId: "bone1", rotation: [0, 0, 90] }];
    const mid = poseRotations(d.bones, d.clips[0], 0.5);
    expect(quatToEuler([mid.get("bone1")!.x, mid.get("bone1")!.y, mid.get("bone1")!.z, mid.get("bone1")!.w])[2]).toBeCloseTo(45, 2);
    expect(mid.get("bone2")!.angleTo(mid.get("bone1")!)).toBeCloseTo(0, 6); // the upper bone has no key of its own: it rides along
  });
});
