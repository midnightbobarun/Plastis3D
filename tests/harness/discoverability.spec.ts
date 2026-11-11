// tests/harness/discoverability.spec.ts — Tier 4, Phase 2 (G-08).
//
// Multi-select is discoverable: a single selection shows the
// inspector hint line, and the pane badge's tooltip names the
// modifier. With several selected, the hint is gone and the
// "N nodes selected" line is present.
//
// Selection is per surface: the inspector hint is the EDITOR
// selection's (editor canvas), the badge is the PANE selection's
// (pane canvas) — so this spec selects the Box on each surface.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoMock,
  installErrorCollector,
  waitForEditorPrimary,
  waitForPrimary,
} from "./pr5-helpers";

test("single selection shows the hint; multi-select hides it", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Inspector hint: single selection in the EDITOR.
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await expect(
    page
      .locator("#route")
      .getByText("Shift-click another node to select several."),
  ).toBeVisible();

  // Badge tooltip: single selection in the PANE (Move mode, so the
  // badge reads "Box · Move"). The badge still navigates: its
  // accessible name stays "Open in editor", the modifier hint is the
  // title.
  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");
  await page.locator('#panes button[aria-label="Move (W)"]').click();
  const badge = page
    .locator("#panes")
    .getByRole("button", { name: "Open in editor" });
  await expect(badge).toHaveText("Box · Move");
  await expect(badge).toHaveAttribute(
    "title",
    "Shift-click to add to selection",
  );

  // Add the Sphere in the EDITOR: hint gone, "N nodes selected"
  // line present.
  // The editor canvas is tall and narrow on the mock page (it grows with the inspector), so the sphere's top
  // at x = 1.5 can fall outside the horizontal view: aim at the near side of the sphere instead.
  await clickWorldPoint(page, [1.1, 0.6, 0], { shift: true }, "#route canvas");
  await waitForEditorPrimary(page, "n_sphere");
  await expect(
    page
      .locator("#route")
      .getByText("Shift-click another node to select several."),
  ).toHaveCount(0);
  await expect(
    page.locator("#route").getByText("2 nodes selected"),
  ).toBeVisible();

  expect(pageErrors).toEqual([]);
});
