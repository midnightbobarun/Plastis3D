// tests/harness/ui-geometry-render.spec.ts — the Render bar, running, stays clear of the other overlays (W6).
// Needs a hardware GPU like render.spec.ts, so it runs on macOS (Metal) and Windows (D3D11) only.
import { expect, test } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";
import { measureOverlays, OVERLAYS } from "./ui-geometry";

test.use({ launchOptions: { args: [`--use-angle=${process.platform === "win32" ? "d3d11" : "metal"}`, "--ignore-gpu-blocklist"] } });
test.skip(process.platform !== "darwin" && process.platform !== "win32", "Hardware GPU verification runs on macOS (Metal) and Windows (D3D11)");

for (const width of [285, 360, 480, 900, 1300]) {
  test(`overlays stay clear while Render runs at ${width}px`, async ({ page }) => {
    await gotoEditor(page);
    await page.evaluate((w) => {
      const route = document.querySelector("#route") as HTMLElement;
      route.style.width = `${w}px`;
      route.style.height = "760px";
      const mount = route.querySelector(".route-mount") as HTMLElement | null;
      if (mount) mount.style.height = "100%";
    }, width);
    const route = page.locator("#route");
    const render = route.getByRole("button", { name: "Render", exact: true });
    await expect(render).toBeEnabled({ timeout: 20000 });
    await render.click();
    await expect(route.getByText(/\d+ \/ 256 samples/)).toBeVisible();
    const r = await page.evaluate(measureOverlays, { stageSelector: "#route .p3d-stage", overlays: OVERLAYS });
    expect(r.present).toContain("renderBar");
    expect({ width, outside: r.outside, overlaps: r.overlaps }).toEqual({ width, outside: [], overlaps: [] });
  });
}
