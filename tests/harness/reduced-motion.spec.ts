// tests/harness/reduced-motion.spec.ts — Tier 4, Phase 3 (G-03).
//
// `prefers-reduced-motion: reduce` turns OrbitControls damping off
// (mount read + change subscription); `no-preference` leaves it on.
// The mock matchMedia stub (0-E) drives both states.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  setReducedMotion,
  viewportTelemetry,
} from "./pr5-helpers";

test("prefers-reduced-motion disables damping, and back", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Default (no-preference): damping on.
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __plastis3dViewport?: { dampingEnabled?: boolean };
        }
      ).__plastis3dViewport?.dampingEnabled === true,
    { timeout: 10000 },
  );
  expect((await viewportTelemetry(page))?.dampingEnabled).toBe(true);

  // Mid-session OS change to reduce: damping off.
  await setReducedMotion(page, true);
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __plastis3dViewport?: { dampingEnabled?: boolean };
        }
      ).__plastis3dViewport?.dampingEnabled === false,
    { timeout: 10000 },
  );
  expect((await viewportTelemetry(page))?.dampingEnabled).toBe(false);

  // Back to no-preference: damping on again.
  await setReducedMotion(page, false);
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __plastis3dViewport?: { dampingEnabled?: boolean };
        }
      ).__plastis3dViewport?.dampingEnabled === true,
    { timeout: 10000 },
  );
  expect((await viewportTelemetry(page))?.dampingEnabled).toBe(true);

  expect(pageErrors).toEqual([]);
});
