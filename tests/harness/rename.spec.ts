// tests/harness/rename.spec.ts — rename from the scene menu and F2 (UI/UX polish W5).
import { expect, test } from "@playwright/test";
import { gotoEditor, installErrorCollector, mockReport } from "./pr5-helpers";

type Page = import("@playwright/test").Page;

const renamePatches = async (page: Page) =>
  (await mockReport(page)).restRequests.filter(
    (r) => (r.opts as { body?: { ops?: Array<{ op: string }> } } | undefined)?.body?.ops?.[0]?.op === "set_scene_name",
  );

test("there is no standalone Rename button; the scene menu has Rename…", async ({ page }) => {
  await gotoEditor(page);
  const root = page.locator("[data-plastis-root=editor]");
  await expect(root.locator("summary", { hasText: "Rename" })).toHaveCount(0);
  await expect(root.locator(".p3d-header").getByRole("button", { name: /^Rename$/ })).toHaveCount(0);
  await root.getByRole("button", { name: /Demo Scene/ }).first().click();
  await expect(page.getByRole("menuitem", { name: "Rename scene", exact: true })).toBeVisible();
});

test("Rename… opens a focused field; Enter renames in one revision", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  const root = page.locator("[data-plastis-root=editor]");
  await root.getByRole("button", { name: /Demo Scene/ }).first().click();
  await page.getByRole("menuitem", { name: "Rename scene", exact: true }).click();
  const field = root.getByRole("textbox", { name: "Scene name", exact: true });
  await expect(field).toBeFocused();
  await field.fill("Crate scene");
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  await expect.poll(async () => (await renamePatches(page)).length).toBe(1);
  expect(errors).toEqual([]);
});

test("F2 opens the field and Escape closes it without changing anything", async ({ page }) => {
  await gotoEditor(page);
  const root = page.locator("[data-plastis-root=editor]");
  await root.focus();
  await page.keyboard.press("F2");
  const field = root.getByRole("textbox", { name: "Scene name", exact: true });
  await expect(field).toBeFocused();
  await field.fill("Throwaway");
  await field.press("Escape");
  await expect(field).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await renamePatches(page)).toHaveLength(0);
});
