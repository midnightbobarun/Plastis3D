import { expect, test } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

type Mock = { __rest: (path: string, opts?: unknown) => Promise<any>; __thumbnail: (s: string) => { revision: number; png: string } | null; __setThumbnail: (s: string, r: number, png: string) => void; __emitSceneChanged: (s: string, r: number) => void };

test("the Scenes pane search appears with many scenes and filters by name", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(async () => {
    const mock = window.__plastis3dMock as unknown as Mock;
    for (const name of ["Cozy cabin", "Rocket pad", "Snow globe", "Tiny forest", "Lamp post"]) await mock.__rest("/scenes", { method: "POST", body: { name } });
  });
  await page.evaluate(() => (window.__plastis3dMock as any).__emitSceneChanged("demo-scene", 1));
  const search = page.getByLabel("Search scenes").first();
  await expect(search).toBeVisible({ timeout: 15000 });
  const rows = page.locator(".p3d-scenes .p3d-scene-row");
  const before = await rows.count();
  expect(before).toBeGreaterThanOrEqual(6);
  await search.fill("snow");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Snow globe");
  await search.fill("zzz");
  await expect(page.getByText("No scene matches “zzz”.")).toBeVisible();
  await search.fill("");
  await expect(rows).toHaveCount(before);
});

test("after an edit settles the editor posts a clean PNG thumbnail, and the list shows it", async ({ page }) => {
  await gotoEditor(page);
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).__thumbnail("demo-scene")?.png ?? null), { timeout: 20000 }).not.toBeNull();
  const thumb = await page.evaluate(() => (window.__plastis3dMock as any).__thumbnail("demo-scene"));
  expect(Buffer.from(thumb.png, "base64").subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const width = Buffer.from(thumb.png, "base64").readUInt32BE(16);
  expect(width).toBeLessThanOrEqual(192);
  // The list now carries the revision, so the tile shows the picture instead of a letter.
  await page.evaluate(() => (window.__plastis3dMock as any).__emitSceneChanged("demo-scene", 1));
  await expect(page.locator('[data-testid="scene-thumbnail"]').first()).toBeVisible({ timeout: 15000 });
  // An edit makes it stale; it is replaced once the edit settles.
  const before = thumb.revision;
  await page.evaluate(async () => {
    const mock = window.__plastis3dMock as any;
    const current = await mock.__rest("/scenes/demo-scene");
    const next = await mock.__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: current.scene.revision, ops: [{ op: "update_node", id: current.nodes.find((n: any) => n.name === "Box").id, name: "Box 2" }] } });
    mock.__emitSceneChanged("demo-scene", next.scene.revision);
  });
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).__thumbnail("demo-scene").revision), { timeout: 20000 }).toBeGreaterThan(before);
});

test("Files in this scene lists models, and Remove unused previews then removes only the unused one", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await page.evaluate(async () => {
    const mock = window.__plastis3dMock as any;
    const sha = "db071e1855c2c86599ed512081bdf0db7c451afaf0025e8ebb5e4a858393d2cb";
    const row = (id: string, name: string) => ({ id, sha256: sha, file: `assets/${sha}.glb`, format: "glb", bytes: 4096, originalName: name, sourceFormat: "glb", stats: { tris: 5, verts: 9, meshes: 2, drawable: true, bounds: { min: [-1, 0, 0], max: [1, 2, 1] } } });
    let rev = (await mock.__rest("/scenes/demo-scene")).scene.revision;
    for (const [id, name, nodeId] of [["used", "used.glb", "n_used"], ["spare", "spare.glb", "n_spare"]]) {
      const r = await mock.__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: rev, ops: [{ op: "import_asset", asset: row(id, name), node: { id: nodeId, name, kind: "model", transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, parent: null, visible: true, modelAssetId: id } }] } });
      rev = r.scene.revision;
    }
    const gone = await mock.__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: rev, ops: [{ op: "delete_node", id: "n_spare" }] } });
    mock.__emitSceneChanged("demo-scene", gone.scene.revision);
  });
  const section = route.getByRole("region", { name: "Files in this scene" });
  await expect(section).toBeVisible({ timeout: 15000 });
  const rows = section.getByTestId("library-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "spare.glb" })).toContainText("unused");
  await expect(rows.filter({ hasText: "used.glb" }).first()).toContainText("used");
  await section.getByRole("button", { name: /Remove unused \(1\)/ }).click();
  await expect(section.getByRole("group", { name: "Remove unused" })).toContainText("spare.glb");
  const revisionBefore = await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).scene.revision);
  await section.getByRole("button", { name: "Remove them" }).click();
  await expect(section).toContainText("Removed. One undo brings them back.");
  const after = await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")));
  expect(after.assets.map((a: any) => a.id)).toEqual(["used"]);
  expect(after.scene.revision).toBe(revisionBefore + 1); // one revision, so one undo
  await page.evaluate(async (rev) => { await (window.__plastis3dMock as any).__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: rev, ops: [{ op: "undo" }] } }); }, after.scene.revision);
  const undone = await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")));
  expect(undone.assets.map((a: any) => a.id).sort()).toEqual(["spare", "used"]);
});
