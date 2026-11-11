// tests/harness/slow-commit.spec.ts — Tier 4, Phase 4 (G-10).
//
// A gizmo commit held over the 1 s slow-patch threshold shows the
// Saving spinner (a GlyphSpinner, aria-label "Saving") in the toolbar
// / on the stats line while the PATCH is in flight, the preview does
// not snap back, and the spinner clears once the PATCH lands.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  editorTelemetry,
  gotoMock,
  installErrorCollector,
  setGizmoMode,
  viewportTelemetry,
  waitForEditorPrimary,
  waitForPrimary,
} from "./pr5-helpers";

async function armPatchHold(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => (window.__plastis3dMock as unknown as { __holdNextPatch: () => void }).__holdNextPatch());
}
async function releasePatch(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => (window.__plastis3dMock as unknown as { __releasePatch: () => void }).__releasePatch());
}

/** Drag the Translate X handle 80 px right on the pane viewport. */
async function dragTranslateX(
  page: import("@playwright/test").Page,
): Promise<void> {
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
  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  // Hold the PATCH past the 1 s slow-patch threshold, then release.
  await armPatchHold(page);
  await page.mouse.up();
}

test("a slow pane commit shows Saving on the stats line until the PATCH lands", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");
  await setGizmoMode(page, "Move (W)");

  await dragTranslateX(page);

  // The spinner appears while the PATCH is held…
  const spinner = page.locator("#panes [aria-label='Saving']");
  await expect(spinner).toBeVisible({ timeout: 5000 });

  // …the preview does not snap back while it is held…
  const mid = await viewportTelemetry(page);
  expect(mid?.selectedPosition?.[0] ?? 0).toBeGreaterThan(0.05);

  await releasePatch(page);
  // …and it clears once the PATCH lands, with the move kept.
  await expect(spinner).toHaveCount(0, { timeout: 10000 });
  const after = await viewportTelemetry(page);
  expect(after?.selectedPosition?.[0] ?? 0).toBeGreaterThan(0.05);

  expect(pageErrors).toEqual([]);
});

test("a slow editor commit shows Saving in the toolbar until the PATCH lands", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await page
    .locator("#route")
    .getByRole("button", { name: "Move (W)" })
    .click();
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __plastis3dViewportEditor?: { gizmoHandleX: unknown };
        }
      ).__plastis3dViewportEditor?.gizmoHandleX !== null,
    { timeout: 10000 },
  );
  const handle = await editorHandleInView(page);
  await page.mouse.move(handle!.x, handle!.y);
  await page.mouse.down();
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __plastis3dViewportEditor?: { gizmoDragging: boolean };
        }
      ).__plastis3dViewportEditor?.gizmoDragging === true,
    { timeout: 10000 },
  );
  await page.mouse.move(handle!.x + 80, handle!.y, { steps: 10 });
  await armPatchHold(page);
  await page.mouse.up();

  // The spinner appears in the editor toolbar while the PATCH is held…
  const spinner = page.locator("#route [aria-label='Saving']");
  await expect(spinner).toBeVisible({ timeout: 5000 });

  // …the preview does not snap back while it is held…
  const mid = await editorTelemetry(page);
  expect(mid?.selectedPosition?.[0] ?? 0).toBeGreaterThan(0.05);

  await releasePatch(page);
  // …and it clears once the PATCH lands, with the move kept.
  await expect(spinner).toHaveCount(0, { timeout: 10000 });
  const after = await editorTelemetry(page);
  expect(after?.selectedPosition?.[0] ?? 0).toBeGreaterThan(0.05);

  expect(pageErrors).toEqual([]);
});

/**
 * The editor's gizmo handle, scrolled into view.
 *
 * The editor's canvas grows with the Inspector (the mock host's route
 * has no fixed height), so the handle can sit below the fold — a mouse
 * move there never reaches the canvas. Scroll the handle to the
 * viewport's centre, then re-read its page position (it moves with the
 * scroll). Defined after the tests so their line numbers stay stable
 * for the plan/handoff references.
 */
async function editorHandleInView(
  page: import("@playwright/test").Page,
): Promise<{ x: number; y: number } | null> {
  await page.evaluate(() => {
    const tel = (
      window as unknown as {
        __plastis3dViewportEditor?: {
          gizmoHandleX?: { x: number; y: number } | null;
        };
      }
    ).__plastis3dViewportEditor;
    const handle = tel?.gizmoHandleX;
    if (!handle) return;
    window.scrollTo(0, handle.y + window.scrollY - window.innerHeight / 2);
  });
  await page.waitForTimeout(200);
  return (await editorTelemetry(page))?.gizmoHandleX ?? null;
}
