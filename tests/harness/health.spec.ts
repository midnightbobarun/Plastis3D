// tests/harness/health.spec.ts — Tier 4 Health section (PR16).
//
// The section is closed, runs the check on request, shows findings as
// severity + sentence rows, refreshes when the scene changes, and fails
// softly. The mock stands in for the checker; the real checks are proved by
// tests/python/test_compat.py.
import { expect, test } from "@playwright/test";
import { clickWorldPoint, gotoEditor, installErrorCollector, mockReport, waitForEditorPrimary } from "./pr5-helpers";

type Page = import("@playwright/test").Page;

async function open(page: Page) {
  await page.locator("#route").getByRole("button", { name: /^Health/ }).click();
}

async function checks(page: Page): Promise<number> {
  return (await mockReport(page)).checkRequests.length;
}

const issue = (code: string, severity: string, message: string, where?: string) => ({ code, severity, message, where });

test("Health is closed at first and checks nothing until asked", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  const toggle = page.locator("#route").getByRole("button", { name: /^Health/ });
  await expect(toggle).toBeVisible();
  expect(await checks(page)).toBe(0);
  await open(page);
  await expect(page.locator("#route").getByText("changes nothing")).toBeVisible();
  expect(await checks(page)).toBe(0);
  expect(errors).toEqual([]);
});

test("a clean scene says so", async ({ page }) => {
  await gotoEditor(page);
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect(page.locator("#route .p3d-health-head").filter({ hasText: "No problems found" })).toBeVisible();
  await expect(page.locator("#route").getByRole("button", { name: /^Health · All clear|^Health.*All clear/ })).toBeVisible();
  expect(await checks(page)).toBe(1);
});

test("findings are rows with a severity word, the sentence and where", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() =>
    (window as unknown as { __plastis3dMock: { __setCheckReport: (f: unknown) => void } }).__plastis3dMock.__setCheckReport({
      ok: false,
      summary: { errors: 1, warnings: 1, infos: 1 },
      issues: [
        { code: "EXTERNAL_URI", severity: "error", message: "1 image points at a file outside the glTF.", where: "chair.glb" },
        { code: "MISSING_NORMALS", severity: "warning", message: "1 triangle mesh has no normals, so it will be shaded flat.", where: "plate.stl" },
        { code: "TEXTURE_LARGE", severity: "info", message: "A texture is 3000 x 2 pixels." },
      ],
      unchecked: [{ what: "degenerate triangles in big.glb", reason: "more than 500000 triangles" }],
    }),
  );
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  const route = page.locator("#route");
  await expect(route.locator(".p3d-health-head")).toHaveText("1 problem · 1 heads-up · 1 note");
  const rows = route.locator(".p3d-health-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("Problem. 1 image points at a file outside the glTF. (chair.glb)");
  await expect(rows.nth(0)).toHaveAttribute("data-severity", "error");
  await expect(rows.nth(0)).toHaveAttribute("title", "EXTERNAL_URI");
  await expect(rows.nth(1)).toContainText("Heads up. 1 triangle mesh has no normals");
  await expect(rows.nth(2)).toContainText("Note. A texture is 3000 x 2 pixels.");
  await expect(route.getByText(/Not checked: degenerate triangles in big\.glb \(more than 500000 triangles\)/)).toBeVisible();
});

test("the report survives a change of selection, and an edit refreshes it", async ({ page }) => {
  await gotoEditor(page);
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect(page.locator("#route .p3d-health-head")).toHaveText("No problems found");
  expect(await checks(page)).toBe(1);

  // Select the box: the same section, still showing the report, no new request.
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await expect(page.locator("#route .p3d-health-head")).toHaveText("No problems found");
  expect(await checks(page)).toBe(1);

  // An edit (scale X) bumps the revision: the checked scene is checked again.
  const scaleX = page.locator("#route").getByLabel("SX");
  await scaleX.fill("2");
  await page.keyboard.press("Enter");
  await expect.poll(() => checks(page), { timeout: 10000 }).toBe(2);
  const requests = (await mockReport(page)).checkRequests;
  expect(requests[1].revision).toBeGreaterThan(requests[0].revision);
});

test("a scene that was never checked is not checked by an edit", async ({ page }) => {
  await gotoEditor(page);
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await page.locator("#route").getByLabel("SX").fill("2");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await mockReport(page)).restRequests.some((r) => (r.opts as { method?: string } | undefined)?.method === "PATCH")).toBe(true);
  expect(await checks(page)).toBe(0);
});

test("a failed check says so and offers to try again", async ({ page }) => {
  await gotoEditor(page);
  await open(page);
  await page.evaluate(() => (window as unknown as { __plastis3dMock: { __failNextCheck: () => void } }).__plastis3dMock.__failNextCheck());
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect(page.locator("#route").getByRole("alert").filter({ hasText: "could not run the check" })).toBeVisible();
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect(page.locator("#route .p3d-health-head")).toBeVisible();
  expect(await checks(page)).toBe(2);
});

