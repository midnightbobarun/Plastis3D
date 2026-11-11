// tests/harness/reparent-drag.spec.ts — Tier 4, G-18 reparent drag.
//
// The Outliner captures the pointer-down revision at drag start, drops
// incoming payloads and poll ticks mid-drag, POSTs with the captured
// revision, and refetches once when the drag settles. The mock enforces
// baseRevision (a stale POST 409s), so a revision bumped mid-drag
// forces the conflict path.
//
// Drag simulation: headless Chromium does not initiate HTML5
// drag-and-drop from CDP mouse events (a probe showed zero drag
// events from mouse.down/move), so the drag is driven with synthetic
// DragEvents dispatched on the rows, with a yield between dispatches
// so React flushes each state update. That exercises the same
// handlers (onDragStart/onDragOver/onDrop/onDragEnd) a real drag
// would run.
import { expect, test } from "@playwright/test";
import {
  activeElement,
  editorTelemetry,
  emitSceneChanged,
  gotoEditor,
  installErrorCollector,
  mockReport,
  patchCount,
  patchRequests,
} from "./pr5-helpers";
import { FIXTURE_SCENE_ID } from "./fixture-scene";

async function sceneGets(
  page: import("@playwright/test").Page,
): Promise<number> {
  const report = await mockReport(page);
  return report.restRequests.filter(
    (r) =>
      r.path === `/scenes/${FIXTURE_SCENE_ID}` &&
      (r.opts as { method?: string } | undefined)?.method !== "PATCH",
  ).length;
}

async function bumpRevision(
  page: import("@playwright/test").Page,
): Promise<number> {
  return page.evaluate(() =>
    (
      window.__plastis3dMock as unknown as { __bumpRevision: () => number }
    ).__bumpRevision(),
  );
}

function tree(page: import("@playwright/test").Page) {
  return page.getByRole("tree", { name: "Scene outline" });
}

function row(page: import("@playwright/test").Page, name: string) {
  // Regex, like editor.spec.ts: the treeitem's accessible name includes
  // the eye button's label ("Hide Box"), so an exact "Box" never
  // matches. /Box/ is case-sensitive and does not match "Inner box".
  return tree(page).getByRole("treeitem", { name: new RegExp(name) }).first();
}

// Row lookup inside page.evaluate (the callback runs in the browser):
// case-sensitive "Box" skips "Inner box".

/** Start a synthetic reparent drag on a row (arms the G-18 guard). */
async function dragStart(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await page.evaluate((rowName) => {
    const rowEl = [...document.querySelectorAll('[role="treeitem"]')].find(
      (r) => (r.textContent ?? "").includes(rowName),
    ) as HTMLElement;
    const dt = new DataTransfer();
    (window as unknown as { __dragDt: DataTransfer }).__dragDt = dt;
    rowEl.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }),
    );
  }, name);
  await page.waitForTimeout(300);
}

/** Drag over a row (sets dropId). */
async function dragOver(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await page.evaluate((rowName) => {
    const rowEl = [...document.querySelectorAll('[role="treeitem"]')].find(
      (r) => (r.textContent ?? "").includes(rowName),
    ) as HTMLElement;
    const dt = (window as unknown as { __dragDt: DataTransfer }).__dragDt;
    rowEl.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, dataTransfer: dt }),
    );
  }, name);
  await page.waitForTimeout(300);
}

/** Drop on a row. */
async function dropOn(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await page.evaluate((rowName) => {
    const rowEl = [...document.querySelectorAll('[role="treeitem"]')].find(
      (r) => (r.textContent ?? "").includes(rowName),
    ) as HTMLElement;
    const dt = (window as unknown as { __dragDt: DataTransfer }).__dragDt;
    rowEl.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: dt }),
    );
  }, name);
  await page.waitForTimeout(300);
}

/** End the drag on the source row (the settlement call site). */
async function dragEnd(
  page: import("@playwright/test").Page,
  name: string,
): Promise<void> {
  await page.evaluate((rowName) => {
    const rowEl = [...document.querySelectorAll('[role="treeitem"]')].find(
      (r) => (r.textContent ?? "").includes(rowName),
    ) as HTMLElement;
    const dt = (window as unknown as { __dragDt: DataTransfer }).__dragDt;
    rowEl.dispatchEvent(
      new DragEvent("dragend", { bubbles: true, dataTransfer: dt }),
    );
  }, name);
  await page.waitForTimeout(300);
}

