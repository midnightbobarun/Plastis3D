// tests/harness/focus-return.spec.ts — Tier 4, 0-C cross-surface focus
// return (D-REPLAN-03/04/05/08/09) + the E-01 subscription fix.
//
// After every dialog closes, focus returns to the control that opened
// it; when the invoker is gone (menu closed, palette, deleted row),
// focus falls back to the named fallback — never BODY. The restore
// runs in requestAnimationFrame, so the harness asserts after a frame
// (expect.poll), not synchronously after the close click.
//
// Cases: picker New (Cancel / Escape / Create) -> editor root;
// Scenes-pane New while the editor is mounted (E-01) -> the pane
// button; editor Import -> the Import button; palette New scene ->
// the editor root (invoker null); delete a child node -> the parent
// row; delete a root node -> the tree container; delete cancelled ->
// the row itself; delete the scene -> the picker trigger; a stale
// pending dialog is discarded (epoch moved while the editor was not
// mounted).
import { expect, test } from "@playwright/test";
import { installErrorCollector, mockReport } from "./pr5-helpers";

const MOCK_HOST = "/tests/harness/mock-host.html";

type ActiveInfo = {
  tag: string;
  role: string | null;
  text: string;
  isRoot: boolean;
};

async function activeElement(page: import("@playwright/test").Page): Promise<ActiveInfo> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: "none", role: null, text: "", isRoot: false };
    return {
      tag: el.tagName,
      role: el.getAttribute("role"),
      text: (el.textContent ?? "").trim().slice(0, 80),
      isRoot: el.getAttribute("data-plastis-root") === "editor",
    };
  });
}

async function runPalette(
  page: import("@playwright/test").Page,
  id: string,
): Promise<void> {
  await page.evaluate((paletteId: string) =>
    (
      window as unknown as {
        __plastis3dMock: { __runPalette: (id: string) => void };
      }
    ).__plastis3dMock.__runPalette(paletteId),
  id);
}

async function setGatewayEpoch(
  page: import("@playwright/test").Page,
  n: number,
): Promise<void> {
  await page.evaluate((epoch: number) =>
    (
      window as unknown as {
        __plastis3dMock: { __setGatewayEpoch: (n: number) => void };
      }
    ).__plastis3dMock.__setGatewayEpoch(epoch),
  n);
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

function scenesPane(page: import("@playwright/test").Page) {
  return page
    .locator("#panes section")
    .filter({ has: page.getByRole("heading", { name: "Scenes" }) });
}

function tree(page: import("@playwright/test").Page) {
  return page.getByRole("tree", { name: "Scene outline" });
}

function row(page: import("@playwright/test").Page, name: string) {
  // Regex, like reparent-drag.spec.ts: the treeitem's accessible name
  // includes the eye button label ("Hide Box Box"). .first() picks
  // the root Box over the later "Inner box" for /Box/.
  return tree(page).getByRole("treeitem", { name: new RegExp(name) }).first();
}

function pickerTrigger(page: import("@playwright/test").Page, name: string) {
  return page
    .locator("#route")
    .getByRole("button", { name, exact: true });
}

function newDialog(page: import("@playwright/test").Page) {
  return page.getByRole("dialog", { name: "New scene" });
}

async function openEditor(
  page: import("@playwright/test").Page,
  query = "?scene=demo-scene",
): Promise<void> {
  await page.goto(`${MOCK_HOST}${query}#/plastis3d`);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  await pickerTrigger(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });
}

/** Open the New dialog from the picker menu; the dialog's input is autofocused. */
async function openNewFromPicker(
  page: import("@playwright/test").Page,
): Promise<void> {
  await pickerTrigger(page, "Demo Scene").click();
  await page
    .getByRole("menu", { name: "Scenes" })
    .getByRole("menuitem", { name: "New…", exact: true })
    .click();
  await newDialog(page).waitFor({ state: "visible", timeout: 15000 });
  // The dialog's name input has autoFocus.
  await expect(
    newDialog(page).getByLabel("Scene name"),
  ).toBeFocused();
}

