// tests/harness/zoom-target.spec.ts — Tier 4, Phase 3 (E-05).
//
// Wheel zoom tracks the orbit target, not the cursor
// (`zoomToCursor` stays false): with the cursor off-centre, a wheel
// step changes the camera-to-target distance but not its direction.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  viewportTelemetry,
} from "./pr5-helpers";

test("wheel zoom moves toward the orbit target, not the cursor", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Cursor well off-centre (upper-left quadrant of the pane canvas).
  const box = await page.locator("canvas").first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const cx = box.x + box.width * 0.25;
  const cy = box.y + box.height * 0.25;
  await page.mouse.move(cx, cy);

  const before = await viewportTelemetry(page);
  const beforePos = before?.cameraPosition;
  const beforeTarget = before?.controlsTarget;
  if (!beforePos || !beforeTarget) throw new Error("no telemetry pose");
  const beforeDir = beforePos.map((v, i) => v - beforeTarget[i]);
  const beforeDist = Math.hypot(...beforeDir);

  // Wheel up: zoom in (distance shrinks).
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(800);

  const after = await viewportTelemetry(page);
  const afterPos = after?.cameraPosition;
  const afterTarget = after?.controlsTarget;
  if (!afterPos || !afterTarget) throw new Error("no telemetry pose");
  const afterDir = afterPos.map((v, i) => v - afterTarget[i]);
  const afterDist = Math.hypot(...afterDir);

  // Distance shrank, direction unchanged (cursor zoom would have
  // swung the direction toward the off-centre cursor).
  expect(afterDist).toBeLessThan(beforeDist - 0.1);
  const beforeUnit = beforeDir.map((v) => v / beforeDist);
  const afterUnit = afterDir.map((v) => v / afterDist);
  const dot = beforeUnit.reduce((s, v, i) => s + v * afterUnit[i], 0);
  expect(dot).toBeGreaterThan(0.999);

  expect(pageErrors).toEqual([]);
});
