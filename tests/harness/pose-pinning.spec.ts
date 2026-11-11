// tests/harness/pose-pinning.spec.ts — Tier 4, E-09 (restored).
//
// The orbit pose is per surface, in memory; it survives scene and
// source changes (E-09 re-plan, D-REPLAN-06 option (b): the pose is
// persisted outside the component in src/state/cameraPose.ts, keyed
// by chrome, read at camera creation and written in the mount-effect
// cleanup). Switching scenes must not move the camera. This pins the
// decided behaviour against a future "fix" that would reintroduce
// the reset.
//
// Restored from the Phase 3 deletion (D-IMPL-15): the original test
// failed then because a cold switch unmounted the Viewport and the
// camera remounted at (4, 3, 6). The warm-switch second half is new:
// switching back to the now-warm Demo Scene must preserve the pose
// too.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  viewportTelemetry,
} from "./pr5-helpers";

function closeTo(
  actual: [number, number, number] | undefined,
  want: [number, number, number],
  eps = 0.05,
): boolean {
  if (!actual) return false;
  return actual.every((v, i) => Math.abs(v - want[i]) < eps);
}

/**
 * Wait until the pane's orbit pose stops drifting, then return the
 * settled telemetry. A fixed wait is not enough: at SwiftShader frame
 * rates the damping momentum from a drag decays over seconds, so a
 * pose read 600 ms after mouse-up is still moving (~0.3 per
 * component over the next second) and the unmount writes a later,
 * drifted pose. Polling until two consecutive reads agree pins a
 * baseline the unmount write actually matches.
 */
async function waitForPoseSettled(
  page: import("@playwright/test").Page,
): Promise<{
  cameraPosition: [number, number, number];
  controlsTarget: [number, number, number];
}> {
  let prev = await viewportTelemetry(page);
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const cur = await viewportTelemetry(page);
    if (
      prev?.cameraPosition &&
      cur?.cameraPosition &&
      prev.controlsTarget &&
      cur.controlsTarget &&
      closeTo(cur.cameraPosition, prev.cameraPosition, 0.01) &&
      closeTo(cur.controlsTarget, prev.controlsTarget, 0.01)
    ) {
      return {
        cameraPosition: cur.cameraPosition,
        controlsTarget: cur.controlsTarget,
      };
    }
    prev = cur;
  }
  throw new Error("orbit pose did not settle");
}

test("switching scenes leaves the camera pose unchanged", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Orbit away from the default pose so "unchanged" is meaningful.
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy - 60, { steps: 10 });
  await page.mouse.up();

  // Settle the damping momentum before reading the baseline (see
  // waitForPoseSettled): a fixed 600 ms wait leaves the camera
  // still drifting at SwiftShader frame rates.
  const before = await waitForPoseSettled(page);
  const beforePos = before.cameraPosition;
  const beforeTarget = before.controlsTarget;
  expect(closeTo(beforePos, [4, 3, 6], 0.05)).toBe(false);

  // A second scene, then switch to it in the pane's scene picker.
  await page.evaluate(() =>
    (
      window as unknown as {
        __plastis3dMock: {
          __rest: (path: string, opts?: unknown) => Promise<unknown>;
        };
      }
    ).__plastis3dMock.__rest("/scenes", {
      method: "POST",
      body: { name: "Second" },
    }),
  );
  await page
    .locator("#panes select")
    .first()
    .selectOption({ label: "Second" });
  // The pane picks the new scene up (stats line names it).
  await expect(
    page.locator("#panes").getByText("Second · rev"),
  ).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600); // any post-switch settle

  // Cold switch: the Viewport unmounted while Second loaded, then
  // remounted — the restored pose must equal the orbited pose.
  const afterCold = await waitForPoseSettled(page);
  expect(closeTo(afterCold.cameraPosition, beforePos, 0.05)).toBe(true);
  expect(closeTo(afterCold.controlsTarget, beforeTarget, 0.05)).toBe(true);

  // Warm switch back: Demo Scene is cached now, so the Viewport
  // stays mounted — the pose must still be the orbited pose.
  await page
    .locator("#panes select")
    .first()
    .selectOption({ label: "Demo Scene" });
  await expect(
    page.locator("#panes").getByText("Demo Scene · rev"),
  ).toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(600); // any post-switch settle

  const afterWarm = await waitForPoseSettled(page);
  expect(closeTo(afterWarm.cameraPosition, beforePos, 0.05)).toBe(true);
  expect(closeTo(afterWarm.controlsTarget, beforeTarget, 0.05)).toBe(true);

  expect(pageErrors).toEqual([]);
});
