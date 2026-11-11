// tests/harness/tidy.spec.ts — Tier 4 Tidy up in the Health section (PR18).
//
// A preview first (a dry run that writes nothing), then Apply, which is one
// request and one revision; Cancel and a changed scene retire the preview;
// nothing to tidy says so. The mock returns canned changes (the real
// operations are proved by tests/python/test_cleanup.py).
import { expect, test } from "@playwright/test";
import { gotoEditor, installErrorCollector, mockReport } from "./pr5-helpers";

type Page = import("@playwright/test").Page;

const CHANGES = {
  materialsMerged: [{ from: "m_b", into: "m_a" }],
  materialsRemoved: ["m_idle"],
  groupsRemoved: [{ id: "g1", name: "Empty pivot" }],
  nodesRepointed: ["n2"],
};

async function setCleanup(page: Page, changes: unknown) {
  await page.evaluate(
    (c) => (window as unknown as { __plastis3dMock: { __setCleanup: (x: unknown) => void } }).__plastis3dMock.__setCleanup(c),
    changes,
  );
}

async function openHealth(page: Page) {
  await page.locator("#route").getByRole("button", { name: /^Health/ }).click();
}

const requests = async (page: Page) => (await mockReport(page)).cleanupRequests;

test("Tidy up previews what it will do, writes nothing, then applies in one request", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  await setCleanup(page, CHANGES);
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();

  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await expect(preview.getByText("Merge 1 identical material into the first of each.")).toBeVisible();
  await expect(preview.getByText("Remove 1 unused material.")).toBeVisible();
  await expect(preview.getByText("Remove 1 empty group.")).toBeVisible();
  await expect(preview.getByText("m_b → m_a, m_idle, Empty pivot")).toBeVisible();
  expect(await requests(page)).toEqual([expect.objectContaining({ dryRun: true })]);

  await preview.getByRole("button", { name: "Tidy up", exact: true }).click();
  await expect(page.locator("#route").getByText(/Tidied up\. Undo/)).toBeVisible();
  await expect(preview).toBeHidden();
  const all = await requests(page);
  expect(all).toHaveLength(2);
  expect(all[1].dryRun).toBe(false);
  expect(all[1].baseRevision).toBe(all[0].baseRevision);
  expect(errors).toEqual([]);
});

test("Cancel closes the preview and applies nothing", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, CHANGES);
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toBeHidden();
  expect(await requests(page)).toHaveLength(1); // the preview only
});

test("a scene with nothing to tidy says so and offers no Apply", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, null);
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await expect(preview.getByText("Nothing to tidy up.")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Tidy up", exact: true })).toHaveCount(0);
});

test("Tidy up asks for the three tidying operations and never for a weld", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, CHANGES);
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  await expect(page.locator("#route").getByRole("group", { name: "Tidy up preview" })).toBeVisible();
  const [asked] = await requests(page);
  expect(asked.operations).toEqual(["dedupe_materials", "prune_materials", "prune_groups"]);
});