test("the score is labelled a heuristic, the numbers are shown, and the budget can change", async ({ page }) => {
  await gotoEditor(page);
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  const score = page.locator("#route .p3d-health-score");
  await expect(score).toContainText("100 out of 100 for a phone · heuristic");
  await expect(score).toContainText("not proof the scene is compatible");
  const numbers = page.locator("#route").getByRole("group", { name: "Budget" });
  await expect(numbers.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
  const region = page.locator("#route").getByRole("region", { name: "Health" });
  await expect(region.getByText("Triangles", { exact: true })).toBeVisible();
  await expect(region.getByText("376 of 100,000")).toBeVisible();
  expect((await mockReport(page)).checkRequests.at(-1)).toMatchObject({ kind: "analyze", budget: "mobile" });

  // Switching the budget re-runs the analysis against the new one.
  await numbers.getByRole("button", { name: "Desktop" }).click();
  await expect(score).toContainText("for a desktop · heuristic");
  await expect(page.locator("#route").getByText("376 of 500,000")).toBeVisible();
  expect((await mockReport(page)).checkRequests.at(-1)).toMatchObject({ kind: "analyze", budget: "desktop" });
});

test("a withheld score says why and shows no number", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() =>
    (window as unknown as { __plastis3dMock: { __setCheckReport: (f: unknown) => void } }).__plastis3dMock.__setCheckReport({
      ok: false,
      summary: { errors: 1, warnings: 0, infos: 0 },
      issues: [{ code: "ASSET_FILE_MISSING", severity: "error", message: "The stored file for this model is missing.", where: "chair.glb" }],
      analysis: {
        version: 1,
        budget: { name: "mobile", label: "Phone", triangles: 100000, drawCalls: 100, materials: 16, textureMiB: 64 },
        counts: { triangles: 0, drawCalls: 0, materials: 0, textures: 0, textureBytes: 0, assetBytes: 0 },
        score: { value: null, reason: "There are hard problems. Fix them first; a score would hide them.", label: "x", heuristic: true, weightsVersion: 1, basedOnPartialChecks: false, components: [] },
      },
    }),
  );
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  const score = page.locator("#route .p3d-health-score");
  await expect(score).toContainText("No score yet");
  await expect(score).toContainText("hard problems");
  await expect(score).not.toContainText("out of 100");
  await expect(page.locator("#route .p3d-health-row").first()).toContainText("Problem.");
});


test("prospective file measurements and source evidence retain their scope", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() =>
    (window as unknown as { __plastis3dMock: { __setCheckReport: (f: unknown) => void } }).__plastis3dMock.__setCheckReport({
      summary: { errors: 0, warnings: 1, infos: 0 },
      output: { bytes: 4096, jsonBytes: 2048, binaryBytes: 2020, nodes: 5, meshes: 2, primitives: 2, materials: 1, skins: 2, clips: 2, accessors: 8 },
      issues: [{ code: "MISSING_NORMALS", severity: "warning", message: "Output has no saved normals.", provenance: "output", where: "node n_box", nodeIds: ["n_box"], sourceFindings: [{ code: "MISSING_NORMALS", severity: "warning", message: "Source has no normals.", provenance: "source", where: "plate.stl" }] }],
      unchecked: [{ what: "output: tangent frame values", reason: "numeric frame validity is not certified" }],
    }),
  );
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  const output = page.locator('#route [data-testid="health-output"]');
  await expect(output).toContainText("4.0 KiB");
  await expect(output).toContainText("2.0 KiB");
  await expect(output).toContainText("5");
  const finding = page.locator("#route .p3d-health-row");
  await expect(finding).toContainText("Prospective output");
  await expect(finding).toContainText("Source has no normals. (plate.stl)");
  await expect(page.locator("#route").getByText(/numeric frame validity is not certified/)).toBeVisible();
});

test("comparison follows checked revisions and clears when the budget changes", async ({ page }) => {
  await gotoEditor(page);
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect(page.locator("#route .p3d-health-score")).toContainText("100 out of 100");
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await page.locator("#route").getByLabel("SX").fill("2");
  await page.keyboard.press("Enter");
  const comparison = page.locator('#route [data-testid="health-comparison"]');
  await expect(comparison).toContainText(/Checked revision \d+ → \d+/);
  await expect(comparison).toContainText("This surface session only");
  const first = await comparison.textContent();
  await page.locator("#route").getByRole("button", { name: "Check again" }).click();
  await expect(comparison).toHaveText(first!);
  await page.locator("#route").getByRole("button", { name: "Desktop", exact: true }).click();
  await expect(page.locator("#route .p3d-health-score")).toContainText("for a desktop");
  await expect(comparison).toHaveCount(0);
});

