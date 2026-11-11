import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoEditor, projectPoint } from "./pr5-helpers";

const bakes = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/bakes")));
const f32 = (b64: string) => new Float32Array(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);

async function enter(page: Page, key: "b" | "p") {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  await page.keyboard.press(key);
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toBeVisible();
  return route;
}
/** Drag across the box's top face with the left button. */
async function drag(page: Page, from: [number, number, number] = [-0.2, 1, -0.2], to: [number, number, number] = [0.2, 1, 0.2]) {
  await page.locator("#route canvas").first().scrollIntoViewIfNeeded();
  const a = await projectPoint(page, from, "#route canvas");
  const b = await projectPoint(page, to, "#route canvas");
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 4 });
  await page.mouse.up();
}

test("B starts Sculpt: a draw stroke moves vertices, leaving bakes once with no generator, one undo restores the shape", async ({ page }) => {
  const route = await enter(page, "b");
  await expect(route.getByRole("button", { name: "Sculpt (B)" })).toHaveAttribute("aria-pressed", "true");
  for (const name of ["Draw", "Smooth", "Flatten", "Grab"]) await expect(route.getByRole("button", { name, exact: true })).toBeVisible();
  await route.getByLabel("Radius (px)").fill("300"); // a cube top has only corner vertices: reach them
  await route.getByLabel("Strength").fill("1");
  await drag(page);
  await expect(route.getByTestId("edit-status")).toContainText("changed");
  expect((await bakes(page)).length).toBe(0); // strokes accumulate locally
  await page.keyboard.press("Control+z"); // local undo: the stroke
  await page.keyboard.press("Control+Shift+z"); // and back: the stroke is redone
  await page.keyboard.press("m");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toHaveCount(0, { timeout: 15000 });
  const calls = await bakes(page);
  expect(calls.length).toBe(1);
  expect(calls[0].opts.body.generator).toBeUndefined();
  const p = f32(calls[0].opts.body.mesh.positions);
  const moved = Array.from({ length: p.length / 3 }, (_, v) => p[v * 3 + 1]).filter((y) => Math.abs(Math.abs(y) - 0.5) > 1e-4);
  expect(moved.length).toBeGreaterThan(0); // some vertex left the original cube surface
  expect(Array.from(p).every(Number.isFinite)).toBe(true);
  const node = await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((n: any) => n.name === "Box"));
  expect(node.kind).toBe("part");
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((n: any) => n.name === "Box"))).kind).toBe("mesh");
});

test("P starts Paint: Fill and a stroke write vertex colours that are baked once as COLOR_0", async ({ page }) => {
  const route = await enter(page, "p");
  await expect(route.getByRole("button", { name: "Paint (P)" })).toHaveAttribute("aria-pressed", "true");
  await route.getByRole("toolbar", { name: "Edit mesh tools" }).getByLabel("Colour").fill("#ff0000");
  await route.getByRole("button", { name: "Fill" }).click();
  await expect(route.getByTestId("edit-status")).toContainText("changed");
  await route.getByRole("toolbar", { name: "Edit mesh tools" }).getByLabel("Colour").fill("#0000ff");
  await route.getByLabel("Radius (px)").fill("65"); // about a quarter of a metre at the default camera
  await route.getByLabel("Strength").fill("1");
  await route.getByLabel("Hardness").fill("1");
  await drag(page, [0.45, 1, 0.45], [0.46, 1, 0.46]); // a small stroke on one corner of the top
  await page.keyboard.press("m");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toHaveCount(0, { timeout: 15000 });
  const calls = await bakes(page);
  expect(calls.length).toBe(1);
  const colors = f32(calls[0].opts.body.mesh.colors);
  expect(colors.length).toBe(24 * 4); // RGBA per vertex
  let red = 0, blue = 0;
  for (let v = 0; v < 24; v++) { if (colors[v * 4] > 0.99 && colors[v * 4 + 2] < 0.01) red++; if (colors[v * 4 + 2] > 0.99 && colors[v * 4] < 0.01) blue++; }
  expect(red).toBeGreaterThan(0); // the fill
  expect(blue).toBeGreaterThan(0); // the stroke
  expect(blue).toBeLessThan(12); // and it stayed local
  expect(red + blue).toBe(24); // every vertex is the fill or the stroke, and the stroke only reached the corner
});

test("the tools switch inside one session, [ and ] resize the brush, and the mesh tools still work", async ({ page }) => {
  const route = await enter(page, "b");
  const radius = route.getByLabel("Radius (px)");
  await expect(radius).toHaveValue("48");
  await page.keyboard.press("]");
  await expect(radius).toHaveValue("58");
  await page.keyboard.press("[");
  await expect(radius).toHaveValue("48");
  await page.keyboard.press("p"); // switch tool: same session
  await expect(route.getByRole("button", { name: "Paint (P)" })).toHaveAttribute("aria-pressed", "true");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" }).getByLabel("Colour")).toBeVisible();
  await route.getByRole("toolbar", { name: "Edit mesh tools" }).getByRole("button", { name: "Mesh (M)" }).click();
  await expect(route.getByRole("button", { name: "Extrude" })).toBeVisible();
  await route.getByRole("button", { name: "Cancel" }).click();
  expect((await bakes(page)).length).toBe(0);
});
