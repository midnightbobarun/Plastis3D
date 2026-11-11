// tests/harness/theme-probe.spec.ts — Tier 4, Phase 5 (N-01).
//
// The theme background comes from the canvas parent with a walk-up,
// not from document.body: the mock host paints the viewport pane's
// section a different colour from the body, and the canvas background
// (telemetry `background`) must follow the pane, not the body. A
// useTheme().themeName change re-reads the theme immediately — proven
// by watching the `themeReads` counter: after a poll tick lands, the
// next poll is ~4 s away, so a read within 2 s of the themeName change
// must be the trigger, not the poll.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  setThemeName,
  viewportTelemetry,
} from "./pr5-helpers";

async function paneBackground(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const section = document.querySelector("#panes > section");
    return section ? getComputedStyle(section).backgroundColor : null;
  });
}

test("N-01: the canvas background follows the pane, not the body", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // The mock page body has no background (transparent); paint the
  // viewport pane's section a distinct colour.
  await page.evaluate(() => {
    const canvas = document.querySelector("#panes canvas");
    const section = canvas?.closest("section");
    if (!section) throw new Error("no viewport pane section");
    (section as HTMLElement).style.backgroundColor = "rgb(10, 20, 30)";
  });
  expect(await paneBackground(page)).toBe("rgb(10, 20, 30)");

  // The 4 s poll re-reads the theme; the canvas background follows.
  await expect
    .poll(async () => (await viewportTelemetry(page))?.background, {
      timeout: 10000,
    })
    .toBe("#0a141e");

  expect(pageErrors).toEqual([]);
});

test("N-01: a themeName change re-reads the theme without waiting for the poll", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Wait for a poll tick to land, so the next poll is ~4 s away.
  const first = (await viewportTelemetry(page))?.themeReads ?? 0;
  await page.waitForFunction(
    (n) =>
      (window.__plastis3dViewport as unknown as { themeReads: number })
        .themeReads > n,
    first,
    { timeout: 10000 },
  );
  const tick = (await viewportTelemetry(page))?.themeReads ?? 0;

  // Paint the pane a new colour AND change the theme name. A read
  // within 2 s cannot be the 4 s poll — it must be the themeName trigger.
  await page.evaluate(() => {
    const canvas = document.querySelector("#panes canvas");
    const section = canvas?.closest("section");
    if (!section) throw new Error("no viewport pane section");
    (section as HTMLElement).style.backgroundColor = "rgb(40, 30, 20)";
  });
  await setThemeName(page, "noir");
  await page.waitForFunction(
    (n) =>
      (window.__plastis3dViewport as unknown as { themeReads: number })
        .themeReads > n,
    tick,
    { timeout: 2000 },
  );
  await expect
    .poll(async () => (await viewportTelemetry(page))?.background, {
      timeout: 5000,
    })
    .toBe("#281e14");

  expect(pageErrors).toEqual([]);
});
