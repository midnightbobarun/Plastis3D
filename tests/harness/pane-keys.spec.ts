// tests/harness/pane-keys.spec.ts — Tier 4 (G-01, PR5 follow-up).
//
// The viewport pane attaches the ONE shared key handler
// (src/editor/keybindings.ts) to its own root: a `div tabIndex={-1}
// data-plastis-root="pane"` focused when the pane canvas is clicked
// (ui-design Key Decision 5 / §Focus). Keys apply to the root that
// received them, so a key in the pane never moves the editor's mode.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  gotoMock,
  installErrorCollector,
  patchRequests,
  viewportTelemetry,
  waitForPrimary,
} from "./pr5-helpers";

async function paneRootFocused(
  page: import("@playwright/test").Page,
): Promise<boolean> {
  return page.evaluate(
    () =>
      (document.activeElement as HTMLElement | null)?.getAttribute(
        "data-plastis-root",
      ) === "pane",
  );
}

async function selectBoxInPane(
  page: import("@playwright/test").Page,
): Promise<void> {
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#panes canvas");
  await waitForPrimary(page, "n_box");
  await expect.poll(() => paneRootFocused(page)).toBe(true);
}

test("a canvas click focuses the pane root; W and F act on the pane only", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  await selectBoxInPane(page);

  const panes = page.locator("#panes");
  await page.keyboard.press("w");
  await expect(
    panes.getByRole("button", { name: "Move (W)" }),
  ).toHaveAttribute("aria-pressed", "true");
  // The editor route's own toolbar (if mounted) is untouched.
  const routeMove = page.locator("#route").getByRole("button", { name: "Move (W)" });
  if ((await routeMove.count()) > 0) {
    await expect(routeMove).toHaveAttribute("aria-pressed", "false");
  }

  const before = (await viewportTelemetry(page))?.cameraPosition;
  await page.keyboard.press("f");
  await expect
    .poll(async () => {
      const now = (await viewportTelemetry(page))?.cameraPosition;
      if (!before || !now) return 0;
      return Math.hypot(now[0] - before[0], now[1] - before[1], now[2] - before[2]);
    })
    .toBeGreaterThan(0.1);

  // G toggles the grid through the same store as the Grid button.
  const grid = panes.getByRole("button", { name: "Grid (G)" });
  const gridBefore = await grid.getAttribute("aria-pressed");
  await page.keyboard.press("g");
  await expect(grid).not.toHaveAttribute("aria-pressed", gridBefore ?? "");

  expect(pageErrors).toEqual([]);
});

test("Delete opens the confirm; Escape returns focus to the pane root; confirming deletes; Mod+Z undoes", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const panes = page.locator("#panes");
  await selectBoxInPane(page);

  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "Delete “Box”?" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => paneRootFocused(page)).toBe(true);
  expect(
    (await patchRequests(page)).some((r) =>
      r.body.ops.some((op) => op.op === "delete_node"),
    ),
  ).toBe(false);

  await page.keyboard.press("Delete");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect
    .poll(async () =>
      (await patchRequests(page)).some((r) =>
        r.body.ops.some((op) => op.op === "delete_node" && op.id === "n_box"),
      ),
    )
    .toBe(true);
  await expect.poll(() => paneRootFocused(page)).toBe(true);
  // The undo gate reads the pane's scene envelope (N-11), which updates
  // on the next scene.changed / poll; the mock PATCH does not broadcast,
  // so wait for the new revision before pressing Mod+Z.
  await expect(panes.getByText(/· rev 2 ·/)).toBeVisible({ timeout: 10000 });

  await page.keyboard.press("ControlOrMeta+z");
  await expect
    .poll(async () =>
      (await patchRequests(page)).some(
        (r) => r.body.ops.length === 1 && r.body.ops[0].op === "undo",
      ),
    )
    .toBe(true);

  expect(pageErrors).toEqual([]);
});

test("a key typed in the pane's scene picker is not a scene chord", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const panes = page.locator("#panes");
  const select = panes.getByRole("button", { name: "Select (Q)" });
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await panes.getByLabel("Scene").focus();
  await page.keyboard.press("w");
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(
    panes.getByRole("button", { name: "Move (W)" }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(pageErrors).toEqual([]);
});
