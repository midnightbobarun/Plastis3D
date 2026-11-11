// tests/harness/dblclick-frame.spec.ts — Tier 4, Phase 5 (N-14).
//
// Double-click framing distinguishes empty vs selected: on an object
// it frames the selection; on empty space it frames the whole scene
// even when a selection is active. Whole-scene centre here is the
// bounds of built.root — the meshes plus the light/camera pick proxies
// (invisible r=0.2 spheres at [4,6,3] and [4,3,6], which
// Box3.expandByObject counts): x −1.75..4.345, y 0..6.282, z
// −0.5..6.329, centre (1.2977, 3.1408, 2.9143). The sphere centre is
// (1.5, 0.5, 0).
//
// Why the proxies extend past ±0.2: expandByObject transforms the
// geometry bounding-BOX corners, and the light/camera objects are
// rotated, so the rotated ±0.2 cube inflates to ±0.345 (light subtree
// x 3.655..4.345). The centre above is the Node-computed Box3 centre
// for the fixture build, and the live Frame button with no selection
// lands on exactly the same target.
//
// Note: the two click events before a double-click clear the selection
// when they land on empty space (pre-existing click behaviour), so the
// empty-space assertion is the framing only — the handler itself never
// clears. The object case runs first, at the default pose, because
// projectPoint assumes the default camera.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoMock,
  installErrorCollector,
  projectPoint,
  viewportTelemetry,
  waitForPrimary,
} from "./pr5-helpers";
import type { Page } from "@playwright/test";

const SPHERE = [1.5, 0.5, 0] as [number, number, number];
// PR32: "frame all" fits what is DRAWN (meshes and models), not the
// light and camera nodes: the boxes and sphere span x −1.75..2.0,
// y 0..1, z −0.5..0.5 — centre (0.125, 0.5, 0).
const SCENE_CENTRE = [0.125, 0.5, 0] as const;

function closeTo(
  actual: [number, number, number] | undefined,
  want: readonly [number, number, number],
  eps = 0.1,
): boolean {
  if (!actual) return false;
  return actual.every((v, i) => Math.abs(v - want[i]) < eps);
}

/** Double-click the canvas at a world-space point (default pose). */
async function dblclickWorldPoint(
  page: Page,
  point: [number, number, number],
): Promise<void> {
  await page.locator("canvas").first().scrollIntoViewIfNeeded();
  const { x, y } = await projectPoint(page, point);
  await page.mouse.dblclick(x, y);
}

/** Drag on the pane canvas to orbit away from the default pose. */
async function orbitAway(
  page: Page,
  dx = 120,
  dy = -60,
): Promise<void> {
  await page.locator("canvas").first().scrollIntoViewIfNeeded();
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
}

/**
 * Find a canvas corner that hits empty space: click it and check the
 * selection clears (a hit would select a node instead). The corner is
 * verified empty rather than assumed — after a close framing + orbit
 * the Box can cover the top-left corner, so the probe matters.
 */
async function findEmptyCorner(
  page: Page,
): Promise<{ x: number; y: number }> {
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const corners = [
    { x: box.x + 12, y: box.y + 12 },
    { x: box.x + box.width - 12, y: box.y + 12 },
    { x: box.x + 12, y: box.y + box.height - 12 },
    { x: box.x + box.width - 12, y: box.y + box.height - 12 },
  ];
  for (const corner of corners) {
    await page.mouse.click(corner.x, corner.y);
    await page.waitForTimeout(300);
    const primary = (await viewportTelemetry(page))?.selectedPrimary;
    if (primary === null || primary === undefined) return corner;
  }
  throw new Error("no empty canvas corner found");
}

test("N-14: double-click on the object frames the selection, on empty space frames all", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Object case, at the default pose: select the sphere, then
  // double-click it — the target lands on the sphere centre and the
  // selection survives.
  await clickWorldPoint(page, SPHERE);
  await waitForPrimary(page, "n_sphere");
  await dblclickWorldPoint(page, SPHERE);
  await page.waitForFunction(
    () =>
      Math.abs(
        (
          window.__plastis3dViewport as unknown as {
            controlsTarget: [number, number, number];
          }
        ).controlsTarget?.[0] - 1.5,
      ) < 0.001,
    { timeout: 10000 },
  );
  let telemetry = await viewportTelemetry(page);
  expect(closeTo(telemetry?.controlsTarget, SPHERE)).toBe(true);
  expect(telemetry?.selectedPrimary).toBe("n_sphere");

  // Empty case: reset to the default pose first (the object framing
  // left the camera close to the sphere, where a big orbit can swing
  // the Box over a corner), then orbit away a little so the scene
  // stays near the centre, then double-click a corner verified empty
  // by a probe click — the target lands on the whole-scene centre.
  await page
    .locator("#panes")
    .getByRole("button", { name: "Reset view" })
    .click();
  await page.waitForFunction(
    () =>
      Math.abs(
        (
          window.__plastis3dViewport as unknown as {
            controlsTarget: [number, number, number];
          }
        ).controlsTarget?.[0] - 0,
      ) < 0.001,
    { timeout: 10000 },
  );
  await orbitAway(page, 60, -30);
  const corner = await findEmptyCorner(page);
  await page.mouse.dblclick(corner.x, corner.y);
  await page.waitForFunction(
    () =>
      Math.abs(
        (
          window.__plastis3dViewport as unknown as {
            controlsTarget: [number, number, number];
          }
        ).controlsTarget?.[0] - 0.125,
      ) < 0.001,
    { timeout: 10000 },
  );
  telemetry = await viewportTelemetry(page);
  expect(closeTo(telemetry?.controlsTarget, SCENE_CENTRE)).toBe(true);

  expect(pageErrors).toEqual([]);
});
