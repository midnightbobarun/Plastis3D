import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

const node = (page: Page, name: string) => page.evaluate(async (n) => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((x: any) => x.name === n), name);
const patches = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => r.opts?.method === "PATCH" && String(r.path).endsWith("/scenes/demo-scene")));

test("Settle drops the selected shape and Keep writes it as ONE patch; one undo restores it", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Inner box/ }).click();
  const before = await node(page, "Inner box");
  const n0 = (await patches(page)).length;
  await route.getByRole("button", { name: "Settle", exact: true }).click();
  await expect(route.getByRole("status").filter({ hasText: "Settled" })).toBeVisible({ timeout: 20000 });
  expect((await patches(page)).length).toBe(n0); // a preview writes nothing
  await route.getByRole("button", { name: "Keep", exact: true }).click();
  await expect.poll(async () => (await node(page, "Inner box")).transform.t[1], { timeout: 15000 }).toBeCloseTo(0.25, 1);
  expect((await patches(page)).length).toBe(n0 + 1);
  await route.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => (await node(page, "Inner box")).transform.t[1]).toBe(before.transform.t[1]);
});

test("Cancel leaves the scene untouched", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Inner box/ }).click();
  const n0 = (await patches(page)).length;
  await route.getByRole("button", { name: "Settle", exact: true }).click();
  await expect(route.getByRole("status").filter({ hasText: "Settled" })).toBeVisible({ timeout: 20000 });
  await route.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(route.getByRole("button", { name: "Settle", exact: true })).toBeVisible();
  expect((await patches(page)).length).toBe(n0);
});
