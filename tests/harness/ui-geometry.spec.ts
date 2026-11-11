// tests/harness/ui-geometry.spec.ts — no overlay may overlap another or leave the stage, at any width (W6).
import { expect, test } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";
import { measureOverlays, OVERLAYS } from "./ui-geometry";

type Page = import("@playwright/test").Page;

const WIDTHS = [285, 360, 480, 900, 1300];

async function setRouteWidth(page: Page, width: number): Promise<void> {
  // The mock page stacks the route under the panes and gives it almost no height: size it like a real window.
  await page.evaluate((w) => {
    const route = document.querySelector("#route") as HTMLElement;
    route.style.width = `${w}px`;
    route.style.height = "760px";
    const mount = route.querySelector(".route-mount") as HTMLElement | null;
    if (mount) mount.style.height = "100%";
  }, width);
  await page.waitForTimeout(350);
}

async function report(page: Page) {
  return page.evaluate(measureOverlays, { stageSelector: "#route .p3d-stage", overlays: OVERLAYS });
}

function expectClean(state: string, width: number, r: Awaited<ReturnType<typeof report>>): void {
  expect({ state, width, outside: r.outside, overlaps: r.overlaps }).toEqual({ state, width, outside: [], overlaps: [] });
}

for (const width of WIDTHS) {
  test(`overlays are clear of each other at ${width}px: idle, selected, editing`, async ({ page }) => {
    await gotoEditor(page);
    await setRouteWidth(page, width);
    const idle = await report(page);
    expect(idle.present).toContain("dock");
    expectClean("idle", width, idle);

    // Stacked layouts show the outline under a "Scene" tab.
    const sceneTab = page.locator("#route").getByRole("tab", { name: "Scene" });
    if (await sceneTab.isVisible()) await sceneTab.click();
    await page.locator("#route").getByRole("treeitem", { name: /Box/ }).first().click();
    await page.waitForTimeout(300);
    expectClean("selected", width, await report(page));

    const tools = page.locator("#route").getByRole("button", { name: "Tools" });
    if (await tools.isVisible()) await tools.click();
    await page.locator("#route").getByRole("button", { name: "Edit mesh (M)" }).click();
    await page.waitForTimeout(500);
    const editing = await report(page);
    if (editing.present.includes("editBar")) expectClean("editing", width, editing);
  });
}
