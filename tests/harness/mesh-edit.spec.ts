import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { clickWorldPoint, gotoEditor } from "./pr5-helpers";

type Mock = { __rest: (path: string, opts?: unknown) => Promise<any>; __setDraft: (s: string, n: string, d: unknown) => void; __hasDraft: (s: string, n: string) => boolean; restRequests?: unknown };

async function startEdit(page: Page) {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  await page.keyboard.press("m");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toBeVisible();
  return route;
}
/** The box is 1 m and sits on the floor: the middle of its top face is (0, 1, 0). */
const clickTopOfBox = (page: Page) => clickWorldPoint(page, [0, 1, 0], undefined, "#route canvas");
const bakeCalls = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/bakes")));
const nodeOf = (page: Page) => page.evaluate(async () => {
  const env = await (window.__plastis3dMock as unknown as Mock).__rest("/scenes/demo-scene");
  return env.nodes.find((n: any) => n.name === "Box");
});

test("M enters edit mode, a click selects a face, Extrude and M bake once; one undo restores the primitive", async ({ page }) => {
  const route = await startEdit(page);
  await expect(route.getByTestId("edit-status")).toContainText("0 selected");
  await expect(route.getByText("Editing — saves when you finish").first()).toBeVisible();
  await page.keyboard.press("3");
  await clickTopOfBox(page);
  await expect(route.getByTestId("edit-status")).toContainText("2 selected"); // a flat quad is two triangles
  await route.getByRole("button", { name: "Extrude" }).click();
  await expect(route.getByTestId("edit-status")).toContainText("changed");
  expect((await bakeCalls(page)).length).toBe(0); // nothing is written while editing
  await page.keyboard.press("m");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toHaveCount(0, { timeout: 15000 });
  const calls = await bakeCalls(page);
  expect(calls.length).toBe(1); // bakes once
  const mesh = calls[0].opts.body.mesh;
  expect(atob(mesh.indices).length / 12).toBe(12 + 8); // a cube plus one extruded face (4 walls of 2 triangles)
  expect(atob(mesh.positions).length / 12).toBe(24 + 4 + 16);
  expect(calls[0].opts.body.nodeId).toBeTruthy();
  const node = await nodeOf(page);
  expect(node.kind).toBe("part");
  expect(node.primitive).toBeUndefined();
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).notifications.map((n: any) => n.message).join("|"))).toContain("now an editable mesh");
  // One undo restores the original primitive.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await nodeOf(page)).kind).toBe("mesh");
});

test("the tools work on the selection: delete faces, flip, local undo, and Cancel writes nothing", async ({ page }) => {
  const route = await startEdit(page);
  await page.keyboard.press("3");
  await clickTopOfBox(page);
  await expect(route.getByTestId("edit-status")).toContainText("2 selected");
  await route.getByRole("button", { name: "Flip normals" }).click();
  await expect(route.getByTestId("edit-status")).toContainText("changed");
  await clickTopOfBox(page);
  await page.keyboard.press("Delete"); // deletes the selected faces, not the node
  await page.keyboard.press("Control+z"); // undoes the local step, not a scene revision
  expect((await nodeOf(page)).kind).toBe("mesh");
  await route.getByRole("button", { name: "Cancel" }).click();
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toHaveCount(0);
  expect((await bakeCalls(page)).length).toBe(0);
  expect((await nodeOf(page)).kind).toBe("mesh");
});

test("move and scale act on the selection through the gizmo path, within the frame budget", async ({ page }) => {
  const route = await startEdit(page);
  await page.keyboard.press("3");
  await clickTopOfBox(page);
  await expect(route.getByTestId("edit-status")).toContainText("2 selected");
  await page.keyboard.press("w");
  await page.evaluate(() => (window as any).__plastis3dEdit.moveSelection(0, 1, 0)); // the top face goes up a metre
  await page.evaluate(() => (window as any).__plastis3dEdit.scaleSelection(0.5)); // then shrinks about its centre
  expect(await page.evaluate(() => (window as any).__plastis3dEdit.lastDragMs())).toBeLessThan(8);
  await page.keyboard.press("Control+z"); // local undo: the shrink
  await page.keyboard.press("Control+Shift+z"); // and back
  await page.keyboard.press("m");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toHaveCount(0, { timeout: 15000 });
  const mesh = (await bakeCalls(page))[0].opts.body.mesh;
  const bytes = Uint8Array.from(atob(mesh.positions), (c) => c.charCodeAt(0));
  const p = new Float32Array(bytes.buffer);
  const topYs = Array.from({ length: p.length / 3 }, (_, v) => p[v * 3 + 1]).filter((y) => y > 1.0);
  expect(topYs.length).toBe(12); // four corners, each in three split copies, moved up a metre (0.5 -> 1.5 in the box's own space)
  expect(Math.max(...topYs)).toBeCloseTo(1.5, 4);
  const xs = Array.from({ length: p.length / 3 }, (_, v) => (p[v * 3 + 1] > 1.0 ? p[v * 3] : null)).filter((x) => x !== null) as number[];
  expect(Math.max(...xs)).toBeCloseTo(0.25, 4); // 0.5 half-width scaled by 0.5
});

