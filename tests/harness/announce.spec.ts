// tests/harness/announce.spec.ts — Tier 4, Phase 4 (G-06).
//
// The shared announcer store (0-B) drives both surfaces' live
// regions: a broadcast-driven revision change announces once across
// surfaces, a poll refetch never re-announces, and a toast announces
// its text once through the region.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  emitSceneChanged,
  gotoMock,
  installErrorCollector,
  mockReport,
  patchCount,
  setGizmoMode,
  viewportTelemetry,
  waitForPrimary,
} from "./pr5-helpers";

/** The text of every live region on the page (pane + editor). */
async function liveRegionTexts(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return page
    .locator('[aria-live="polite"]')
    .evaluateAll((els) => els.map((el) => (el.textContent ?? "").trim()));
}

test("a broadcast revision announces once on both surfaces; the poll does not re-announce", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Both surfaces render a live region, and both read the same
  // store — the first-load announce lands in both.
  await expect
    .poll(async () => liveRegionTexts(page), { timeout: 20000 })
    .toEqual([
      "Scene updated to revision 1.",
      "Scene updated to revision 1.",
    ]);

  // A broadcast with a new revision announces once (the broadcast
  // path and the fetch-arrival path share one dedup key).
  const newRevision = await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __bumpRevision: () => number })
      .__bumpRevision(),
  );
  expect(newRevision).toBe(2);
  await emitSceneChanged(page, "demo-scene", 2);
  await expect
    .poll(async () => liveRegionTexts(page), { timeout: 10000 })
    .toEqual([
      "Scene updated: 0 changes.",
      "Scene updated: 0 changes.",
    ]);

  // The 4 s poll refetches the same revision and does NOT re-announce:
  // the region still says revision 2 after a full poll cycle.
  await page.waitForTimeout(5000);
  expect(await liveRegionTexts(page)).toEqual([
    "Scene updated: 0 changes.",
    "Scene updated: 0 changes.",
  ]);

  expect(pageErrors).toEqual([]);
});

test("a toast announces its text once through the live region", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");
  await setGizmoMode(page, "Move (W)");
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoHandleX: unknown })
        .gizmoHandleX !== null,
    { timeout: 10000 },
  );
  const handle = (await viewportTelemetry(page))?.gizmoHandleX;
  await page.mouse.move(handle!.x, handle!.y);
  await page.mouse.down();
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoDragging: boolean })
        .gizmoDragging === true,
    { timeout: 10000 },
  );

  // A concurrent external edit lands while the drag is down.
  const newRevision = await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __bumpRevision: () => number })
      .__bumpRevision(),
  );
  expect(newRevision).toBe(2);

  // The store is down for the refetch that follows the conflict, so
  // no revision announcement replaces the toast text in the region
  // (storeDown fails GETs only — the PATCH still goes through).
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __setStoreDown: (on: boolean) => void })
      .__setStoreDown(true),
  );

  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  await page.mouse.up();

  // The PATCH was attempted with the stale pointer-down baseRevision.
  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);

  // The conflict toast is in host notifications exactly once…
  await page.waitForFunction(
    () =>
      (window.__plastis3dMock as unknown as { notifications: Array<{ message: string }> })
        .notifications.some(
          (n) => n.message === "The scene changed. Your last drag was not applied.",
        ),
    { timeout: 10000 },
  );
  const report = await mockReport(page);
  expect(
    report.notifications.filter(
      (n) =>
        n.message === "The scene changed. Your last drag was not applied.",
    ),
  ).toHaveLength(1);

  // …and its text is the live region's announcement (the visual toast
  // and the region carry the same sentence, once each). The pane's
  // region can unmount while the store is exhausted (its ErrorState
  // branch renders no LiveRegion), so assert that every mounted region
  // carries the sentence — not how many there are.
  await expect
    .poll(
      async () => {
        const texts = await liveRegionTexts(page);
        return (
          texts.length > 0 &&
          texts.every(
            (t) => t === "The scene changed. Your last drag was not applied.",
          )
        );
      },
      { timeout: 10000 },
    )
    .toBe(true);

  // The store recovers: the next poll refetches revision 2. A poll
  // never announces (D-IMPL-17 / G-06), so the region keeps the toast
  // text — the recovery is verified through the scene revision, not
  // through the region.
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __setStoreDown: (on: boolean) => void })
      .__setStoreDown(false),
  );
  await expect
    .poll(async () => (await viewportTelemetry(page))?.sceneRev ?? 0, {
      timeout: 15000,
    })
    .toBe(2);

  expect(pageErrors).toEqual([]);
});
