// F-UI-FIX-07 (pre-PR9 step 5a): `?scene=` in the real host's shape.
//
// The real host is a HashRouter: host.navigate("/plastis3d?scene=<id>")
// writes `location.hash = "#/plastis3d?scene=<id>"` and leaves
// `location.search` empty. The live check (decisions file §6.2) found
// the editor read only `location.search`, so the requested scene was
// ignored whenever it differed from the pane's selection. The mock's
// host.navigate now writes the hash the same way, and these cases use
// only the hash shape — never a ?scene= in the real search string.

import { expect, test } from "@playwright/test";
import { installErrorCollector, mockReport } from "./pr5-helpers";

const MOCK_HOST = "/tests/harness/mock-host.html";

type Page = import("@playwright/test").Page;

async function createScene(page: Page, name: string): Promise<string> {
  const env = (await page.evaluate(
    ([n]) =>
      (
        window as unknown as {
          __plastis3dMock: {
            __rest: (path: string, opts?: unknown) => Promise<unknown>;
          };
        }
      ).__plastis3dMock.__rest("/scenes", { method: "POST", body: { name: n } }),
    [name] as [string],
  )) as { scene: { id: string } };
  return env.scene.id;
}

function editorPicker(page: Page, name: string) {
  return page.locator("#route").getByRole("button", { name, exact: true });
}

function paneSelect(page: Page) {
  return page.locator("#panes select[aria-label='Scene']");
}

async function setup(page: Page): Promise<void> {
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await editorPicker(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });
  expect(await createScene(page, "Second")).toBe("second");
  // Wait for the pane's list to carry the new scene (the next poll).
  await expect(paneSelect(page).locator("option[value='second']")).toHaveCount(
    1,
    { timeout: 15000 },
  );
}

test("a hash-route ?scene= opens that scene in the already-mounted editor", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await setup(page);
  await expect(paneSelect(page)).toHaveValue("demo-scene");

  // Same route, editor already mounted, pane on another scene: the
  // live §6.2 case 1 / case 4 shape.
  await page.evaluate(() => {
    window.location.hash = "#/plastis3d?scene=second";
  });

  await expect(editorPicker(page, "Second")).toBeVisible({ timeout: 10000 });
  // The pane keeps its own selection (E-12).
  await expect(paneSelect(page)).toHaveValue("demo-scene");
  expect(await page.evaluate(() => window.location.search)).toBe("");

  // Stable across a list poll: the query does not get re-asserted to
  // anything else, and the mount-write does not yank it back.
  await page.waitForTimeout(4500);
  await expect(editorPicker(page, "Second")).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("the pane's Open editor navigates in the hash shape and the editor follows", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await setup(page);

  // Editor stays on Demo Scene; move only the pane to Second.
  await paneSelect(page).selectOption("second");
  await expect(editorPicker(page, "Demo Scene")).toBeVisible();

  await page
    .locator("#panes")
    .getByRole("button", { name: "Open editor", exact: true })
    .click();

  expect((await mockReport(page)).navigations).toContain(
    "/plastis3d?scene=second",
  );
  expect(await page.evaluate(() => window.location.hash)).toBe(
    "#/plastis3d?scene=second",
  );
  expect(await page.evaluate(() => window.location.search)).toBe("");
  await expect(editorPicker(page, "Second")).toBeVisible({ timeout: 10000 });

  expect(pageErrors).toEqual([]);
});

test("an unknown id in the hash route shows cardBadId", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await page.goto(`${MOCK_HOST}#/plastis3d?scene=no-such-scene`);

  await expect(
    page.locator("#route").getByText("No Plastis3D scene named “no-such-scene”."),
  ).toBeVisible({ timeout: 20000 });
  expect(await page.evaluate(() => window.location.search)).toBe("");

  expect(pageErrors).toEqual([]);
});
