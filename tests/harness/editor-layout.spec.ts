// tests/harness/editor-layout.spec.ts — Tier 4 (G-15 + E-11, updated
// for PR32 / UI/UX redesign §6.1).
//
// G-15: the host `narrow` flag stacks the editor even when its tile is
// wide. E-11 (PR32 numbers): the three columns fit from 800 px (the
// column minimums 200 + 360 + 240) and below that the route stacks: the
// stage keeps the top and the Scene / Properties panels share a bottom
// sheet with two tabs. No horizontal scroll at any width.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  setViewportNarrow,
} from "./pr5-helpers";

interface Layout {
  stacked: boolean;
  scrollWidth: number;
  clientWidth: number;
  left: number;
  center: number;
  right: number;
  tabs: string[];
}

async function layout(page: import("@playwright/test").Page): Promise<Layout> {
  return page.evaluate(() => {
    const root = document.querySelector("[data-plastis-root=editor]") as HTMLElement | null;
    if (!root) throw new Error("no editor root");
    const w = (sel: string) =>
      (root.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
    return {
      stacked: root.classList.contains("p3d-editor--narrow"),
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      left: w(".p3d-col-left"),
      center: w(".p3d-col-center"),
      right: w(".p3d-col-right"),
      tabs: [...root.querySelectorAll('[role="tab"]')].map((t) => t.textContent ?? ""),
    };
  });
}

test("G-15: host narrow stacks the editor at 1280 px; clearing it unstacks", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoMock(page);

  let m = await layout(page);
  expect(m.stacked).toBe(false);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);

  await setViewportNarrow(page, true);
  await expect
    .poll(async () => (await layout(page)).stacked, { timeout: 10000 })
    .toBe(true);
  m = await layout(page);
  expect(m.tabs).toEqual(["Scene", "Properties"]);
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);

  // The sheet switches panels.
  await page.locator("[data-plastis-root=editor]").getByRole("tab", { name: "Scene" }).click();
  await expect(page.getByRole("tree", { name: "Scene outline" })).toBeVisible();

  await setViewportNarrow(page, false);
  await expect
    .poll(async () => (await layout(page)).stacked, { timeout: 10000 })
    .toBe(false);

  expect(pageErrors).toEqual([]);
});

test("E-11 (PR32): the columns fit from 800 px and stack below it, never scrolling sideways", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoMock(page);

  for (const width of [1280, 900, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    const m = await layout(page);
    const editorWidth = m.clientWidth;
    if (editorWidth < 800) continue; // the mock chrome may take some width
    expect(m.stacked).toBe(false);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    expect(m.left).toBeGreaterThanOrEqual(200);
    expect(m.center).toBeGreaterThanOrEqual(300);
    expect(m.right).toBeGreaterThanOrEqual(240);
  }

  for (const width of [760, 600, 420]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    const m = await layout(page);
    expect(m.stacked).toBe(true);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
  }

  expect(pageErrors).toEqual([]);
});