test("a delayed older budget reply cannot overwrite the newer report", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() => {
    const mock = (window as any).__plastis3dMock;
    mock.__setCheckReport({ summary: { errors: 0, warnings: 1, infos: 0 }, issues: [{ code: "OLD", severity: "warning", message: "Old phone report" }] });
    mock.__delayNextRestReply(1400, "/analyze?budget=mobile");
  });
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect.poll(() => checks(page)).toBe(1);
  await page.evaluate(() => (window as any).__plastis3dMock.__setCheckReport(null));
  await page.locator("#route").getByRole("button", { name: "Desktop", exact: true }).click();
  await expect(page.locator("#route .p3d-health-score")).toContainText("for a desktop");
  await page.waitForTimeout(1500); // Let the deliberately held old response arrive.
  await expect(page.locator("#route .p3d-health-score")).toContainText("for a desktop");
  await expect(page.locator("#route").getByText("Old phone report")).toHaveCount(0);
});

test("a finding opens the existing weld preview without mutation and selects its objects", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() => {
    const mock = (window as any).__plastis3dMock;
    mock.__setCheckReport({ summary: { errors: 0, warnings: 1, infos: 0 }, issues: [{ code: "DEGENERATE_TRIANGLES", severity: "warning", message: "Empty corners", nodeIds: ["n_box"] }] });
    mock.__setCleanup({ materialsMerged: [], materialsRemoved: [], groupsRemoved: [], nodesRepointed: [], assetsWelded: [{ assetId: "a1", name: "plate.stl", verticesRemoved: 2, trianglesRemoved: 1, bytesBefore: 2000, bytesAfter: 900, nodes: ["n_box"], becameDrawable: true }] });
  });
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await page.locator("#route").getByRole("button", { name: "Preview weld", exact: true }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await expect(preview).toContainText("Would meet the mesh and byte draw limits after Apply");
  await preview.getByRole("button", { name: "Show model plate.stl" }).click();
  await waitForEditorPrimary(page, "n_box");
  await expect(preview).toBeVisible();
  expect((await mockReport(page)).cleanupRequests).toEqual([expect.objectContaining({ dryRun: true, operations: ["weld"] })]);
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await mockReport(page)).cleanupRequests).toHaveLength(1);
});

test("object costs explain shared bytes and allow additive selection without losing focus", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(async () => {
    const mock = (window as any).__plastis3dMock;
    const report = await mock.__rest("/scenes/demo-scene/analyze");
    report.analysis.counts.perNode = [
      { nodeId: "n_box", name: "Box", kind: "mesh", visible: true, triangles: 12, vertices: 24, drawCalls: 1, referencedAssetBytes: 0 },
      { nodeId: "n_sphere", name: "Sphere", kind: "mesh", visible: true, triangles: 352, vertices: 221, drawCalls: 1, referencedAssetBytes: 0 },
    ];
    mock.__setCheckReport({ analysis: report.analysis });
  });
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await page.locator("#route").getByText("Object costs · base-pass estimates", { exact: true }).click();
  await expect(page.locator("#route").getByText(/Asset bytes are shared references/)).toBeVisible();
  await page.locator("#route").getByRole("button", { name: "Select Box", exact: true }).click();
  await expect(page.locator("#route").getByRole("button", { name: "Select Box", exact: true })).toBeFocused();
  await page.locator("#route").getByRole("button", { name: "Select Sphere", exact: true }).click({ modifiers: ["Shift"] });
  await waitForEditorPrimary(page, "n_sphere");
  await expect(page.locator('#route [role="treeitem"][aria-selected="true"]')).toHaveCount(2);
  await expect(page.locator("#route").getByRole("button", { name: "Select Sphere", exact: true })).toBeFocused();
});

test("a reply from an older gateway activation cannot populate a new check session", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() => {
    const mock = (window as any).__plastis3dMock;
    mock.__setCheckReport({ summary: { errors: 0, warnings: 1, infos: 0 }, issues: [{ code: "OLD", severity: "warning", message: "Old gateway report" }] });
    mock.__delayNextRestReply(1200, "/analyze?budget=mobile");
  });
  await open(page);
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect.poll(() => checks(page)).toBe(1);
  await page.evaluate(() => {
    const mock = (window as any).__plastis3dMock;
    mock.__setGatewayEpoch(2);
    mock.__setCheckReport(null);
  });
  await page.locator("#route").getByRole("button", { name: "Desktop", exact: true }).click();
  await page.locator("#route").getByRole("button", { name: "Check this scene" }).click();
  await expect(page.locator("#route .p3d-health-score")).toContainText("for a desktop");
  await page.waitForTimeout(1300);
  await expect(page.locator("#route").getByText("Old gateway report")).toHaveCount(0);
  await expect(page.locator('#route [data-testid="health-comparison"]')).toHaveCount(0);
});
