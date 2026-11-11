// tests/harness/search-escape.spec.ts — Tier 4, Phase 1 (N-10).
//
// Escape in the outliner SearchField clears the query: rows filter
// while typing, and all rows return after Escape. No second blur call
// — the root key handler's Escape behaviour (blur) still applies, so
// clearing + blurring is the combined outcome.
//
// The SearchField mounts only when the scene has more than 12 nodes
// (the fixture has 6), so the spec adds 7 nodes through the mock rest
// and delivers a scene.changed broadcast (the 0-E helper) to refresh
// the outliner.
import { expect, test } from "@playwright/test";
import {
  emitSceneChanged,
  gotoEditor,
  installErrorCollector,
} from "./pr5-helpers";

/** Add 7 nodes to the fixture scene (6 → 13) via the mock rest. */
async function addExtraNodes(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const mock = (
      window as unknown as {
        __plastis3dMock: {
          __rest: (path: string, opts?: unknown) => Promise<unknown>;
        };
      }
    ).__plastis3dMock;
    const ops = Array.from({ length: 7 }, (_, i) => ({
      op: "add_node",
      node: {
        id: `extra-${i}`,
        name: `Extra ${i}`,
        kind: "mesh",
        transform: { t: [3 + i, 0.5, 0], r: [0, 0, 0], s: [1, 1, 1] },
        parent: null,
        visible: true,
        primitive: { type: "box", width: 0.5, height: 0.5, depth: 0.5 },
        materialId: "m_default",
      },
    }));
    await mock.__rest("/scenes/demo-scene", {
      method: "PATCH",
      body: { baseRevision: 1, ops },
    });
  });
}

test("Escape in the search field clears the query", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);

  await addExtraNodes(page);
  await emitSceneChanged(page, "demo-scene", 2);

  const search = page.locator("#route").getByLabel("Filter nodes");
  await expect(search).toBeVisible({ timeout: 10000 });
  const rows = page.locator('#route [role="treeitem"]');
  await expect(rows).toHaveCount(13);

  await search.fill("box");
  // "Box" + "Inner box" (+ its ancestor "Group").
  await expect(rows).toHaveCount(3);

  await page.keyboard.press("Escape");
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(13);
  expect(pageErrors).toEqual([]);
});