/** Right-click a row, then Delete in its context menu. */
async function deleteRowViaMenu(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await row(page, name).click({ button: "right" });
  await page
    .getByRole("menu", { name: `Actions for ${name}` })
    .getByRole("menuitem", { name: "Delete", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: `Delete “${name}”?` })
    .waitFor({ state: "visible", timeout: 15000 });
}

test("picker New -> Cancel returns focus to the editor root", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);
  await openNewFromPicker(page);

  await newDialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  // The invoker (the "New…" menuitem) unmounted with the menu, so
  // the restore falls back to the editor root — never BODY.
  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ isRoot: true });
  expect((await activeElement(page)).tag).not.toBe("BODY");

  expect(pageErrors).toEqual([]);
});

test("picker New -> Escape returns focus to the editor root", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);
  await openNewFromPicker(page);

  await page.keyboard.press("Escape");

  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ isRoot: true });

  expect(pageErrors).toEqual([]);
});

test("picker New -> Create returns focus to the editor root", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  // No ?scene= here, deliberately: the mock's host.navigate records
  // the navigation without changing the URL, so a ?scene= in the URL
  // would make the ?scene= sync re-assert the stale query on the next
  // list poll and yank the editor back to Demo Scene (the mock
  // artifact documented in editor-pane-split.spec.ts — in the real
  // host the create navigation updates the URL). With no query the
  // mount-write seeds the editor from first in list and the create
  // is stable.
  await openEditor(page, "");
  await openNewFromPicker(page);

  await newDialog(page)
    .getByRole("button", { name: "Create", exact: true })
    .click();

  // The dialog closes on a successful create; the editor navigates
  // to the new scene, and focus returns to the editor root.
  await expect(newDialog(page)).toBeHidden({ timeout: 15000 });
  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ isRoot: true });
  // The picker shows the new scene's name once the list poll picks
  // it up (up to one 4 s poll after the create).
  await expect(pickerTrigger(page, "Untitled")).toBeVisible({
    timeout: 15000,
  });

  expect(pageErrors).toEqual([]);
});

test("Scenes-pane New opens the dialog while the editor is mounted (E-01), Cancel returns focus to the pane button", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  // E-01: the editor is already mounted, so the old mount/focus-only
  // take never fired for a same-route navigate. The subscription
  // takes the pending dialog at set time, so the dialog opens.
  await scenesPane(page)
    .getByRole("button", { name: "New", exact: true })
    .click();
  await newDialog(page).waitFor({ state: "visible", timeout: 15000 });

  await newDialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  // The invoker is the Scenes-pane New button, still connected.
  // toBeFocused (not a textContent comparison): the focused element
  // is identified by the locator, so icon text cannot confuse it.
  await expect(
    scenesPane(page).getByRole("button", { name: "New", exact: true }),
  ).toBeFocused({ timeout: 10000 });

  expect(pageErrors).toEqual([]);
});

test("editor Import -> close returns focus to the Import button", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  await page
    .locator("#route")
    .getByRole("button", { name: "Open a model", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await dialog.waitFor({ state: "visible", timeout: 15000 });

  await dialog.getByRole("button", { name: "Close", exact: true }).click();

  await expect(
    page
      .locator("#route")
      .getByRole("button", { name: "Open a model", exact: true }),
  ).toBeFocused({ timeout: 10000 });

  expect(pageErrors).toEqual([]);
});

test("palette New scene -> Cancel returns focus to the editor root", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  // The mock has no palette UI; __runPalette drives the real
  // palette row code (setPendingDialog with invoker null + navigate).
  await runPalette(page, "new-scene");
  await newDialog(page).waitFor({ state: "visible", timeout: 15000 });

  await newDialog(page)
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  // Invoker null -> the editor root fallback.
  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ isRoot: true });

  expect(pageErrors).toEqual([]);
});

