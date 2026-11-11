// tests/harness/undo-gate.spec.ts — Tier 4, Phase 1 (N-11).
//
// Mod+Z / Mod+Shift+Z with empty history are silent no-ops: no toast,
// no PATCH. Once an edit creates history, Mod+Z undoes it (positive
// control — the gate opens when the envelope says canUndo).
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  editorTelemetry,
  gotoEditor,
  installErrorCollector,
  mockReport,
  patchCount,
  patchRequests,
  waitForEditorPrimary,
} from "./pr5-helpers";

test("keyboard undo at empty history is silent; after an edit it undoes", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);

  // Fresh scene: empty history. Focus the editor root and press Mod+Z
  // / Mod+Shift+Z — nothing may happen: no toast, no PATCH.
  await page.locator("[data-plastis-root=editor]").click();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(1500);
  expect((await mockReport(page)).notifications).toEqual([]);
  expect(await patchCount(page)).toBe(0);

  // Make an edit (H hides the Box — one PATCH, one history entry),
  // wait for the poll to deliver rev 2, then Mod+Z undoes it.
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await page.keyboard.press("h");
  await expect
    .poll(async () => (await patchRequests(page)).length, { timeout: 10000 })
    .toBe(1);
  await expect
    .poll(async () => (await editorTelemetry(page))?.sceneRev, {
      timeout: 10000,
    })
    .toBe(2);

  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await patchRequests(page)).length, { timeout: 10000 })
    .toBe(2);
  const patches = await patchRequests(page);
  expect(patches[1].body.ops).toEqual([{ op: "undo" }]);
  // Still no toast: the undo itself succeeded.
  expect((await mockReport(page)).notifications).toEqual([]);
  expect(pageErrors).toEqual([]);
});
