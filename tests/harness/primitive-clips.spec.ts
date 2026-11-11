import { expect, test } from "@playwright/test";
import { gotoEditor, patchRequests } from "./pr5-helpers";

test("create, edit, play and key a primitive clip", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  const section = route.getByRole("button", { name: /Animation keys/ });
  if (await section.getAttribute("aria-expanded") === "false") await section.click();
  await route.getByRole("button", { name: "Create clip", exact: true }).click();
  await expect(route.getByLabel("Animation clip").first()).toBeVisible({ timeout: 15000 });
  const stageControls = route.getByRole("group", { name: "Animation", exact: true });
  for (const control of [stageControls.getByLabel("Animation clip"), stageControls.getByLabel("Animation time"), stageControls.getByRole("button", { name: "Play", exact: true })]) {
    const box = await control.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(24);
    expect(box?.width).toBeGreaterThanOrEqual(24);
  }
  await expect.poll(async () => (await patchRequests(page)).length).toBe(1);
  await route.getByRole("region", { name: "Animation keys" }).getByRole("button", { name: "Add key", exact: true }).click();
  await expect.poll(async () => (await patchRequests(page)).length).toBe(2);
  await expect(route.getByLabel("Animation time 2")).toBeVisible();
  await route.getByRole("button", { name: "Play", exact: true }).click();
  await expect(route.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await route.getByRole("button", { name: "Pause", exact: true }).click();
  const stage = route.getByRole("group", { name: "Animation", exact: true });
  await stage.getByRole("button", { name: "Add key", exact: true }).click();
  await expect.poll(async () => (await patchRequests(page)).length).toBe(3);
});
