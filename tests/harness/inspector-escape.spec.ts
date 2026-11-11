// tests/harness/inspector-escape.spec.ts — Tier 4, Phase 1 (E-04).
//
// Escape in an inspector field reverts the draft and never writes:
// a bad scale + Escape sends no PATCH and the field shows the last
// good value; a good value + Enter / blur still commits (happy-path
// regression). Verified in the harness per D-PLAN-06 (real field,
// real DOM focus), not only in Vitest — the repo has no Inspector
// component tests, which is why this shipped.
//
// Audit note: Inspector.tsx has exactly three onBlur→commit pairs —
// NumberField, HexField, and the Name field — and all three carry the
// cancelled flag. The Name-field Escape path is also covered by the
// existing "keybindings in the mock" test in editor.spec.ts.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoEditor,
  installErrorCollector,
  patchCount,
  patchRequests,
  waitForEditorPrimary,
} from "./pr5-helpers";

/** Select the Box in the editor viewport and return the Scale X field. */
async function selectBoxScaleX(page: import("@playwright/test").Page) {
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  const scaleX = page.locator("#route").getByLabel("SX");
  await expect(scaleX).toBeVisible();
  await expect(scaleX).toHaveValue("1");
  return scaleX;
}

test("Escape in a number field sends no PATCH and shows the last good value", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);
  const scaleX = await selectBoxScaleX(page);

  await scaleX.fill("abc");
  await expect(scaleX).toHaveValue("abc");
  await page.keyboard.press("Escape");

  // No PATCH at all, and the field reverted to the last good value.
  await expect(scaleX).toHaveValue("1");
  expect(await patchCount(page)).toBe(0);
  expect(pageErrors).toEqual([]);
});

test("Enter in a number field commits (happy path)", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);
  const scaleX = await selectBoxScaleX(page);

  await scaleX.fill("2");
  await page.keyboard.press("Enter");

  // Exactly one PATCH, one update_node op, scale X set to 2.
  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(1);
  expect(patches[0].path).toBe("/scenes/demo-scene");
  expect(patches[0].body.ops).toHaveLength(1);
  const op = patches[0].body.ops[0];
  expect(op.op).toBe("update_node");
  expect(op.id).toBe("n_box");
  const transform = op.transform as {
    t: number[];
    r: number[];
    s: number[];
  };
  // PR32: uniform scale is locked by default (redesign §7.1 AxisRow).
  expect(transform.s).toEqual([2, 2, 2]);
  expect(pageErrors).toEqual([]);
});

test("blur in a number field commits (happy path)", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);
  const scaleX = await selectBoxScaleX(page);

  await scaleX.fill("3");
  // Tab out of the field: blur commits.
  await page.keyboard.press("Tab");

  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  const op = patches[0].body.ops[0];
  expect(op.op).toBe("update_node");
  expect(op.id).toBe("n_box");
  const transform = op.transform as {
    t: number[];
    r: number[];
    s: number[];
  };
  expect(transform.s).toEqual([3, 3, 3]);
  expect(pageErrors).toEqual([]);
});