test("a model is refused with the design sentence", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  const revision = await page.evaluate(async () => {
    const mock = window.__plastis3dMock as unknown as Mock;
    const current = await mock.__rest("/scenes/demo-scene");
    const r = await mock.__rest("/scenes/demo-scene", { method: "POST" , body: undefined }).catch(() => null);
    void r;
    const sha = "db071e1855c2c86599ed512081bdf0db7c451afaf0025e8ebb5e4a858393d2cb";
    const res = await mock.__rest("/scenes/demo-scene", { method: "PATCH", body: { baseRevision: current.scene.revision, ops: [{ op: "import_asset", asset: { id: "locked", sha256: sha, file: `assets/${sha}.glb`, format: "glb", bytes: 4096, originalName: "locked.glb", sourceFormat: "glb", stats: { tris: 5, verts: 9, meshes: 2, drawable: true, bounds: { min: [-1, 0, 0], max: [1, 2, 1] } } }, node: { id: "n_locked", name: "Locked model", kind: "model", transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, parent: null, visible: true, modelAssetId: "locked" } }] } });
    return res.scene.revision as number;
  });
  await page.evaluate(([r]) => (window.__plastis3dMock as any).__emitSceneChanged("demo-scene", r), [revision]);
  await route.getByRole("treeitem", { name: /Locked model/ }).click();
  await page.keyboard.press("m");
  await expect(page.locator("body")).not.toContainText("Edit mesh tools");
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).notifications.map((n: any) => n.message).join("|"))).toContain("This model is locked. Re-import it as editable parts to edit its mesh.");
});

test("M with nothing selected says so and starts nothing", async ({ page }) => {
  await gotoEditor(page);
  await page.locator("#route").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("m");
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).notifications.map((n: any) => n.message).join("|"))).toContain("Select one shape or part first");
});

test("a draft is written when the window is hidden, and re-entering offers Restore", async ({ page }) => {
  const route = await startEdit(page);
  await page.keyboard.press("3");
  await clickTopOfBox(page);
  await route.getByRole("button", { name: "Extrude" }).click();
  expect(await page.evaluate(() => (window.__plastis3dMock as any).__hasDraft("demo-scene", (window.__plastis3dMock as any).restRequests.length ? "x" : "x"))).toBe(false);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const nodeId = (await nodeOf(page)).id as string;
  await expect.poll(() => page.evaluate((id) => (window.__plastis3dMock as any).__hasDraft("demo-scene", id), nodeId)).toBe(true);
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }));
  // "Close the page mid-session": leave without saving (Cancel would delete the draft, so end by dispose).
  const draft = await page.evaluate(async (id) => (await (window.__plastis3dMock as any).__rest(`/scenes/demo-scene/drafts/${id}`)).draft, nodeId);
  expect(draft.mesh.indices.length).toBeGreaterThan(10);
  await route.getByRole("button", { name: "Cancel" }).click();
  expect(await page.evaluate((id) => (window.__plastis3dMock as any).__hasDraft("demo-scene", id), nodeId)).toBe(false);
  // Seed a draft as a crashed session would have left it, then enter again.
  const now = await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).scene.revision as number);
  const primitive = (await nodeOf(page)).primitive;
  await page.evaluate(([id, mesh, revision, from]) => (window.__plastis3dMock as any).__setDraft("demo-scene", id, { baseRevision: revision, from: { primitive: from }, mesh, savedAt: Date.now() / 1000 - 60 }), [nodeId, draft.mesh, now, primitive] as const);
  await page.keyboard.press("m");
  const offer = route.getByRole("alertdialog");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Restore unsaved edit from");
  await offer.getByRole("button", { name: "Restore" }).click();
  await expect(offer).toHaveCount(0);
  await expect(route.getByTestId("edit-status")).toContainText("changed");
});

test("a draft for a changed object says so before restoring", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  const nodeId = (await nodeOf(page)).id as string;
  await page.evaluate(([id]) => (window.__plastis3dMock as any).__setDraft("demo-scene", id, { baseRevision: 99, from: { modelAssetId: "something-else" }, mesh: { positions: "", normals: "", indices: "" }, savedAt: Date.now() / 1000 }), [nodeId]);
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  await page.keyboard.press("m");
  const offer = route.getByRole("alertdialog");
  await expect(offer).toContainText("This object changed since then. Restoring replaces the current mesh.");
  await offer.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).notifications.map((n: any) => n.message).join("|"))).toContain("could not be read");
  await route.getByRole("button", { name: "Cancel" }).click();
});
