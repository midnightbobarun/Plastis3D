import { test, expect } from "@playwright/test";
import { gotoMock } from "./pr5-helpers";
test("settings apply across mounted surfaces", async ({ page }) => {
 await gotoMock(page);
 await page.evaluate(() => (window as any).__showSettings());
 const settings = page.locator('#plugin-settings');
 await settings.scrollIntoViewIfNeeded();
 await settings.getByLabel('Background').selectOption('plain');
 await expect(page.locator('[data-plastis-root=editor] .p3d-stage')).toHaveClass(/p3d-stage--plain/);
 await settings.getByLabel('Grid', { exact: true }).click();
 await expect(settings.getByLabel('Grid', { exact: true })).toHaveAttribute('aria-checked', 'false');
 await expect(settings).toContainText('not written into the GLB');
});
