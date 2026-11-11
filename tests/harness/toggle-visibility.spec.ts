// tests/harness/toggle-visibility.spec.ts — Tier 4, Phase 1 (E-06).
//
// H is a true toggle: select a node, press H (hidden), press H again
// (visible), assert the PATCH bodies. The second H needs the scene
// record to have picked up the first PATCH's revision bump (the mock
// does not broadcast; the 4 s poll delivers it), so the spec waits for
// the editor telemetry's sceneRev to advance before the second press.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  editorTelemetry,
  gotoEditor,
  installErrorCollector,
  patchRequests,
  waitForEditorPrimary,
} from "./pr5-helpers";

test("H hides the selection, H again unhides it", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);

  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");

  await page.keyboard.press("h");
  await expect
    .poll(async () => (await patchRequests(page)).length, { timeout: 10000 })
    .toBe(1);
  let patches = await patchRequests(page);
  expect(patches[0].body.ops).toEqual([
    { op: "update_node", id: "n_box", visible: false },
  ]);

  // Wait for the poll to deliver revision 2 before the second H, or
  // the second PATCH would 409 on a stale baseRevision.
  await expect
    .poll(async () => (await editorTelemetry(page))?.sceneRev, {
      timeout: 10000,
    })
    .toBe(2);

  await page.keyboard.press("h");
  await expect
    .poll(async () => (await patchRequests(page)).length, { timeout: 10000 })
    .toBe(2);
  patches = await patchRequests(page);
  expect(patches[1].body.ops).toEqual([
    { op: "update_node", id: "n_box", visible: true },
  ]);
  expect(patches[1].body.baseRevision).toBe(2);
  expect(pageErrors).toEqual([]);
});
