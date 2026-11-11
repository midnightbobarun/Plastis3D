import { expect, test } from "@playwright/test";
import { gotoEditor, emitSceneChanged, patchRequests } from "./pr5-helpers";

test("locked animated model offers view-only playback", async ({ page }) => {
  await gotoEditor(page);
  const sha = "db071e1855c2c86599ed512081bdf0db7c451afaf0025e8ebb5e4a858393d2cb";
  const revision = await page.evaluate(async (hash) => {
    const mock = window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<any> };
    const current = await mock.__rest("/scenes/demo-scene");
    const result = await mock.__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: current.scene.revision, ops: [{ op: "import_asset", asset: { id: "animated", sha256: hash, file: `assets/${hash}.glb`, format: "glb", bytes: 4096, originalName: "animated.glb", sourceFormat: "glb", stats: { tris: 5, verts: 9, meshes: 2, drawable: true, bounds: { min: [-1, 0, 0], max: [1, 2, 1] } } }, node: { id: "n_animated", name: "Animated model", kind: "model", transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, parent: null, visible: true, modelAssetId: "animated" } }] } });
    return result.scene.revision as number;
  }, sha);
  await emitSceneChanged(page, "demo-scene", revision);
  await page.locator("#route").getByRole("treeitem", { name: /Animated model/ }).click();
  const route = page.locator("#route");
  await expect(route.getByLabel("Animation clip")).toBeVisible({ timeout: 15000 });
  const before = (await patchRequests(page)).length;
  await route.getByRole("button", { name: "Play", exact: true }).click();
  await expect(route.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  // The four-second scene poll must not rebuild the unchanged animation.
  await page.waitForTimeout(5000);
  await expect(route.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await route.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(route.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  const scrub = route.getByLabel("Animation time");
  await expect(scrub).toBeVisible();
  await scrub.fill("0.5");
  expect((await patchRequests(page)).length).toBe(before);
  await route.getByRole("button", { name: "Play", exact: true }).click();
  const otherId = await page.evaluate(async () => {
    const mock = window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<any> };
    const result = await mock.__rest("/scenes", { method: "POST", body: { name: "Clip switch" } });
    return result.scene.id as string;
  });
  await page.evaluate((id) => { window.location.hash = `#/plastis3d?scene=${id}`; }, otherId);
  await expect(route.getByLabel("Animation clip")).toHaveCount(0, { timeout: 15000 });
  await expect.poll(async () => page.evaluate(() => window.__plastis3dViewportEditor?.sceneRev)).toBe(1);
});
