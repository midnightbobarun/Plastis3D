import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

const curves = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/curves")));
const curveNode = (page: Page) => page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((n: any) => n.generator?.type === "curve") ?? null);

test("Add > Curve makes a curve part; editing a point and Apply regenerates it in one more revision; undo restores it", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".p3d-add").getByText("Curve", { exact: true }).first().click();
  await expect.poll(() => curveNode(page), { timeout: 15000 }).not.toBeNull();
  let calls = await curves(page);
  expect(calls.length).toBe(1);
  expect(calls[0].opts.body.curve).toMatchObject({ kind: "tube", closed: false, interpolation: "centripetal" });
  expect(calls[0].opts.body.curve.points.length).toBe(4);
  const first = await curveNode(page);
  expect(first.kind).toBe("part");
  const section = route.getByRole("region", { name: "Curve" });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByRole("button", { name: /Curve/ }).click(); // collapsed by default
  await expect(section.getByLabel("Point 4 X")).toHaveValue("1");
  await section.getByLabel("Point 2 Y").fill("1.5");
  await section.getByLabel("Tube radius (m)").fill("0.2");
  await section.getByRole("button", { name: "Add point" }).click();
  await expect(section.getByLabel("Point 5 X")).toBeVisible();
  await section.getByRole("button", { name: "Remove point 1" }).click();
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await curves(page)).length).toBe(2);
  calls = await curves(page);
  expect(calls[1].opts.body.id).toBe(first.id);
  expect(calls[1].opts.body.curve.radius).toBe(0.2);
  expect(calls[1].opts.body.curve.points.length).toBe(4); // one added, one removed
  expect(calls[1].opts.body.curve.points[0][1]).toBe(1.5); // the old point 2 is now point 1
  const second = await curveNode(page);
  expect(second.modelAssetId).not.toBe(first.modelAssetId);
  await route.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => (await curveNode(page))?.modelAssetId).toBe(first.modelAssetId);
});

test("a lathe takes its own settings, and a curve needs at least two points", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("button", { name: "Add", exact: true }).click();
  await page.locator(".p3d-add").getByText("Curve", { exact: true }).first().click();
  const section = route.getByRole("region", { name: "Curve" });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByRole("button", { name: /Curve/ }).click();
  await section.getByLabel("Kind").selectOption("lathe");
  await expect(section.getByLabel("Revolve segments")).toBeVisible();
  await expect(section.getByLabel("Tube radius (m)")).toHaveCount(0);
  await section.getByRole("button", { name: "Remove point 1" }).click();
  await section.getByRole("button", { name: "Remove point 1" }).click();
  await expect(section.getByRole("button", { name: "Remove point 1" })).toBeDisabled(); // two points left
});
