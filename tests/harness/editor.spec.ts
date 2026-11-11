// tests/harness/editor.spec.ts — Tier 4 editor-route tests (Stage 5, PR5).
//
// Written against the MOCK CONTRACT (see the PR5 brief): the mock
// extensions land with the gizmos branch, so these specs are RUN AT
// MERGE TIME by the coordinator if they cannot run in this worktree
// yet — do NOT edit tests/harness/mock-host.ts, mock-host.html,
// fixture-scene.ts, or playwright.config.ts to make them pass.
//
// Contract hooks used here (all from the brief, verbatim):
//   window.__plastis3dMock.notifications: Array<{kind, message}>
//   .gatewayEpoch: number + __setGatewayEpoch(n)
//   .restRequests: Array<{path, opts?}> (restCalls keeps its string shape)
//   .__bumpRevision(): number
//   .__setProfileRoutes(routes) + __remount(): void
//   .downloads: Array<{path, suggestedName, sourceKey}>
//   .__files = {folders, listing, files: Record<path, {size, dataUrl?}>}
//   route mounting: #route mount in mock-host.html, report.routesMounted: string[]
//   mock rest is stateful (PATCH enforces baseRevision → 409
//   REVISION_CONFLICT; POST /scenes creates; DELETE removes; POST
//   export resolves a canned PR6 success, POST imports resolves
//   {ok:false, code:"NOT_IMPLEMENTED"}).
//
// ROUTE ASSUMPTION (merge fix): the mock has no router — every
// registered ROUTES_AREA contribution renders into #route on load,
// so the editor is reached at mock-host.html#/plastis3d (the hash is
// ignored; the route renders regardless). Every other selector is
// the editor's own DOM.
import { test, expect } from "@playwright/test";

const MOCK_HOST = "/tests/harness/mock-host.html";

interface MockReport {
  started: boolean;
  pluginId: string | null;
  contributions: Array<{ id: string; area: string; title?: string }>;
  routesMounted: string[];
  panesMounted: string[];
  canvasPresent: boolean;
  errors: string[];
  restCalls: unknown[];
  restRequests: Array<{ path: string; opts?: unknown }>;
  navigations: string[];
  notifications: Array<{ kind: string; message: string }>;
  gatewayEpoch: number;
  eventSubscriptions: string[];
}

async function mockReport(page: import("@playwright/test").Page): Promise<MockReport> {
  return (await page.evaluate(
    () => (window as unknown as { __plastis3dMock: MockReport }).__plastis3dMock,
  )) as MockReport;
}

async function gotoEditor(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await expect(page.locator("[data-plastis-root=editor]")).toBeVisible({
    timeout: 15000,
  });
}

test.beforeEach(async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  (page as unknown as { __pageErrors: string[] }).__pageErrors = pageErrors;
});

function pageErrorsOf(page: import("@playwright/test").Page): string[] {
  return (page as unknown as { __pageErrors: string[] }).__pageErrors ?? [];
}