/** Drop on the tree background (reparent to null). */
async function dropOnBackground(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(() => {
    const treeEl = document.querySelector('[role="tree"]') as HTMLElement;
    const dt = (window as unknown as { __dragDt: DataTransfer }).__dragDt;
    treeEl.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: dt }),
    );
  });
  await page.waitForTimeout(300);
}

test("a remote revision delivered mid-drag is dropped; the drop POSTs the pointer-down revision and the settlement refetch picks it up", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);
  await row(page, "Box").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(500);
  const getsBefore = await sceneGets(page);

  await dragStart(page, "Box");

  // A remote revision arrives mid-drag: the broadcast is dropped by
  // the guard, and the poll tick is skipped too.
  await emitSceneChanged(page, FIXTURE_SCENE_ID, 2);
  await page.waitForTimeout(5000);
  expect(await sceneGets(page)).toBe(getsBefore);
  expect((await editorTelemetry(page))?.sceneRev).toBe(1);

  await dragOver(page, "Sphere");
  await dropOn(page, "Sphere");
  await dragEnd(page, "Box");

  // The POST carries the pointer-down revision, not the remote one.
  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(1);
  expect(patches[0].body.baseRevision).toBe(1);
  expect(patches[0].body.ops).toEqual([
    expect.objectContaining({ op: "update_node", id: "n_box", parent: "n_sphere", transform: expect.objectContaining({ t: [-1.5, 0, 0] }) }),
  ]);

  // The settlement refetch fires once and picks up the new revision;
  // the Box is now nested under the Sphere.
  await expect
    .poll(() => sceneGets(page), { timeout: 10000 })
    .toBeGreaterThan(getsBefore);
  await expect
    .poll(async () => (await editorTelemetry(page))?.sceneRev, {
      timeout: 10000,
    })
    .toBe(2);
  await expect(row(page, "Box")).toHaveAttribute("aria-level", "2");

  expect(pageErrors).toEqual([]);
});

test("a bumped revision mid-drag forces a 409; the drop is discarded and the settlement refetch picks up the bumped revision", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);
  await row(page, "Box").waitFor({ state: "visible", timeout: 20000 });
  await page.waitForTimeout(500);

  await dragStart(page, "Box");

  // The mock's stored revision is now 2; the drop's POST (baseRevision
  // 1) will 409. The broadcast is dropped by the guard mid-drag.
  expect(await bumpRevision(page)).toBe(2);
  await emitSceneChanged(page, FIXTURE_SCENE_ID, 2);
  await page.waitForTimeout(1000);
  expect((await editorTelemetry(page))?.sceneRev).toBe(1);

  await dragOver(page, "Sphere");
  await dropOn(page, "Sphere");
  await dragEnd(page, "Box");

  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches).toHaveLength(1);
  expect(patches[0].body.baseRevision).toBe(1);

  // The conflict toast is in host notifications (COPY.conflictEdit).
  await page.waitForFunction(
    () =>
      (
        window.__plastis3dMock as unknown as {
          notifications: Array<{ message: string }>;
        }
      ).notifications.some(
        (n) => n.message === "The scene changed. Your edit was not applied.",
      ),
    { timeout: 10000 },
  );

  // The Box stays at the root; the settlement refetch picks up rev 2.
  await expect(row(page, "Box")).toHaveAttribute("aria-level", "1");
  await expect
    .poll(async () => (await editorTelemetry(page))?.sceneRev, {
      timeout: 10000,
    })
    .toBe(2);

  expect(pageErrors).toEqual([]);
});

test("keybindings still fire during a reparent drag", async ({ page }) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);
  await row(page, "Box").waitFor({ state: "visible", timeout: 20000 });

  // Focus the Box row, then arm the reparent guard.
  await row(page, "Box").click();
  expect((await activeElement(page))?.text).toContain("Box");

  await dragStart(page, "Box");

  // ArrowDown still moves focus mid-drag (the reparent guard must not
  // disable keybindings the way the gizmo guard does).
  await page.keyboard.press("ArrowDown");
  expect((await activeElement(page))?.text).toContain("Sphere");

  // Drop on the tree background: reparent to null. The Box is already
  // at the root, so the tree is unchanged, but the drag settles
  // through the same path (one POST, one settlement refetch).
  await dropOnBackground(page);
  await dragEnd(page, "Box");

  await expect.poll(() => patchCount(page), { timeout: 10000 }).toBe(1);
  const patches = await patchRequests(page);
  expect(patches[0].body.baseRevision).toBe(1);
  expect(patches[0].body.ops).toEqual([
    expect.objectContaining({ op: "update_node", id: "n_box", parent: null, transform: expect.any(Object) }),
  ]);

  expect(pageErrors).toEqual([]);
});
