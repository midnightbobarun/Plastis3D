// tests/harness/dock-narrow.spec.ts — the tool dock folds into one button in a narrow stage (UI/UX polish W7).
import { expect, test } from "@playwright/test";
import { gotoEditor, installErrorCollector } from "./pr5-helpers";

type Page = import("@playwright/test").Page;

async function setRouteWidth(page: Page, width: number | null): Promise<void> {
  // The mock page gives the route almost no height; the dock also folds in a short stage, so size it like a window.
  await page.evaluate((w) => {
    const route = document.querySelector("#route") as HTMLElement;
    route.style.width = w === null ? "" : `${w}px`;
    route.style.height = "760px";
    const mount = route.querySelector(".route-mount") as HTMLElement | null;
    if (mount) mount.style.height = "100%";
  }, width);
  await page.waitForTimeout(300);
}

test("at a normal width the dock shows its tools and no toggle", async ({ page }) => {
  await gotoEditor(page);
  await setRouteWidth(page, null);
  const dock = page.locator("#route").getByRole("toolbar", { name: "Viewport tools" });
  await expect(dock.getByRole("button", { name: "Move (W)" })).toBeVisible();
  await expect(dock.getByRole("button", { name: "Tools" })).toBeHidden();
});

test("in a narrow or short stage the dock is one button that opens the tools", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  await setRouteWidth(page, 300);
  const dock = page.locator("#route").getByRole("toolbar", { name: "Viewport tools" });
  const toggle = dock.getByRole("button", { name: "Tools" });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(dock.getByRole("button", { name: "Move (W)" })).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(dock.getByRole("button", { name: "Move (W)" })).toBeVisible();

  // Choosing a tool applies it and folds the dock again.
  await dock.getByRole("button", { name: "Move (W)" }).click();
  await expect(dock.getByRole("button", { name: "Move (W)" })).toBeHidden();
  await toggle.click();
  await expect(dock.getByRole("button", { name: "Move (W)" })).toHaveAttribute("aria-pressed", "true");

  // Escape folds it without choosing anything.
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // A press elsewhere folds it too.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.locator("#route .p3d-header").click({ position: { x: 5, y: 5 } });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Widening brings the full dock back.
  await setRouteWidth(page, null);
  await expect(dock.getByRole("button", { name: "Rotate (E)" })).toBeVisible();
  await expect(toggle).toBeHidden();
  expect(errors).toEqual([]);
});