test("route renders with outliner, inspector, and viewport", async ({ page }) => {
  await gotoEditor(page);

  const report = await mockReport(page);
  expect(report.started).toBe(true);
  expect(report.pluginId).toBe("plastis3d");
  expect(report.routesMounted).toContain("editor");
  expect(report.errors).toEqual([]);
  expect(pageErrorsOf(page)).toEqual([]);

  // Outliner: the fixture's nodes, in order.
  const tree = page.getByRole("tree", { name: "Scene outline" });
  await expect(tree).toBeVisible();
  for (const name of ["Key light", "Main camera", "Box", "Sphere", "Group"]) {
    await expect(
      tree.getByRole("treeitem", { name: new RegExp(name) }),
    ).toBeVisible();
  }
  // Inspector: nothing selected yet (the inspector's own empty words).
  await expect(
    page.getByText("Select a node in the view or the list."),
  ).toBeVisible();
  // Viewport: a live canvas.
  await expect(page.locator("#route canvas")).toBeVisible();
  // Header: picker shows the active scene, undo/redo disabled (fresh scene).
  await expect(
    page.getByRole("button", { name: "Demo Scene", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
  // Status chip: active scene name + triangle count.
  await expect(page.getByText("376 tris").first()).toBeVisible();
});

test("outliner select shows the node in the inspector", async ({ page }) => {
  await gotoEditor(page);
  const tree = page.getByRole("tree", { name: "Scene outline" });
  await tree.getByRole("treeitem", { name: /Box/ }).first().click();
  // Inspector: Name section + Transform section for the mesh.
  await expect(page.getByLabel("Node name")).toHaveValue("Box");
  await expect(
    page.getByRole("heading", { name: "Transform" }),
  ).toBeVisible();
  await expect(page.getByLabel("TX")).toBeVisible();
  // Stats: the box is 24 verts / 12 tris. The inspector renders KV
  // rows ("Triangles" + value, "Vertices" + value) — the row divs'
  // text is exactly "Triangles12" / "Vertices24".
  // PR32: the Size section is a <dl> of dt/dd pairs.
  await expect(
    page.locator("#route dt:text-is('Triangles') + dd"),
  ).toHaveText("12");
  await expect(
    page.locator("#route dt:text-is('Vertices') + dd"),
  ).toHaveText("24");
});

test("outliner eye hides a node via PATCH", async ({ page }) => {
  await gotoEditor(page);
  const tree = page.getByRole("tree", { name: "Scene outline" });
  await tree.getByRole("treeitem", { name: /Box/ }).first().click();
  const before = (await mockReport(page)).restRequests.length;
  await page.getByRole("button", { name: "Hide Box" }).click();
  await expect
    .poll(async () => (await mockReport(page)).restRequests.length)
    .toBeGreaterThan(before);
  const patch = (await mockReport(page)).restRequests.find(
    (r) =>
      r.path === "/scenes/demo-scene" &&
      (r.opts as { method?: string } | undefined)?.method === "PATCH",
  );
  expect(patch).toBeDefined();
  const body = (patch!.opts as { body: { ops: Array<Record<string, unknown>> } }).body;
  expect(
    body.ops.some(
      (op) => op.op === "update_node" && op.id === "n_box" && op.visible === false,
    ),
  ).toBe(true);
  // The row now offers Show, with the hidden-row tooltip words.
  await expect(page.getByRole("button", { name: "Show Box" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show Box" })).toHaveAttribute(
    "title",
    "Hidden here. Export still includes this node.",
  );
});

test("outliner context menu: duplicate then delete with confirm", async ({
  page,
}) => {
  await gotoEditor(page);
  const tree = page.getByRole("tree", { name: "Scene outline" });
  const row = tree.getByRole("treeitem", { name: /Sphere/ }).first();
  await row.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Sphere" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) =>
          r.path === "/scenes/demo-scene" &&
          JSON.stringify(r.opts ?? "").includes("duplicate_node"),
      );
    })
    .toBe(true);

  // Delete asks first.
  await row.click({ button: "right" });
  await page
    .getByRole("menu", { name: "Actions for Sphere" })
    .getByRole("menuitem", { name: "Delete" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete “Sphere”?");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) =>
          r.path === "/scenes/demo-scene" &&
          JSON.stringify(r.opts ?? "").includes("delete_node"),
      );
    })
    .toBe(true);
});

test("inspector transform commit goes out as a PATCH", async ({ page }) => {
  await gotoEditor(page);
  const tree = page.getByRole("tree", { name: "Scene outline" });
  await tree.getByRole("treeitem", { name: /Box/ }).first().click();
  const tx = page.getByLabel("TX");
  await expect(tx).toBeVisible();
  await tx.click();
  await tx.fill("1.5");
  await tx.press("Enter");
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) =>
          r.path === "/scenes/demo-scene" &&
          JSON.stringify(r.opts ?? "").includes("update_node") &&
          JSON.stringify(r.opts ?? "").includes("n_box"),
      );
    })
    .toBe(true);
  // The committed value sticks (the draft committed, not reverted).
  await expect(tx).toHaveValue("1.5");
});

