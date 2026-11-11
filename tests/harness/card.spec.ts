import { expect, test } from "@playwright/test";
import { gotoMock } from "./pr5-helpers";
test("directive validates attributes and waits for streaming", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => (window as any).__renderDirective("plastis3d", { scene: "../bad" }));
  await expect(page.locator("[data-plastis-card]")).toHaveCount(0);
  await page.evaluate(() => (window as any).__renderDirective("plastis3d", { scene: "demo-scene" }, { streaming: true }));
  await expect(page.locator("[data-plastis-card]")).toHaveCount(1);
  await expect(page.locator("#transcript button")).toHaveCount(0);
  await page.evaluate(() => (window as any).__renderDirective("plastis3d", { scene: "demo-scene" }, { streaming: false }));
  await expect(page.locator("#transcript button")).toHaveText("Open in editor");
});
test("six cards share one renderer and yield to an extra editor", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => {
    const transcript = document.getElementById("transcript")!;
    transcript.style.cssText = "position:fixed;inset:0;z-index:9999;overflow:auto;background:white";
    for (let i = 0; i < 6; i++) (window as any).__renderDirective("plastis3d", { scene: "demo-scene" }, { key: String(i) });
  });
  await expect(page.locator("#transcript canvas")).toHaveCount(1);
  await page.evaluate(() => {
    const card = document.querySelector("#transcript canvas")!.closest("[data-plastis-card]") as HTMLElement;
    card.style.display = "none";
  });
  await expect(page.locator("#transcript canvas")).toHaveCount(1);
  await page.evaluate(() => { (window as any).__removeExtraEditor = (window as any).__mountExtraEditor(); });
  await expect(page.locator("#transcript canvas")).toHaveCount(0);
  await page.evaluate(() => (window as any).__removeExtraEditor());
  await expect(page.locator("#transcript canvas")).toHaveCount(1);
});
test("unknown scene shows an inline error", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => (window as any).__renderDirective("plastis3d", { scene: "missing-scene" }));
  await page.locator("#transcript").scrollIntoViewIfNeeded();
  await expect(page.locator("#transcript")).toContainText("No Plastis3D scene named “missing-scene”.");
  await expect(page.locator("#transcript canvas")).toHaveCount(0);
});
