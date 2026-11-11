// tests/harness/editor-pane-split.spec.ts — Tier 4, E-12 split
// selections (D-REPLAN-02).
//
// The editor and pane selections are separate: a Scenes-pane click
// changes the viewport pane's scene only and never steals the editor's
// scene; the editor picker moves the editor only; the mount-write
// seeds the editor selection from the pane / first in list on mount
// (and re-seeds on remount, after the unmount clears it); no scenes
// means the empty state and a null selection.
//
// Note: the pure "navigate away → chip follows the pane" case is not
// expressible in the mock host (it has no router — every registered
// route renders, and __remount unmounts all roots together). It is
// covered by the store-level fall-through tests
// (tests/node/activeScene.test.ts) plus the remount test here, which
// proves the unmount cleanup ran: if the editor selection had not
// been cleared, the mount-write would be a no-op and the editor
// would stay on its old scene.
import { expect, test } from "@playwright/test";
import { installErrorCollector, mockReport } from "./pr5-helpers";

const MOCK_HOST = "/tests/harness/mock-host.html";

/** The paths host.navigate recorded (the mock writes the hash, but has no router). */
async function navigations(
  page: import("@playwright/test").Page,
): Promise<string[]> {
  return (await mockReport(page)).navigations;
}

async function rest(
  page: import("@playwright/test").Page,
  path: string,
  opts?: unknown,
): Promise<unknown> {
  return page.evaluate(
    ([p, o]) =>
      (
        window as unknown as {
          __plastis3dMock: {
            __rest: (path: string, opts?: unknown) => Promise<unknown>;
          };
        }
      ).__plastis3dMock.__rest(p, o),
    [path, opts] as [string, unknown],
  );
}

/** POST /scenes via the mock rest; returns the new scene id. */
async function createScene(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  const env = (await rest(page, "/scenes", {
    method: "POST",
    body: { name },
  })) as { scene: { id: string } };
  return env.scene.id;
}

async function remount(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() =>
    (
      window as unknown as {
        __plastis3dMock: { __remount: () => Promise<void> };
      }
    ).__plastis3dMock.__remount(),
  );
}

function scenesPane(page: import("@playwright/test").Page) {
  return page
    .locator("#panes section")
    .filter({ has: page.getByRole("heading", { name: "Scenes" }) });
}

function paneSelect(page: import("@playwright/test").Page) {
  return page.locator("#panes select[aria-label='Scene']");
}

function editorPicker(
  page: import("@playwright/test").Page,
  name: string,
) {
  return page
    .locator("#route")
    .getByRole("button", { name, exact: true });
}

function chip(page: import("@playwright/test").Page) {
  return page.locator("#statusbar");
}

test("D-PR32-02: with the editor open, a Scenes-pane click opens that scene in the editor and the pane follows", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.goto(`${MOCK_HOST}?scene=demo-scene#/plastis3d`);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  await editorPicker(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });

  expect(await createScene(page, "Second")).toBe("second");
  await scenesPane(page)
    .getByRole("button", { name: /Second/ })
    .waitFor({ state: "visible", timeout: 15000 });

  await scenesPane(page).getByRole("button", { name: /Second/ }).click();

  // One "current scene": the editor, the pane, the chip and the
  // highlighted row all agree.
  await expect(editorPicker(page, "Second")).toBeVisible();
  expect(await navigations(page)).toContain("/plastis3d?scene=second");
  await expect(paneSelect(page)).toHaveValue("second");
  await expect(
    scenesPane(page).locator('button[data-active="true"]'),
  ).toContainText("Second");
  await expect(chip(page)).toContainText("Second");

  expect(pageErrors).toEqual([]);
});

test("the editor picker moves the editor; the pane keeps its selection", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  // No ?scene= in the search string here, deliberately: the picker's
  // host.navigate writes `#/plastis3d?scene=<id>` (the mock now writes
  // the hash like the real host, F-UI-FIX-07), but a stale ?scene= left
  // in the real search string would still be read whenever the hash
  // carries no query. Starting without one keeps this test about the
  // picker alone; the hash shape has its own spec (scene-query-hash).
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  await editorPicker(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });

  expect(await createScene(page, "Second")).toBe("second");
  await scenesPane(page)
    .getByRole("button", { name: /Second/ })
    .waitFor({ state: "visible", timeout: 15000 });

  // Pane to B first (the 3D pane's own scene select — the E-12 split
  // still holds there); the editor stays on A.
  await paneSelect(page).selectOption("second");
  await expect(paneSelect(page)).toHaveValue("second");
  await expect(editorPicker(page, "Demo Scene")).toBeVisible();

  // Editor picker to B: the editor moves, the chip follows, the pane
  // does not move (it was already on B). The picker navigates (the
  // mock records the navigation; the URL itself never changes).
  await editorPicker(page, "Demo Scene").click();
  await page
    .getByRole("menu", { name: "Scenes" })
    .getByRole("menuitem", { name: "Second", exact: true })
    .click();
  await expect(editorPicker(page, "Second")).toBeVisible();
  expect(await navigations(page)).toContain("/plastis3d?scene=second");
  await expect(chip(page)).toContainText("Second");
  await expect(paneSelect(page)).toHaveValue("second");

  // Pane back to A: the editor stays on B (no new navigation).
  await paneSelect(page).selectOption("demo-scene");
  await expect(paneSelect(page)).toHaveValue("demo-scene");
  await expect(editorPicker(page, "Second")).toBeVisible();
  expect((await navigations(page)).at(-1)).toBe("/plastis3d?scene=second");
  await expect(chip(page)).toContainText("Second");

  expect(pageErrors).toEqual([]);
});

test("remount re-seeds the editor from the pane (mount-write)", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  // No ?scene=: the mount-write seeds the editor from first in list.
  await editorPicker(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });

  expect(await createScene(page, "Second")).toBe("second");
  await scenesPane(page)
    .getByRole("button", { name: /Second/ })
    .waitFor({ state: "visible", timeout: 15000 });

  // Pane to B (its own select); the editor stays on A.
  await paneSelect(page).selectOption("second");
  await expect(paneSelect(page)).toHaveValue("second");
  await expect(editorPicker(page, "Demo Scene")).toBeVisible();

  // Remount: the unmount clears the editor selection and the
  // mount-write re-seeds it from the pane — the editor opens on B.
  await remount(page);
  await editorPicker(page, "Second").waitFor({
    state: "visible",
    timeout: 20000,
  });
  await expect(chip(page)).toContainText("Second");
  // The pane selection survived the remount.
  await expect(paneSelect(page)).toHaveValue("second");

  expect(pageErrors).toEqual([]);
});

test("no scenes: both surfaces show the empty state and the selection is null", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  // No ?scene=: the mount-write seeds the editor from first in list.
  await editorPicker(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });

  // Delete the only scene. This is the G-12 regression: activeId
  // becomes null, and "no active scene" must not read as "loading".
  await rest(page, "/scenes/demo-scene?baseRevision=1", { method: "DELETE" });

  // Both surfaces fall through to the shared empty state instead of
  // sitting on "Loading…" forever (the list poll delivers the empty
  // list within 4 s).
  await expect(
    page.locator("#route").getByText("Make something in 3D"),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator("#panes").getByText("Make something in 3D").first(),
  ).toBeVisible({ timeout: 15000 });

  // The editor is not stuck loading, and its picker is gone with the
  // empty state; the pane no longer renders a scene picker.
  await expect(page.locator("#route").getByText("Loading…")).toHaveCount(0);
  await expect(editorPicker(page, "Demo Scene")).toHaveCount(0);
  await expect(paneSelect(page)).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});
