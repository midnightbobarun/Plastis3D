// tests/harness/shift-click.spec.ts — Tier 4, Phase 1 (E-07).
//
// Shift-click toggles like Ctrl/Cmd-click: Shift-click a selected
// node deselects it; Shift-click an unselected node adds it.
// (The PR5 helper holds Shift via keyboard.down/up — mouse.click's
// `modifiers` option does NOT set shiftKey on pointer events in this
// Chromium/CDP path.)
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoMock,
  installErrorCollector,
  viewportTelemetry,
  waitForPrimary,
} from "./pr5-helpers";

test("Shift-click toggles the selection", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Plain click selects the Box.
  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");

  // Shift-click the selected Box: deselected.
  await clickWorldPoint(page, [0, 0.5, 0], { shift: true });
  await expect
    .poll(async () => (await viewportTelemetry(page))?.selectedPrimary, {
      timeout: 10000,
    })
    .toBeNull();

  // Shift-click the unselected Sphere: added (primary).
  await clickWorldPoint(page, [1.5, 0.5, 0], { shift: true });
  await waitForPrimary(page, "n_sphere");

  // Shift-click the unselected Box: added — Box becomes primary.
  await clickWorldPoint(page, [0, 0.5, 0], { shift: true });
  await waitForPrimary(page, "n_box");
  const badge = page.locator(
    '#panes button[title="Shift-click to add to selection"]',
  );
  await expect(badge).toHaveText("2 nodes · Select");

  // Shift-click the Sphere again: removed from the multi-selection —
  // the badge drops back to the single Box. (The Box's own centre is
  // NOT clicked here: with two nodes selected the gizmo is attached
  // to the Box in translate mode, and a pointerdown on a gizmo handle
  // never picks — by design, per Viewport.tsx. The Sphere's centre is
  // clear of the gizmo, so it is the safe removal target.)
  await clickWorldPoint(page, [1.5, 0.5, 0], { shift: true });
  await expect(badge).toHaveText("Box · Select");
  expect(pageErrors).toEqual([]);
});
