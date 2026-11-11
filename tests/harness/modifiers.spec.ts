import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

const bakes = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/bakes")));
const boxNode = (page: Page) => page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((n: any) => n.name === "Box"));

test("a modifier stack: first Apply makes the base then the result; editing a setting re-applies from the same base", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  const section = route.getByRole("region", { name: "Modifiers" });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByRole("button", { name: /Modifiers/ }).click(); // collapsed by default: it is an advanced section
  await section.getByLabel("Add a modifier…").selectOption({ label: "Array" });
  await expect(section.getByRole("status")).toContainText("12 → about 24 triangles");
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await bakes(page)).length).toBe(2);
  let calls = await bakes(page);
  expect(calls[0].opts.body.generator).toBeUndefined(); // the un-modified mesh becomes the base asset
  expect(atob(calls[0].opts.body.mesh.indices).length / 12).toBe(12);
  expect(atob(calls[1].opts.body.mesh.indices).length / 12).toBe(24);
  const g1 = calls[1].opts.body.generator;
  expect(g1.type).toBe("modifiers");
  expect(g1.params.stack).toEqual([{ type: "array", enabled: true, params: { count: 2, offset: [1, 0, 0] } }]);
  const node = await boxNode(page);
  expect(node.kind).toBe("part");
  expect(node.generator.params.baseAssetId).toBe(g1.params.baseAssetId);
  expect(node.modelAssetId).not.toBe(g1.params.baseAssetId);
  // Edit a setting and re-Apply: one more bake, the SAME base.
  await expect(section.getByLabel("Array 1 Count")).toBeVisible({ timeout: 15000 });
  await section.getByLabel("Array 1 Count").fill("3");
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await bakes(page)).length).toBe(3);
  calls = await bakes(page);
  expect(calls[2].opts.body.generator.params.baseAssetId).toBe(g1.params.baseAssetId);
  expect(calls[2].opts.body.generator.params.stack[0].params.count).toBe(3);
  expect(atob(calls[2].opts.body.mesh.indices).length / 12).toBe(atob(calls[1].opts.body.mesh.indices).length / 12 * 1.5);
});

test("stack editing: reorder, disable, remove, and bad settings are named and cannot be applied", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  const section = route.getByRole("region", { name: "Modifiers" });
  await section.getByRole("button", { name: /Modifiers/ }).click();
  await section.getByLabel("Add a modifier…").selectOption({ label: "Mirror" });
  await section.getByLabel("Add a modifier…").selectOption({ label: "Subdivide" });
  await expect(section.getByRole("status")).toContainText("12 → about 96 triangles"); // x2 then x4
  await section.getByLabel("Move up Subdivide 2").click();
  await expect(section.getByLabel("Subdivide 1 on")).toBeVisible();
  await section.getByLabel("Subdivide 1 on").uncheck();
  await expect(section.getByRole("status")).toContainText("12 → about 24 triangles");
  await section.getByLabel("Remove Subdivide 1").click();
  await expect(section.getByRole("status")).toContainText("12 → about 24 triangles");
  await section.getByLabel("Add a modifier…").selectOption({ label: "Array" });
  await section.getByLabel("Array 2 Count").fill("0");
  await expect(section.getByRole("status")).toContainText("Array needs a count from 1 to 64");
  await expect(section.getByRole("button", { name: "Apply" })).toBeDisabled();
  expect((await bakes(page)).length).toBe(0);
});

test("a nonzero imported primitive remains the base through two modifier applications", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(async () => {
    const mock = window.__plastis3dMock as any;
    const env = await mock.__rest("/scenes/demo-scene");
    const sha = "ba710c41bffcdee203548ba1f24160bd20c6a873f79e4df23f37924937812acd";
    const transform = { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] };
    await mock.__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: env.scene.revision, ops: [
      { op: "import_asset", asset: { id: "a_exact", sha256: sha, file: `assets/${sha}.glb`, format: "glb", bytes: 2184, originalName: "two-primitive.glb", sourceFormat: "glb", stats: { tris: 36, verts: 108, meshes: 2, drawable: true } }, node: { id: "n_throwaway", name: "Source", kind: "model", transform, parent: null, visible: true, modelAssetId: "a_exact" } },
      { op: "build", nodes: [{ id: "n_exact", name: "Exact primitive", kind: "part", transform, parent: null, visible: true, modelAssetId: "a_exact", meshIndex: 0, primitiveIndex: 1 }] },
    ] } });
  });
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Exact primitive/ }).click();
  const section = route.getByRole("region", { name: "Modifiers" });
  await section.getByRole("button", { name: /Modifiers/ }).click();
  await section.getByLabel("Add a modifier…").selectOption({ label: "Array" });
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await bakes(page)).length).toBe(1);
  await section.getByLabel("Array 1 Count").fill("3");
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await bakes(page)).length).toBe(2);
  const calls = await bakes(page);
  for (const call of calls) {
    expect(call.opts.body.generator.params).toMatchObject({ baseAssetId: "a_exact", baseMeshIndex: 0, basePrimitiveIndex: 1 });
    const p = new Float32Array(Uint8Array.from(atob(call.opts.body.mesh.positions), (c) => c.charCodeAt(0)).buffer);
    expect(Math.min(...p.filter((_, i) => i % 3 === 0))).toBeCloseTo(1.5, 5);
  }
});
