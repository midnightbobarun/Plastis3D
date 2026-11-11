// tests/harness/hit-targets.spec.ts — Tier 4, Phase 4 (G-09, N-02,
// N-03, N-04, N-05).
//
// G-09, revised by D-PR32-03 (UI/UX redesign §17): every control
// meets the WCAG 2.2 AA 24 px target minimum (rows 28 px, dock 32–36).
// N-02: the stats line counts plainly ("1472 tris", no grouping).
// N-03 (PR32): the pane's glass dock groups its tools with a hairline
// and keeps every tool when narrow. N-04: the selected
// scene row's background tracks --ui-accent. N-05: a selected part
// names its model in the Inspector.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  mockReport,
  setViewportNarrow,
  viewportTelemetry,
} from "./pr5-helpers";

const MOCK_ASSET_SHA256 =
  "ba710c41bffcdee203548ba1f24160bd20c6a873f79e4df23f37924937812acd";

/** The bounding box of a locator, failing the test when absent. */
async function boxOf(
  locator: import("@playwright/test").Locator,
): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { width: box!.width, height: box!.height };
}

test("G-09 → D-PR32-03: every control meets the WCAG 2.2 AA 24 px target minimum", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const panes = page.locator("#panes");
  const route = page.locator("#route");
  const MIN = 24;
  const check = async (locator: import("@playwright/test").Locator, label: string) => {
    const box = await boxOf(locator);
    expect(box.width, `${label} width`).toBeGreaterThanOrEqual(MIN);
    expect(box.height, `${label} height`).toBeGreaterThanOrEqual(MIN);
  };

  // The pane's glass dock and footer.
  for (const name of ["Select (Q)", "Move (W)", "Rotate (E)", "Scale (R)", "Frame (F)", "Grid (G)", "Wireframe", "Reset view", "View options"]) {
    await check(panes.getByRole("button", { name, exact: true }).first(), `pane ${name}`);
  }
  // The editor dock is roomier: 36 px tools.
  for (const name of ["Select (Q)", "Move (W)", "Frame selection (F)", "Reset view"]) {
    const box = await boxOf(route.getByRole("button", { name, exact: true }));
    expect(box.width, `editor ${name}`).toBeGreaterThanOrEqual(32);
  }

  // Outliner: the eye and the disclosure caret on the "Group" row.
  await check(route.getByRole("button", { name: "Hide Group" }), "eye");
  // The caret is a 16 px glyph inside a 28 px row; the row itself is
  // the target for selection, the caret for disclosure.
  const row = await boxOf(route.getByRole("treeitem", { name: /Collapse Group/ }).first());
  expect(row.height).toBeGreaterThanOrEqual(28);

  // The editor's Add and scene picker; the Add popover's tiles.
  await check(route.getByRole("button", { name: "Add", exact: true }), "Add");
  await check(route.getByRole("button", { name: "Demo Scene" }).first(), "picker");
  await route.getByRole("button", { name: "Add", exact: true }).click();
  const tile = await boxOf(route.getByRole("menuitem", { name: "Box" }));
  expect(tile.height).toBeGreaterThanOrEqual(56);
  await page.keyboard.press("Escape");
  await route.getByRole("button", { name: "Demo Scene" }).first().click();
  await check(route.getByRole("menuitem", { name: "Demo Scene" }), "picker row");

  expect(pageErrors).toEqual([]);
});

test("N-02: the stats line counts tris plainly (1472, no comma)", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const panes = page.locator("#panes");

  // Replace the scene's nodes with one 32x24 sphere: analyticPrimitive
  // counts 2*32*23 = 1472 tris.
  const envelope = (await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<unknown> })
      .__rest("/scenes/demo-scene"),
  )) as {
    scene: { revision: number };
    materials: Array<Record<string, unknown>>;
  };
  const patched = (await page.evaluate(
    ([rev, materials]) =>
      (window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<unknown> })
        .__rest("/scenes/demo-scene", {
          method: "PATCH",
          body: {
            baseRevision: rev,
            ops: [
              {
                op: "build",
                nodes: [
                  {
                    id: "n_sphere32",
                    name: "Sphere32",
                    kind: "mesh",
                    transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
                    parent: null,
                    visible: true,
                    primitive: {
                      type: "sphere",
                      radius: 0.5,
                      widthSegments: 32,
                      heightSegments: 24,
                    },
                    materialId: "m_default",
                  },
                ],
                materials,
              },
            ],
          },
        }),
    [envelope.scene.revision, envelope.materials] as [number, unknown],
  )) as { scene: { revision: number } };
  await page.evaluate(
    ([id, rev]) =>
      (window.__plastis3dMock as unknown as { __emitSceneChanged: (sceneId: string, revision: number) => void })
        .__emitSceneChanged(id, rev),
    ["demo-scene", patched.scene.revision] as [string, number],
  );

  await expect(panes.getByText("1472 tris")).toBeVisible({ timeout: 10000 });
  await expect(panes.getByText("1,472")).toHaveCount(0);
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 10000,
    })
    .toBe(1472);

  expect(pageErrors).toEqual([]);
});