test("delete a child node -> confirm returns focus to the parent row", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  await deleteRowViaMenu(page, "Inner box");
  await page
    .getByRole("dialog", { name: "Delete “Inner box”?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  // The deleted row's parent (Group) survives the delete.
  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ role: "treeitem", text: expect.stringContaining("Group") });
  await expect(row(page, "Group")).toBeVisible();

  expect(pageErrors).toEqual([]);
});

test("delete a root node -> confirm returns focus to the tree container", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  await deleteRowViaMenu(page, "Box");
  await page
    .getByRole("dialog", { name: "Delete “Box”?" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();

  // A root node has no parent, so the fallback is the tree container.
  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ role: "tree" });

  expect(pageErrors).toEqual([]);
});

test("delete a node -> Cancel returns focus to the row itself", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  await deleteRowViaMenu(page, "Box");
  await page
    .getByRole("dialog", { name: "Delete “Box”?" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  await expect
    .poll(() => activeElement(page), { timeout: 10000 })
    .toMatchObject({ role: "treeitem", text: expect.stringContaining("Box") });

  expect(pageErrors).toEqual([]);
});

test("delete the scene -> confirm returns focus to the picker trigger", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await openEditor(page);

  // A second scene first: deleting the only scene would unmount the
  // picker (the editor shows the empty state), leaving no trigger to
  // focus. With a second scene the trigger survives on the next scene.
  expect(await createScene(page, "Second")).toBe("second");
  await scenesPane(page)
    .getByRole("button", { name: /Second/ })
    .waitFor({ state: "visible", timeout: 15000 });

  await pickerTrigger(page, "Demo Scene").click();
  await page
    .getByRole("menu", { name: "Scenes" })
    .getByRole("menuitem", { name: "Delete scene…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Delete scene “Demo Scene”?",
  });
  await dialog.waitFor({ state: "visible", timeout: 15000 });
  await dialog
    .getByRole("button", { name: "Delete scene", exact: true })
    .click();

  // The trigger survives, now showing the next scene. toBeFocused
  // (not a textContent comparison): the trigger's textContent
  // includes the chevron icon's text ("Secondchevron-down"), so an
  // exact text match could never pass. The locator waits for the
  // trigger to show Second after the post-delete list refetch.
  await expect(pickerTrigger(page, "Second")).toBeFocused({
    timeout: 15000,
  });

  expect(pageErrors).toEqual([]);
});

test("a stale pending dialog is discarded (epoch moved while the editor was not mounted)", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  // ?panesOnly=1 mounts the panes without the editor route, so
  // nothing takes the pending dialog at set time.
  await page.goto(`${MOCK_HOST}?panesOnly=1#/plastis3d`);
  await scenesPane(page)
    .getByRole("button", { name: "New", exact: true })
    .waitFor({ state: "visible", timeout: 20000 });

  await scenesPane(page)
    .getByRole("button", { name: "New", exact: true })
    .click();
  // The pending dialog is set (epoch 0) and unconsumed: no editor
  // is mounted to take it.
  expect((await mockReport(page)).navigations).toEqual(["/plastis3d"]);

  // The gateway epoch moves before the editor mounts.
  await setGatewayEpoch(page, 1);

  // Drop panesOnly without reloading (a reload would reset the
  // pending module state), then remount: the editor mounts and its
  // mount take discards the stale pending dialog.
  await page.evaluate(() =>
    history.replaceState(null, "", "/tests/harness/mock-host.html#/plastis3d"),
  );
  await remount(page);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  await pickerTrigger(page, "Demo Scene").waitFor({
    state: "visible",
    timeout: 20000,
  });

  await expect(newDialog(page)).toBeHidden({ timeout: 5000 });

  expect(pageErrors).toEqual([]);
});
