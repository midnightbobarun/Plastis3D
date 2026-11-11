import { describe, expect, it } from "vitest";
import { MAX_SELECTED, PhysicsError, fallClips, settle } from "../../src/scene/physics";
import type { NodeSpec, SceneSpec } from "../../src/types";

function box(id: string, t: [number, number, number], parent: string | null = null, s: [number, number, number] = [1, 1, 1], r: [number, number, number] = [0, 0, 0]): NodeSpec {
  return { id, name: id, kind: "mesh", parent, visible: true, transform: { t, r, s }, primitive: { type: "box", size: [1, 1, 1] } } as unknown as NodeSpec;
}
function scene(nodes: NodeSpec[]): SceneSpec {
  return { schema: 2, id: "s", name: "s", revision: 1, nodes, materials: [], assets: [] } as unknown as SceneSpec;
}

describe("settle", () => {
  it("a dropped box rests at half its height", async () => {
    const r = await settle(scene([box("a", [0, 3, 0])]), ["a"]);
    expect(r.rested).toBe(true);
    expect(r.poses.get("a")!.t[1]).toBeGreaterThan(0.49);
    expect(r.poses.get("a")!.t[1]).toBeLessThan(0.51);
  });
  it("is deterministic and never NaN", async () => {
    const s = scene([box("a", [0, 3, 0], null, [1, 1, 1], [20, 10, 30])]);
    const a = await settle(s, ["a"]);
    const b = await settle(s, ["a"]);
    expect(a.poses.get("a")).toEqual(b.poses.get("a"));
    for (const v of [...a.poses.get("a")!.t, ...a.poses.get("a")!.r]) expect(Number.isFinite(v)).toBe(true);
  });
  it("lands on a static box", async () => {
    const r = await settle(scene([box("floorbox", [0, 0.5, 0]), box("a", [0, 4, 0])]), ["a"]);
    expect(r.poses.get("a")!.t[1]).toBeGreaterThan(1.45);
    expect(r.poses.get("a")!.t[1]).toBeLessThan(1.55);
  });
  it("converts through a parent's translation", async () => {
    const r = await settle(scene([{ ...box("g", [5, 1, 0]), kind: "group", primitive: undefined } as NodeSpec, box("a", [0, 3, 0], "g")]), ["a"]);
    expect(r.poses.get("a")!.t[1]).toBeGreaterThan(-0.51);
    expect(r.poses.get("a")!.t[1]).toBeLessThan(-0.49);
  });
  it("refuses more than 32 nodes", async () => {
    const nodes = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => box("n" + i, [i * 2, 3, 0]));
    await expect(settle(scene(nodes), nodes.map((n) => n.id))).rejects.toMatchObject({ code: "PHYSICS_TOO_MANY" });
  });
  it("refuses when nothing can fall", async () => {
    await expect(settle(scene([box("a", [0, 1, 0])]), [])).rejects.toBeInstanceOf(PhysicsError);
  });
  it("records a fall with increasing times", async () => {
    const r = await settle(scene([box("a", [0, 3, 0])]), ["a"]);
    const clip = fallClips(r).get("a")!;
    expect(clip.channels[0].times.length).toBeGreaterThan(5);
    expect(clip.channels[0].times).toEqual([...clip.channels[0].times].sort((x, y) => x - y));
  });
});
