// tests/harness/ui-snapshots.spec.ts — optional pixel snapshots of the editor chrome (UI/UX polish W6).
//
// Off by default: pixel baselines depend on the machine's fonts, so they are macOS-only and opt-in. Run with
//   P3D_SNAPSHOTS=1 npx playwright test --config playwright.config.ts ui-snapshots   (add --update-snapshots to refresh)
// The 3D canvas is hidden (overlays stay visible); the geometry specs are the always-on layout guard.
import { expect, test } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

test.skip(process.env.P3D_SNAPSHOTS !== "1" || process.platform !== "darwin", "Pixel snapshots are opt-in (P3D_SNAPSHOTS=1) and macOS-only");

for (const width of [285, 480, 900, 1300]) {
  test(`editor chrome at ${width}px`, async ({ page }) => {
    await gotoEditor(page);
    await page.evaluate((w) => {
      const route = document.querySelector("#route") as HTMLElement;
      route.style.width = `${w}px`;
      route.style.height = "760px";
      const mount = route.querySelector(".route-mount") as HTMLElement | null;
      if (mount) mount.style.height = "100%";
    }, width);
    await page.waitForTimeout(600);
    await expect(page.locator("#route")).toHaveScreenshot(`editor-${width}.png`, {
      style: "canvas { visibility: hidden !important; }",
      maxDiffPixelRatio: 0.02,
      animations: "disabled",
    });
  });
}
