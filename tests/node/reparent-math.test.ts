import { expect, it } from "vitest";
import { reparentTransform } from "../../src/editor/reparentMath";
import type { NodeSpec, SceneSpec } from "../../src/types";
const node = (id: string, parent: string | null, r: [number, number, number], s: [number, number, number]): NodeSpec => ({ id, name: id, kind: "group", parent, visible: true, transform: { t: [1, 2, 3], r, s } });
const scene = (nodes: NodeSpec[]) => ({ nodes } as SceneSpec);
it("preserves pose under a uniform parent and negative scale", () => {
  const result = reparentTransform(scene([node("child", null, [0, 45, 0], [-1, 1, 1]), node("parent", null, [0, 0, 0], [2, 2, 2])]), "child", "parent");
  expect(result).not.toBeNull();
  expect(result!.s.some((value) => value < 0)).toBe(true);
});
it("rejects shear and near-singular parents", () => {
  const child = node("child", null, [0, 0, 45], [1, 1, 1]);
  expect(reparentTransform(scene([child, node("parent", null, [0, 0, 0], [2, 1, 1])]), "child", "parent")).toBeNull();
  expect(reparentTransform(scene([child, node("parent", null, [0, 0, 0], [1e-15, 1, 1])]), "child", "parent")).toBeNull();
});
