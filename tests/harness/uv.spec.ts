import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { clickWorldPoint, gotoEditor } from "./pr5-helpers";

const bakes = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/bakes")));

test("Unwrap a box into six islands on the 2D canvas, rearrange one, Pack and Apply bakes the UVs once", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  const section = route.getByRole("region", { name: "UV map" });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByRole("button", { name: /UV map/ }).click(); // collapsed by default
  await expect(section.getByRole("button", { name: "Apply" })).toBeDisabled();
  await section.getByRole("button", { name: "Unwrap" }).click();
  await expect(section.getByRole("status")).toContainText("6 islands", { timeout: 15000 });
  const canvas = section.getByTestId("uv-canvas");
  const before = await canvas.screenshot();
  await canvas.click({ position: { x: 20, y: 20 } }); // pick whichever island is under the point
  await section.getByRole("button", { name: "Rotate island" }).click();
  await section.getByRole("button", { name: "Island bigger" }).click();
  await section.getByRole("button", { name: "Pack" }).click();
  expect(Buffer.compare(before, await canvas.screenshot())).not.toBe(0); // the canvas shows the change
  await section.getByRole("button", { name: "Repair" }).click();
  await expect(section.getByRole("status")).toContainText("Nothing to repair.");
  expect((await bakes(page)).length).toBe(0); // nothing is saved until Apply
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await bakes(page)).length).toBe(1);
  const body = (await bakes(page))[0].opts.body;
  expect(atob(body.mesh.indices).length / 12).toBe(12);
  expect(atob(body.mesh.positions).length / 12).toBe(24); // split along the chart borders, as a box already is
  const uv = new Float32Array(Uint8Array.from(atob(body.mesh.uvs), (c) => c.charCodeAt(0)).buffer);
  expect(uv.length).toBe(24 * 2);
  expect(Math.min(...uv)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...uv)).toBeLessThanOrEqual(1);
  expect(body.generator).toBeUndefined();
  const node = await page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((n: any) => n.name === "Box"));
  expect(node.kind).toBe("part");
});

test("Mark seam is offered in edge mode, and a lone cut across a closed surface says it separates nothing", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  await page.keyboard.press("m");
  await expect(route.getByRole("toolbar", { name: "Edit mesh tools" })).toBeVisible();
  await expect(route.getByRole("button", { name: "Mark seam" })).toBeDisabled();
  await page.keyboard.press("2");
  await clickWorldPoint(page, [0, 1, 0.45], undefined, "#route canvas"); // near the top face's front edge
  await expect(route.getByTestId("edit-status")).toContainText("1 selected");
  await expect(route.getByRole("button", { name: "Mark seam" })).toBeEnabled();
  await route.getByRole("button", { name: "Mark seam" }).click();
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as any).notifications.map((n: any) => n.message).join("|"))).toMatch(/Seam marked|does not separate anything/);
  await route.getByRole("button", { name: "Cancel" }).click();
});
