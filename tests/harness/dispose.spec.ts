// tests/harness/dispose.spec.ts — Tier 4 dispose test, relocated from
// T3 (Stage 4, PR4 §5).
//
// A real WebGLRenderer needs a WebGL context, which Node doesn't have,
// so this assertion lives here: the dispose harness (dispose.html)
// mounts the scene builder, rebuilds the fixture scene 10 times,
// runs the dispose routine, and reports renderer.info.memory before
// and after. The assertion is that the counters return to BASELINE —
// not absolute zero (dispose decrements only resources the test itself
// created; the grid and the PMREM environment stay live, so the
// baseline itself is non-zero).
import { test, expect } from "@playwright/test";

interface DisposeResult {
  error?: string;
  baselineGeometries?: number;
  baselineTextures?: number;
  baselinePrograms?: number;
  afterGeometries?: number;
  afterTextures?: number;
  afterPrograms?: number;
  builds?: number;
  stageCycles?: number;
  afterStageGeometries?: number;
  afterStageTextures?: number;
}

test("rebuild 10 times, dispose, memory counters return to baseline", async ({
  page,
}) => {
  await page.goto("/tests/harness/dispose.html");
  await expect(page.locator("#dispose-result")).not.toContainText("running", {
    timeout: 30000,
  });
  const raw = await page.locator("#dispose-result").textContent();
  const result = JSON.parse(raw ?? "{}") as DisposeResult;
  expect(result.error).toBeUndefined();
  expect(result.builds).toBe(10);

  // The baseline is non-zero: the grid and the PMREM environment are
  // live resources the loop never touches.
  expect(result.baselineGeometries).toBeGreaterThan(0);
  expect(result.baselineTextures).toBeGreaterThan(0);

  expect(result.afterGeometries).toBe(result.baselineGeometries);
  expect(result.afterTextures).toBe(result.baselineTextures);
  // PR32 / C-07: the stage effects leak nothing either.
  expect(result.stageCycles).toBe(10);
  expect(result.afterStageGeometries).toBe(result.baselineGeometries);
  expect(result.afterStageTextures).toBe(result.baselineTextures);
  // Programs are shared by cache key across builds; they must not grow.
  expect(result.afterPrograms).toBeLessThanOrEqual(
    result.baselinePrograms ?? 0,
  );
});
