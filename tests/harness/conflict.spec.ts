// tests/harness/conflict.spec.ts — Tier 4, Stage 5 (PR5): a concurrent
// edit during a gizmo drag. The pointer-up PATCH carries the stale
// baseRevision, the mock rejects with REVISION_CONFLICT, the drag is
// discarded (the local transform rolls back), and the conflict toast
// appears in host notifications.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoMock,
  installErrorCollector,
  mockReport,
  patchCount,
  patchRequests,
  setGizmoMode,
  viewportTelemetry,
  waitForPrimary,
} from "./pr5-helpers";

test("a revision bump mid-drag rejects the PATCH and rolls the drag back", async ({
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

  const handle = await viewportTelemetry(page).then(
    (t) => t?.gizmoHandleX,
  );
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

  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  await page.mouse.up();

  // The PATCH was attempted with the stale pointer-down baseRevision.
  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(1);
  expect(patches[0].body.baseRevision).toBe(1);
  expect(patches[0].body.ops[0].id).toBe("n_box");

  // The conflict toast is in host notifications (COPY.conflictDrag).
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
      (n) => n.message === "The scene changed. Your last drag was not applied.",
    ),
  ).toHaveLength(1);

  // The local transform rolls back to the pointer-down transform once
  // the refetch lands (the bumped scene still has the Box at origin).
  await page.waitForFunction(
    () =>
      Math.abs(
        ((window.__plastis3dViewport as unknown as { selectedPosition: [number, number, number] | null })
          .selectedPosition?.[0] ?? 99),
      ) < 0.01,
    { timeout: 15000 },
  );
  const after = await viewportTelemetry(page);
  expect(after?.selectedPosition?.[0]).toBeCloseTo(0, 2);
  expect(after?.selectedPosition?.[1]).toBeCloseTo(0.5, 2);
  expect(after?.sceneRev).toBe(2);
  expect(after?.selectedPrimary).toBe("n_box");

  expect(pageErrors).toEqual([]);
});

test("Escape during a drag restores the pointer-down transform and writes nothing", async ({
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

  const handle = await viewportTelemetry(page).then(
    (t) => t?.gizmoHandleX,
  );
  await page.mouse.move(handle!.x, handle!.y);
  await page.mouse.down();
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoDragging: boolean })
        .gizmoDragging === true,
    { timeout: 10000 },
  );
  // The preview moved the Box while dragging.
  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  const mid = await viewportTelemetry(page);
  expect(mid?.selectedPosition?.[0]).toBeGreaterThan(0.05);

  // Escape cancels: the transform is restored, nothing is written.
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoDragging: boolean })
        .gizmoDragging === false,
    { timeout: 10000 },
  );
  const after = await viewportTelemetry(page);
  expect(after?.selectedPosition?.[0]).toBeCloseTo(0, 2);
  expect(after?.selectedPosition?.[1]).toBeCloseTo(0.5, 2);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(0);

  expect(pageErrors).toEqual([]);
});
