// tests/harness/store-failure.spec.ts — Tier 4, Phase 4 (G-14).
//
// A store failure is the host ErrorState (storeTitle / storeBody),
// never plain text echoing the raw server message. "Try again"
// refetches the failed GET. One failure after a prior success keeps
// the last good picture with "Scene store not answering" on the stats
// line; the second consecutive failure replaces the canvas with the
// full ErrorState (whose description is then storeRetry).
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  viewportTelemetry,
} from "./pr5-helpers";

const MOCK_HOST = "/tests/harness/mock-host.html";
const STORE_TITLE = "Plastis3D can't reach its scene store.";

async function setStoreDown(
  page: import("@playwright/test").Page,
  on: boolean,
): Promise<void> {
  await page.evaluate(
    (down) =>
      (
        window as unknown as {
          __plastis3dMock: { __setStoreDown: (on: boolean) => void };
        }
      ).__plastis3dMock.__setStoreDown(down),
    on,
  );
}

test("a store down at load shows the store ErrorState; Try again recovers", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  // ?storeDown=1 starts the page with the store down (the hook cannot
  // be armed before load any other way).
  await page.goto(`${MOCK_HOST}?storeDown=1`);
  await page.locator("[data-plastis-root=editor]").waitFor({ state: "visible", timeout: 20000 });

  const panes = page.locator("#panes");

  // The store ErrorState, with the Capabilities → Plugins sentence —
  // and no raw error text anywhere on the page.
  await expect(
    panes.getByText(STORE_TITLE).first(),
  ).toBeVisible({ timeout: 10000 });
  await expect(panes.getByText("Hermes didn't answer.").first()).toBeVisible();
  await expect(page.getByText("REST_FAILED")).toHaveCount(0);
  await expect(page.getByText("mock host: store is down")).toHaveCount(0);

  // The store recovers; "Try again" refetches the list GET and the
  // scene loads. The viewport pane is the first section; the Scenes
  // pane renders the same ErrorState, so the button lookup is scoped.
  await setStoreDown(page, false);
  await panes.getByRole("button", { name: "Try again" }).first().click();
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  await expect(panes.getByText(STORE_TITLE)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("a mid-session store failure degrades, then replaces the canvas", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);

  const panes = page.locator("#panes");
  await setStoreDown(page, true);

  // First failed poll: the last good picture stays, with the
  // "Scene store not answering" indicator (warn StatusDot) on the
  // stats line.
  await expect(
    panes.getByText("Hermes didn't answer.").first(),
  ).toBeVisible({ timeout: 15000 });
  await expect(panes.locator('[data-tone="warn"]')).toBeVisible();
  expect((await viewportTelemetry(page))?.triangles ?? 0).toBeGreaterThan(0);
  await expect(panes.locator("canvas")).toHaveCount(1);

  // Second failed poll: the full ErrorState replaces the canvas, and
  // its description is storeRetry (a GET previously succeeded).
  await expect(panes.getByText(STORE_TITLE).first()).toBeVisible({
    timeout: 15000,
  });
  await expect(
    panes.getByText("Hermes didn't answer.").first(),
  ).toBeVisible();
  await expect(panes.locator("canvas")).toHaveCount(0);
  await expect(page.getByText("REST_FAILED")).toHaveCount(0);
  await expect(page.getByText("mock host: store is down")).toHaveCount(0);

  // The store recovers; "Try again" refetches and the scene returns.
  await setStoreDown(page, false);
  await panes.getByRole("button", { name: "Try again" }).first().click();
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  await expect(panes.getByText(STORE_TITLE)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});


test("an absent route uses the plugin-off sentence and recovers", async ({ page }) => {
  await gotoMock(page);
  await page.evaluate(() => (window as unknown as { __plastis3dMock: { __setRouteAbsent(on: boolean): void } }).__plastis3dMock.__setRouteAbsent(true));
  const panes = page.locator("#panes");
  await expect(panes.getByText("Turn on plastis3d under Capabilities → Plugins.").first()).toBeVisible({ timeout: 15000 });
  await expect(panes.getByText(STORE_TITLE).first()).toBeVisible({ timeout: 15000 });
  await expect(panes.getByText("Turn on plastis3d under Capabilities → Plugins.").first()).toBeVisible();
  await setStoreDown(page, false);
  await panes.getByRole("button", { name: "Try again" }).first().click();
  await expect(panes.getByText(STORE_TITLE)).toHaveCount(0, { timeout: 20000 });
});