test("Weld models previews per model, lists what it left alone, and applies only the weld", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  await setCleanup(page, {
    materialsMerged: [], materialsRemoved: [], groupsRemoved: [], nodesRepointed: [],
    assetsWelded: [{ assetId: "a1", name: "plate.stl", verticesRemoved: 28, trianglesRemoved: 2, bytesBefore: 2000, bytesAfter: 900, becameDrawable: true }],
    weldSkipped: [
      { what: "rig.glb", reason: "it has skins or animations, which a weld would break" },
      { what: "2 primitive shapes", reason: "built-in shapes have deliberate seams, so they are left alone" },
    ],
  });
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Weld models…" }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await expect(preview.getByText("Weld plate.stl: remove 28 duplicate vertices and 2 empty triangles.")).toBeVisible();
  await expect(preview.getByText(/Left alone: rig\.glb \(it has skins or animations/)).toBeVisible();
  await expect(preview.getByText(/2 primitive shapes \(built-in shapes have deliberate seams/)).toBeVisible();
  expect((await requests(page))[0]).toMatchObject({ dryRun: true, operations: ["weld"] });

  await preview.getByRole("button", { name: "Weld", exact: true }).click();
  await expect(page.locator("#route").getByText(/Tidied up\. Undo/)).toBeVisible();
  const all = await requests(page);
  expect(all).toHaveLength(2);
  expect(all[1]).toMatchObject({ dryRun: false, operations: ["weld"] });
  await expect(page.locator("#route").getByText(/plate\.stl now meets the mesh and byte draw limits/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("when a weld has nothing to do, the reasons are still shown", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, {
    materialsMerged: [], materialsRemoved: [], groupsRemoved: [], nodesRepointed: [],
    weldSkipped: [{ what: "rig.glb", reason: "it has skins or animations, which a weld would break" }],
  });
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Weld models…" }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await expect(preview.getByText("Nothing to tidy up.")).toBeVisible();
  await expect(preview.getByText(/Left alone: rig\.glb/)).toBeVisible();
  await expect(preview.getByRole("button", { name: "Weld", exact: true })).toHaveCount(0);
});

test("a delayed dry-run reply cannot resurrect a preview after a revision change", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, CHANGES);
  await page.evaluate(() => (window as any).__plastis3dMock.__delayNextRestReply(1400, "/cleanup"));
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  await page.evaluate(() => {
    const mock = (window as any).__plastis3dMock;
    mock.__emitSceneChanged("demo-scene", mock.__bumpRevision());
  });
  await expect(page.locator("#route").getByText(/Revision 2/, { exact: false }).first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.locator("#route").getByRole("group", { name: "Tidy up preview" })).toHaveCount(0);
  await expect(page.locator("#route").getByRole("button", { name: "Tidy up…" })).toBeEnabled();
  expect(await requests(page)).toHaveLength(1);
});

test("a preview remains available while its affected object is selected and Cancel writes nothing", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, { ...CHANGES, nodesRepointed: ["n_box"] });
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await preview.getByRole("button", { name: "Show all repointed objects" }).click();
  await expect(preview).toBeVisible();
  await expect(page.locator("#route").getByLabel("SX")).toBeVisible();
  await expect(preview.getByRole("button", { name: "Show all repointed objects" })).toBeFocused();
  await preview.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await requests(page)).toHaveLength(1);
});

test("Cancel disables once Apply is submitted and an early revision does not strand success", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, CHANGES);
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  const preview = page.locator("#route").getByRole("group", { name: "Tidy up preview" });
  await expect(preview).toBeVisible();
  await page.evaluate(() => (window as any).__plastis3dMock.__delayNextRestReply(1400, "/cleanup"));
  await preview.getByRole("button", { name: "Tidy up", exact: true }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(2);
  await expect(preview.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__plastis3dMock.__emitSceneChanged("demo-scene", 2));
  await expect(page.locator("#route").getByText(/Tidied up\. Undo/)).toBeVisible();
  await expect(preview).toHaveCount(0);
  expect(await requests(page)).toHaveLength(2);
});

test("a pending dry run can be cancelled and its late reply stays discarded", async ({ page }) => {
  await gotoEditor(page);
  await setCleanup(page, CHANGES);
  await page.evaluate(() => (window as any).__plastis3dMock.__delayNextRestReply(1200, "/cleanup"));
  await openHealth(page);
  await page.locator("#route").getByRole("button", { name: "Tidy up…" }).click();
  await expect.poll(async () => (await requests(page)).length).toBe(1);
  await page.locator("#route").getByRole("button", { name: "Cancel preview", exact: true }).click();
  await expect(page.locator("#route").getByRole("button", { name: "Tidy up…" })).toBeEnabled();
  await page.waitForTimeout(1300);
  await expect(page.locator("#route").getByRole("group", { name: "Tidy up preview" })).toHaveCount(0);
  expect(await requests(page)).toHaveLength(1);
});
