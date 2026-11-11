// tests/harness/multi-select.spec.ts — Tier 4, Stage 5 (PR5): the
// multi-select gizmo. TRANSLATE ONLY: the drag's world-space
// translation delta is applied to every selected node, and the drag
// commits exactly ONE PATCH with one update_node op per selected node
// (one history entry). Rotate/scale with >1 selected stay in
// translate mode (enforced in the manager, not just the toolbar).
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoMock,
  installErrorCollector,
  patchCount,
  patchRequests,
  setGizmoMode,
  viewportTelemetry,
  waitForPrimary,
} from "./pr5-helpers";

test("one drag moves two selected nodes in a single PATCH", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Select the Box, then ask for Rotate while one node is selected.
  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");
  await setGizmoMode(page, "Rotate (E)");
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoMode: string })
        .gizmoMode === "rotate",
    { timeout: 10000 },
  );

  // Shift-click the Sphere to add it. The Shift-click lands on the
  // Sphere's upper area (projected (1.5, 0.85, 0)) so the pointer is
  // clear of the Box's X-handle strip.
  await clickWorldPoint(page, [1.5, 0.85, 0], { shift: true });
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { selectedPrimary: string })
        .selectedPrimary === "n_sphere",
    { timeout: 10000 },
  );

  // With two selected the manager forces translate (enforced in the
  // manager, not just the toolbar): the effective mode drops back to
  // translate even though Rotate was requested, and the toolbar's E/R
  // buttons disable.
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoMode: string })
        .gizmoMode === "translate",
    { timeout: 10000 },
  );
  // Scoped to #panes: the editor route renders the same mode buttons
  // with the same aria-labels (G-10).
  const rotateButton = page
    .locator("#panes")
    .getByRole("button", { name: "Rotate (E)" });
  await expect(rotateButton).toBeDisabled();
  const scaleButton = page
    .locator("#panes")
    .getByRole("button", { name: "Scale (R)" });
  await expect(scaleButton).toBeDisabled();

  const handle = await viewportTelemetry(page).then(
    (t) => t?.gizmoHandleX,
  );
  expect(handle).toBeTruthy();
  await page.mouse.move(handle!.x, handle!.y);
  await page.mouse.down();
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoDragging: boolean })
        .gizmoDragging === true,
    { timeout: 10000 },
  );
  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  await page.mouse.up();

  // One PATCH, one update_node op per selected node, one history entry.
  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(1);
  expect(patches[0].body.baseRevision).toBe(1);
  expect(patches[0].body.ops).toHaveLength(2);
  const byId = new Map(
    patches[0].body.ops.map((op) => [op.id as string, op]),
  );
  expect(byId.has("n_box")).toBe(true);
  expect(byId.has("n_sphere")).toBe(true);

  // Both nodes moved by the SAME world-space X delta: the Box from
  // x=0 and the Sphere from x=1.5. (The ops carry transform at the
  // top level: {op, id, transform}.)
  const boxT = (
    byId.get("n_box")!.transform as { t: [number, number, number] }
  ).t;
  const sphereT = (
    byId.get("n_sphere")!.transform as { t: [number, number, number] }
  ).t;
  expect(boxT[0]).toBeGreaterThan(0.05);
  expect(sphereT[0] - 1.5).toBeCloseTo(boxT[0], 6);
  expect(boxT[1]).toBeCloseTo(0.5, 6);
  expect(sphereT[1]).toBeCloseTo(0.5, 6);

  expect(pageErrors).toEqual([]);
});
