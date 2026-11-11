// tests/harness/hidden-selection.spec.ts — Tier 4, Phase 1 (E-08).
//
// Hiding the selected node detaches the gizmo + helper while the
// selection stays live, and the pane badge reads "Box · Hidden" (mode
// label dropped). H again restores the gizmo and the badge. A hidden
// node is still selected in the outliner.
//
// H only exists on the editor route (the pane has no keyboard
// handling — G-01 is excluded), so the test selects the Box in BOTH
// surfaces: the pane (badge + gizmo assertions) and the editor (the H
// key). The shared scene record delivers the visibility change to the
// pane on the next poll.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  editorTelemetry,
  gotoMock,
  installErrorCollector,
  patchRequests,
  viewportTelemetry,
  waitForEditorPrimary,
  waitForPrimary,
} from "./pr5-helpers";

const badge = (page: import("@playwright/test").Page) =>
  page.locator('#panes button[aria-label="Open in editor"]');

test("hiding the selected node detaches the gizmo and badges it Hidden", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Select the Box in the pane and switch the pane to Move, so the
  // gizmo handle is visible to assert on.
  await clickWorldPoint(page, [0, 0.5, 0]);
  await waitForPrimary(page, "n_box");
  await page.locator('#panes button[aria-label="Move (W)"]').click();
  await expect
    .poll(async () => (await viewportTelemetry(page))?.gizmoHandleX, {
      timeout: 10000,
    })
    .not.toBeNull();
  await expect(badge(page)).toHaveText("Box · Move");

  // Select the Box in the editor too, switch the editor to Move (so
  // its gizmo handle is visible to assert on), then H to hide it.
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await page.keyboard.press("w");
  await expect
    .poll(async () => (await editorTelemetry(page))?.gizmoHandleX, {
      timeout: 10000,
    })
    .not.toBeNull();
  await page.keyboard.press("h");
  await expect
    .poll(async () => (await patchRequests(page)).length, { timeout: 10000 })
    .toBe(1);
  expect((await patchRequests(page))[0].body.ops).toEqual([
    { op: "update_node", id: "n_box", visible: false },
  ]);

  // The pane picks the change up on the poll: gizmo gone, badge Hidden.
  await expect(badge(page)).toHaveText("Box · Hidden", { timeout: 10000 });
  await expect
    .poll(async () => (await viewportTelemetry(page))?.gizmoHandleX, {
      timeout: 10000,
    })
    .toBeNull();
  // The editor's own gizmo detaches too.
  await expect
    .poll(async () => (await editorTelemetry(page))?.gizmoHandleX, {
      timeout: 10000,
    })
    .toBeNull();
  // ...while the hidden node stays selected in the outliner.
  const selectedRow = page.locator(
    '#route [role="treeitem"][aria-selected="true"]',
  );
  await expect(selectedRow).toHaveCount(1);
  await expect(selectedRow).toContainText("Box");

  // H again (once the poll has delivered rev 2): gizmo + badge return.
  await expect
    .poll(async () => (await editorTelemetry(page))?.sceneRev, {
      timeout: 10000,
    })
    .toBe(2);
  await page.keyboard.press("h");
  await expect
    .poll(async () => (await patchRequests(page)).length, { timeout: 10000 })
    .toBe(2);
  await expect(badge(page)).toHaveText("Box · Move", { timeout: 10000 });
  await expect
    .poll(async () => (await viewportTelemetry(page))?.gizmoHandleX, {
      timeout: 10000,
    })
    .not.toBeNull();
  expect(pageErrors).toEqual([]);
});
