// tests/harness/loading-states.spec.ts — Tier 4, Phase 4 (G-12).
//
// Loading keeps the chrome mounted: the pane shows a skeleton in the
// canvas area with "Loading…" on the stats line, the editor shows
// "Loading…" in its toolbar with a skeleton in the canvas area and
// empty side columns, and the Scenes pane keeps its header with
// skeleton rows. The live region announces "Loading scene…" while a
// scene GET is in flight.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  viewportTelemetry,
} from "./pr5-helpers";

const MOCK_HOST = "/tests/harness/mock-host.html";

/** The text of every live region on the page (pane + editor). */
async function liveRegionTexts(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page
    .locator('[aria-live="polite"]')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
}

test("a delayed list GET shows skeletons and Loading… on every surface", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  // ?delayRest= delays the FIRST rest call of the page load — the list
  // GET (the list fetch runs before the scene fetch, with no await
  // before the rest call in either fetch function).
  await page.goto(`${MOCK_HOST}?delayRest=5000`);
  await page.locator("[data-plastis-root=editor]").waitFor({ state: "visible", timeout: 20000 });

  const panes = page.locator("#panes");
  const route = page.locator("#route");

  // Pane: skeleton fills the canvas area, stats read "Loading…",
  // header and toolbar stay mounted. Add appears only once the scene
  // spec exists, so it is asserted after the resolve below.
  await expect(
    panes.locator("[aria-label='Loading scene']"),
  ).toBeVisible({ timeout: 10000 });
  await expect(panes.getByText("Loading…").first()).toBeVisible();
  await expect(
    panes.getByRole("combobox", { name: "Scene" }),
  ).toBeDisabled();
  await expect(
    panes.getByRole("button", { name: "Select (Q)" }),
  ).toBeVisible();

  // Editor: "Loading…" in the toolbar, skeleton in the canvas area.
  // The skeleton is mounted through the load; the mock host's route
  // container has no intrinsic height during the empty-column loading
  // branch, so only its presence is asserted here (the pane skeleton
  // above is the visible-layout proof).
  await expect(route.getByText("Loading…").first()).toBeVisible();
  await expect(
    route.locator("[aria-label='Loading scene']"),
  ).toHaveCount(1);

  // Scenes pane: the header row stays, with skeleton rows below it.
  await expect(
    panes.getByRole("heading", { name: "Scenes" }),
  ).toBeVisible();
  await expect(
    panes.locator("[aria-label='Loading scenes']"),
  ).toHaveCount(3);

  // The list resolves: skeletons clear and the scene renders.
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  await expect(panes.locator("[data-slot='skeleton']")).toHaveCount(0);
  await expect(route.locator("[aria-label='Loading scene']")).toHaveCount(0);
  await expect(panes.locator("[aria-label='Loading scenes']")).toHaveCount(0);
  // PR32: the pane has no Add (§6.2); its dock is back once loaded.
  await expect(panes.getByRole("button", { name: "Move (W)" })).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("a delayed scene GET announces loading, then the revision on resolve", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);

  // A second scene, created through the mock's rest API.
  const created = (await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<unknown> })
      .__rest("/scenes", {
        method: "POST",
        body: { name: "Second" },
      }),
  )) as { scene: { id: string } };
  const secondId = created.scene.id;

  // Wait for the list poll to expose the new scene, so the delay below
  // applies to the scene GET rather than to a list refetch.
  const scenesPane = page
    .locator("#panes section")
    .filter({ has: page.getByRole("heading", { name: "Scenes" }) });
  await expect(
    scenesPane.getByRole("button", { name: /Second/ }),
  ).toBeVisible({ timeout: 10000 });

  // Hold the next rest call — the scene GET for the new scene — for
  // 3 s. The split selections mean the editor picker does not move the
  // pane, so switch the pane first; both surfaces then share the same
  // delayed scene record.
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __delayNextRest: (ms: number) => void })
      .__delayNextRest(3000),
  );
  // D-PR32-02: with the editor open, one Scenes-pane click moves both
  // the pane and the editor to the same (delayed) scene record.
  await scenesPane.getByRole("button", { name: /Second/ }).click();

  const panes = page.locator("#panes");
  const route = page.locator("#route");

  // While the scene GET is held: skeleton in the canvas area,
  // "Loading…" on the stats line and in the editor toolbar, and the
  // live region announces the load.
  await expect(
    panes.locator("[aria-label='Loading scene']"),
  ).toBeVisible({ timeout: 10000 });
  await expect(panes.getByText("Loading…").first()).toBeVisible();
  await expect(route.getByText("Loading…").first()).toBeVisible();
  await expect
    .poll(async () => liveRegionTexts(page), { timeout: 10000 })
    .toEqual(["Loading scene…", "Loading scene…"]);

  // On resolve: the canvas is back with the new scene, and the region
  // announces its revision.
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  await expect(panes.locator("[data-slot='skeleton']")).toHaveCount(0);
  await expect(panes.getByText("Second · rev 1")).toBeVisible();
  await expect
    .poll(async () => liveRegionTexts(page), { timeout: 10000 })
    .toEqual([
      "Scene updated to revision 1.",
      "Scene updated to revision 1.",
    ]);

  expect(pageErrors).toEqual([]);
});
