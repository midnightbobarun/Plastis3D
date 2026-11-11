// tests/harness/gizmo.spec.ts — Tier 4, Stage 5 (PR5): the Translate
// gizmo drag. Dragging a handle on the canvas commits exactly one PATCH
// with one update_node op at the pointer-down baseRevision, and
// OrbitControls is disabled for the whole drag.
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

test("dragging the Translate X handle commits one PATCH for the node", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Select the Box by clicking it on the canvas.
  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");
  await setGizmoMode(page, "Move (W)");
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoHandleX: unknown })
        .gizmoHandleX !== null,
    { timeout: 10000 },
  );

  const patchesBefore = await patchRequests(page);
  expect(patchesBefore).toHaveLength(0);

  // Grab the X handle and drag it right on screen.
  const handle = await viewportTelemetry(page).then(
    (t) => t?.gizmoHandleX,
  );
  expect(handle).toBeTruthy();
  await page.mouse.move(handle!.x, handle!.y);
  await page.mouse.down();

  // OrbitControls is disabled while the gizmo drag is down.
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoDragging: boolean })
        .gizmoDragging === true,
    { timeout: 10000 },
  );
  const during = await viewportTelemetry(page);
  expect(during?.gizmoDragging).toBe(true);
  expect(during?.orbitEnabled).toBe(false);

  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  await page.mouse.up();

  // Exactly one PATCH, one update_node op, pointer-down baseRevision.
  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(1);
  expect(patches[0].path).toContain("/scenes/demo-scene");
  expect(patches[0].body.baseRevision).toBe(1);
  expect(patches[0].body.ops).toHaveLength(1);
  const op = patches[0].body.ops[0];
  expect(op.op).toBe("update_node");
  expect(op.id).toBe("n_box");
  // The Box moved along world +X (screen right at this camera). The
  // op carries the transform at the top level ({op, id, transform}).
  const t = (op.transform as { t: [number, number, number] }).t;
  expect(t[0]).toBeGreaterThan(0.05);
  expect(t[1]).toBeCloseTo(0.5, 6);
  expect(t[2]).toBeCloseTo(0, 6);

  // Orbit is re-enabled after the commit settles, and the telemetry
  // reports the new position.
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { gizmoDragging: boolean })
        .gizmoDragging === false,
    { timeout: 10000 },
  );
  const after = await viewportTelemetry(page);
  expect(after?.orbitEnabled).toBe(true);
  expect(after?.selectedPosition?.[0]).toBeGreaterThan(0.05);

  expect(pageErrors).toEqual([]);
});

test("a drag that moves nothing emits no PATCH", async ({ page }) => {
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
  // Release without moving: a no-op drag.
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(0);

  expect(pageErrors).toEqual([]);
});

test("clicking empty space clears the selection and detaches the gizmo", async ({
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

  // Click well away from any node: top-centre of the canvas (PR32: the
  // upper-left now holds the glass tool dock, the upper-right the view
  // gizmo).
  const box = await page.locator("canvas").first().boundingBox();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.06);
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { selectedPrimary: unknown })
        .selectedPrimary === null,
    { timeout: 10000 },
  );
  const after = await viewportTelemetry(page);
  expect(after?.gizmoHandleX).toBeNull();

  expect(pageErrors).toEqual([]);
});

test("F frames the selection (camera moves to fit the Box)", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");

  const before = await viewportTelemetry(page);
  expect(before?.cameraPosition?.[0]).toBeCloseTo(4, 6);
  expect(before?.cameraPosition?.[1]).toBeCloseTo(3, 6);
  expect(before?.cameraPosition?.[2]).toBeCloseTo(6, 6);

  // Frame the selection with the toolbar's Frame button. (The F
  // keyboard shortcut is the chrome agent's keybindings half — there
  // is no keydown handler on this branch yet; the button is the
  // frame request this branch owns.) The frame distance per the
  // design doc is radius / sin(min(vFov, hFov) / 2) * 1.15 along the
  // current view direction — about (1.49, 1.62, 2.24) from this
  // camera, with the target on the Box centre (0, 0.5, 0).
  await page.getByRole("button", { name: "Frame (F)" }).click();
  await page.waitForFunction(
    () =>
      Math.abs(
        ((window.__plastis3dViewport as unknown as { controlsTarget: [number, number, number] })
          .controlsTarget?.[1] ?? 99) - 0.5,
      ) < 0.0005, // PR32: Frame glides (360 ms); wait for it to land
    { timeout: 10000 },
  );
  const after = await viewportTelemetry(page);
  expect(after?.controlsTarget?.[0]).toBeCloseTo(0, 2);
  expect(after?.controlsTarget?.[1]).toBeCloseTo(0.5, 2);
  expect(after?.controlsTarget?.[2]).toBeCloseTo(0, 2);
  expect(after?.cameraPosition?.[0]).toBeCloseTo(1.49, 1);
  expect(after?.cameraPosition?.[1]).toBeCloseTo(1.62, 1);
  expect(after?.cameraPosition?.[2]).toBeCloseTo(2.24, 1);
  expect(after?.selectedPrimary).toBe("n_box");

  expect(pageErrors).toEqual([]);
});