test("Add menu adds a box via PATCH", async ({ page }) => {
  await gotoEditor(page);
  const before = (await mockReport(page)).restRequests.length;
  // Scoped to #route: the viewport pane renders its own "Add" button at
  // wide widths (D-IMPL-13), so the unscoped name now matches two buttons.
  await page
    .locator("#route")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Box" }).click();
  await expect
    .poll(async () => (await mockReport(page)).restRequests.length)
    .toBeGreaterThan(before);
  const patch = (await mockReport(page)).restRequests.find(
    (r) =>
      r.path === "/scenes/demo-scene" &&
      (r.opts as { method?: string } | undefined)?.method === "PATCH",
  );
  expect(patch).toBeDefined();
  // The stateful mock applies the build: a second Box row appears.
  const tree = page.getByRole("tree", { name: "Scene outline" });
  await expect
    .poll(async () => tree.getByRole("treeitem", { name: /Box/ }).count())
    .toBeGreaterThan(1);
});

test("duplicate scene requests a server copy and navigates to it", async ({
  page,
}) => {
  await gotoEditor(page);
  await page.getByRole("button", { name: "Demo Scene", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Scenes" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) =>
          r.path === "/scenes" &&
          (r.opts as { method?: string } | undefined)?.method === "POST",
      );
    })
    .toBe(true);
  const post = (await mockReport(page)).restRequests.find(
    (r) =>
      r.path === "/scenes" &&
      (r.opts as { method?: string } | undefined)?.method === "POST",
  );
  expect(
    (post!.opts as { body: { name: string } }).body.name,
  ).toBe("Copy of Demo Scene");
  expect((post!.opts as { body: { copyFrom: string } }).body.copyFrom).toBeTruthy();
  // The picker navigates to the new scene (the fixture has no models,
  // so nothing was omitted and no toast appears).
  await expect
    .poll(async () => (await mockReport(page)).navigations)
    .toContainEqual(expect.stringMatching(/^\/plastis3d\?scene=/));
  expect((await mockReport(page)).notifications).toEqual([]);
});

test("New dialog creates a scene", async ({ page }) => {
  await gotoEditor(page);
  await page.getByRole("button", { name: "Demo Scene", exact: true }).click();
  await page.getByRole("menu", { name: "Scenes" }).getByRole("menuitem", {
    name: "New…",
  }).click();
  const dialog = page.getByRole("dialog", { name: "New scene" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Scene name").fill("Second scene");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) =>
          r.path === "/scenes" &&
          (r.opts as { body?: { name?: string } } | undefined)?.body
            ?.name === "Second scene",
      );
    })
    .toBe(true);
  await expect
    .poll(async () => (await mockReport(page)).navigations)
    .toContainEqual(expect.stringMatching(/^\/plastis3d\?scene=/));
});

test("picker menu lists the scene", async ({ page }) => {
  await gotoEditor(page);
  await page.getByRole("button", { name: "Demo Scene", exact: true }).click();
  const menu = page.getByRole("menu", { name: "Scenes" });
  await expect(
    menu.getByRole("menuitem", { name: "Demo Scene" }),
  ).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "New…" })).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Delete scene…" }),
  ).toBeVisible();
});

test("keybindings in the mock: W switches mode, W in an input does not", async ({
  page,
}) => {
  await gotoEditor(page);
  const toolbar = page.getByRole("toolbar", { name: "Viewport tools" });
  const moveButton = toolbar.getByRole("button", { name: "Move (W)" });
  const selectButton = toolbar.getByRole("button", { name: "Select (Q)" });
  await expect(selectButton).toHaveAttribute("aria-pressed", "true");

  // Focus the editor root (canvas click focuses it) and press W.
  await page.locator("[data-plastis-root=editor]").click();
  await page.keyboard.press("w");
  await expect(moveButton).toHaveAttribute("aria-pressed", "true");

  // T2 in the live editor: typing "water" in the Name input must not
  // switch the mode — W is a letter there, not a chord.
  const tree = page.getByRole("tree", { name: "Scene outline" });
  await tree.getByRole("treeitem", { name: /Box/ }).first().click();
  const name = page.getByLabel("Node name");
  await name.click();
  await page.keyboard.type("water");
  await expect(moveButton).toHaveAttribute("aria-pressed", "true");
  await expect(selectButton).toHaveAttribute("aria-pressed", "false");
  // Escape reverts the draft and blurs.
  await page.keyboard.press("Escape");
  await expect(name).toHaveValue("Box");
});