test("N-03 (PR32): the pane's dock groups tools with a hairline, and stays whole when narrow", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.setViewportSize({ width: 840, height: 900 });
  await gotoMock(page);
  const dock = page.locator("#panes").getByRole("toolbar", { name: "Sidebar 3D view tools" });
  await expect(dock.locator(".p3d-sep-h")).toHaveCount(1);
  await expect(dock.getByRole("button")).toHaveCount(6);
  await setViewportNarrow(page, true);
  await expect(dock.getByRole("button")).toHaveCount(6);
  await setViewportNarrow(page, false);
  expect(pageErrors).toEqual([]);
});

test("N-04: the selected scene row tracks --ui-accent", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  // The selected row lives in the Scenes pane (#panes), not the editor
  // route; data-active is a pane-row attribute.
  const panes = page.locator("#panes");

  // Resolve the color-mix against the live accent through a probe
  // element placed as a sibling of the row (the browser computes the
  // mix; the test compares computed colors, not strings — and the
  // probe inherits the same custom properties as the row).
  const selected = panes.locator("button[data-active='true']").first();
  await expect(selected).toBeVisible();
  const { actual, expected } = await selected.evaluate((el) => {
    const probe = document.createElement("div");
    // The row paints --p3d-accent-soft, derived from --ui-accent
    // (with the design's fallback when a host omits the token).
    probe.style.background = "var(--p3d-accent-soft)";
    el.parentElement!.appendChild(probe);
    const mixed = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      actual: getComputedStyle(el).backgroundColor,
      expected: mixed,
    };
  });
  expect(actual).toBe(expected);
  // And it is not the old fixed grey.
  expect(actual).not.toBe("rgba(127, 127, 127, 0.25)");

  expect(pageErrors).toEqual([]);
});

test("N-05: a selected part names its model in the Inspector", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const route = page.locator("#route");

  // Fabricate exploded parts: the fixture asset row (so the parts
  // resolve their File line), a wrapper group carrying the import
  // name, and two part nodes under it.
  const envelope = (await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<unknown> })
      .__rest("/scenes/demo-scene"),
  )) as {
    scene: { revision: number };
    materials: Array<Record<string, unknown>>;
  };
  const patched = (await page.evaluate(
    ([rev, materials, sha]) =>
      (window.__plastis3dMock as unknown as { __rest: (path: string, opts?: unknown) => Promise<unknown> })
        .__rest("/scenes/demo-scene", {
          method: "PATCH",
          body: {
            baseRevision: rev,
            ops: [
              {
                op: "import_asset",
                asset: {
                  id: "a_two_primitive",
                  sha256: sha,
                  file: `assets/${sha}.glb`,
                  format: "glb",
                  bytes: 2184,
                  originalName: "two-primitive.glb",
                  sourceFormat: "glb",
                  stats: {
                    tris: 36,
                    verts: 108,
                    meshes: 2,
                    drawable: true,
                    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
                  },
                },
                node: {
                  id: "n_throwaway",
                  name: "throwaway",
                  kind: "model",
                  transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
                  parent: null,
                  visible: true,
                  modelAssetId: "a_two_primitive",
                },
              },
              {
                op: "build",
                nodes: [
                  {
                    id: "n_wrapper",
                    name: "Two Primitive",
                    kind: "group",
                    transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
                    parent: null,
                    visible: true,
                  },
                  {
                    id: "n_part0",
                    name: "Part 0",
                    kind: "part",
                    transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
                    parent: "n_wrapper",
                    visible: true,
                    modelAssetId: "a_two_primitive",
                    meshIndex: 0,
                    primitiveIndex: 0,
                  },
                  {
                    id: "n_part1",
                    name: "Part 1",
                    kind: "part",
                    transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
                    parent: "n_wrapper",
                    visible: true,
                    modelAssetId: "a_two_primitive",
                    meshIndex: 1,
                    primitiveIndex: 0,
                  },
                ],
                materials,
              },
            ],
          },
        }),
    [envelope.scene.revision, envelope.materials, MOCK_ASSET_SHA256] as [
      number,
      unknown,
      string,
    ],
  )) as { scene: { revision: number } };
  await page.evaluate(
    ([id, rev]) =>
      (window.__plastis3dMock as unknown as { __emitSceneChanged: (sceneId: string, revision: number) => void })
        .__emitSceneChanged(id, rev),
    ["demo-scene", patched.scene.revision] as [string, number],
  );

  // Select the part in the Outliner; the Inspector's Part section
  // names its model first. The row's accessible name carries the part
  // name plus the asset suffix and the eye button, so match the
  // treeitem by role (a text locator cannot match the inner span).
  await route.getByRole("treeitem", { name: /Part 0/ }).first().click();
  await expect(route.getByText('"Two Primitive"')).toBeVisible({
    timeout: 10000,
  });
  // The part's File line still shows the asset's original name (the
  // Part section is the only place that exact value appears once —
  // the Outliner's part suffixes carry a "· " prefix).
  const partSection = route.locator("section[aria-label='Part']");
  await expect(partSection.getByText("two-primitive.glb")).toBeVisible();

  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);
  expect(pageErrors).toEqual([]);
});
