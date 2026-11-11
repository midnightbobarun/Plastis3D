// tests/harness/reset-view.spec.ts — Tier 4, Phase 3 (G-02 + G-04, joint).
//
// Reset view on both surfaces restores the default orbit pose
// (4, 3, 6) / target (0, 0, 0) and writes nothing (no PATCH). The
// narrow pane (host `narrow` flag, or width < 360) shows the
// five-button icon-only row (Select, Move, Rotate, Scale, Frame) and
// hides Grid / Wireframe / Reset view — while `wide` still gates ONLY
// the header Add menu, so a host-narrow 420 px pane keeps it.
import { expect, test } from "@playwright/test";
import {
  editorTelemetry,
  gotoMock,
  installErrorCollector,
  patchCount,
  setViewportNarrow,
  viewportTelemetry,
} from "./pr5-helpers";

const POSE = { pos: [4, 3, 6] as const, target: [0, 0, 0] as const };

function closeTo(
  actual: [number, number, number] | undefined,
  want: readonly [number, number, number],
  eps = 0.05,
): boolean {
  if (!actual) return false;
  return actual.every((v, i) => Math.abs(v - want[i]) < eps);
}

/** Drag on a canvas to orbit away from the default pose. */
async function orbitAway(
  page: import("@playwright/test").Page,
  canvasSelector: string,
): Promise<void> {
  // The editor route's canvas sits below the fold; boundingBox is
  // viewport-relative, so scroll it into view before projecting
  // (the same reason clickWorldPoint scrolls first).
  await page.locator(canvasSelector).first().scrollIntoViewIfNeeded();
  const box = await page.locator(canvasSelector).first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy - 60, { steps: 10 });
  await page.mouse.up();
  // Let damping settle before reading the pose.
  await page.waitForTimeout(600);
}

test("Reset view restores the default pose on the pane and writes nothing", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  await orbitAway(page, "canvas");
  const before = await viewportTelemetry(page);
  expect(before?.cameraPosition).toBeDefined();
  expect(
    closeTo(before?.cameraPosition, POSE.pos, 0.05),
  ).toBe(false);

  const patchesBefore = await patchCount(page);
  await page
    .locator("#panes")
    .getByRole("button", { name: "Reset view" })
    .click();
  await page.waitForFunction(
    () => {
      const t = (
        window as unknown as {
          __plastis3dViewport?: {
            cameraPosition: [number, number, number];
            controlsTarget: [number, number, number];
          };
        }
      ).__plastis3dViewport;
      if (!t) return false;
      const close = (a: [number, number, number], b: readonly [number, number, number]) =>
        a.every((v, i) => Math.abs(v - b[i]) < 0.05);
      return close(t.cameraPosition, [4, 3, 6]) && close(t.controlsTarget, [0, 0, 0]);
    },
    { timeout: 10000 },
  );
  // No PATCH: Reset view does not write the scene.
  await page.waitForTimeout(500);
  expect(await patchCount(page)).toBe(patchesBefore);

  expect(pageErrors).toEqual([]);
});

test("Reset view restores the default pose in the editor", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  await orbitAway(page, "#route canvas");
  const before = await editorTelemetry(page);
  expect(before?.cameraPosition).toBeDefined();
  expect(closeTo(before?.cameraPosition, POSE.pos, 0.05)).toBe(false);

  await page
    .locator("#route")
    .getByRole("button", { name: "Reset view" })
    .click();
  await page.waitForFunction(
    () => {
      const t = (
        window as unknown as {
          __plastis3dViewportEditor?: {
            cameraPosition: [number, number, number];
            controlsTarget: [number, number, number];
          };
        }
      ).__plastis3dViewportEditor;
      if (!t) return false;
      const close = (a: [number, number, number], b: readonly [number, number, number]) =>
        a.every((v, i) => Math.abs(v - b[i]) < 0.05);
      return close(t.cameraPosition, [4, 3, 6]) && close(t.controlsTarget, [0, 0, 0]);
    },
    { timeout: 10000 },
  );

  expect(pageErrors).toEqual([]);
});

test("PR32: the pane's glass dock keeps every control reachable, narrow or not, and has no Add", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.setViewportSize({ width: 840, height: 900 });
  await gotoMock(page);
  const panes = page.locator("#panes");
  const controls = ["Select (Q)", "Move (W)", "Rotate (E)", "Scale (R)", "Frame (F)", "Reset view", "Grid (G)", "Wireframe", "View options"];

  for (const narrow of [false, true, false]) {
    await setViewportNarrow(page, narrow);
    for (const name of controls) {
      await expect(panes.getByRole("button", { name, exact: true }).first()).toBeVisible();
    }
    // Redesign §6.2: no Add in the pane — the editor owns creation.
    await expect(panes.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  }

  expect(pageErrors).toEqual([]);
});
