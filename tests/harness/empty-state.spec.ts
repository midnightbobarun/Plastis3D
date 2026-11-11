// tests/harness/empty-state.spec.ts — Tier 4, Phase 2
// (E-02, G-11, E-03, N-08).
//
// With no scenes at all, all three surfaces share one empty state
// (NoSceneEmptyState, 0-D): New scene, Import, Build a sample
// snowman. Import follows D-PLAN-04 (create-then-import) — it never
// toasts `createFirst`. The snowman click creates a scene, builds the
// canned snowman into it, selects it, and draws it.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  mockReport,
} from "./pr5-helpers";

type MockRest = {
  __rest: (path: string, opts?: unknown) => Promise<unknown>;
};

async function rest(
  page: import("@playwright/test").Page,
  path: string,
  opts?: unknown,
): Promise<unknown> {
  return page.evaluate(
    ([p, o]) =>
      (
        window as unknown as { __plastis3dMock: MockRest }
      ).__plastis3dMock.__rest(p, o),
    [path, opts] as [string, unknown],
  );
}

/** Delete the fixture scene, then wait for the shared empty state. */
async function gotoEmpty(page: import("@playwright/test").Page): Promise<void> {
  await gotoMock(page);
  await rest(page, "/scenes/demo-scene?baseRevision=1", { method: "DELETE" });
  // The list poll (≤ 4 s) delivers the empty list to all surfaces.
  // Both panes show the title; .first() avoids the strict-mode
  // double match.
  await expect(
    page.locator("#route").getByText("Make something in 3D"),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.locator("#panes").getByText("Make something in 3D").first(),
  ).toBeVisible({ timeout: 15000 });
}

test("E-02: Build a sample snowman creates, builds, selects, and draws it", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEmpty(page);

  // The editor empty state shows the doc's exact body copy.
  await expect(
    page
      .locator("#route")
      .getByText("You can also ask Hermes to build a scene for you.", { exact: false }),
  ).toBeVisible();

  await page
    .locator("#route")
    .getByRole("button", { name: "Try a sample" })
    .click();

  await page.locator("#route").getByRole("button", { name: "Snowman", exact: true }).click();

  // The scene is created, the snowman built into it, and the editor
  // draws it (a canvas appears in the route).
  await page
    .locator("#route canvas")
    .first()
    .waitFor({ state: "attached", timeout: 20000 });
  await page.waitForFunction(
    () =>
      (window as unknown as { __plastis3dViewportEditor?: unknown })
        .__plastis3dViewportEditor !== undefined,
    { timeout: 20000 },
  );

  const report = await mockReport(page);
  const postScenes = report.restRequests.filter(
    (r) => r.path === "/scenes" && (r.opts as { method?: string })?.method === "POST",
  );
  expect(postScenes).toHaveLength(1);
  const builds = report.restRequests.filter(
    (r) =>
      r.path.includes("/scenes/") &&
      (r.opts as { method?: string })?.method === "PATCH" &&
      JSON.stringify((r.opts as { body: unknown }).body).includes(
        '"op":"build"',
      ),
  );
  expect(builds).toHaveLength(1);

  // The stored scene really holds the snowman nodes.
  const list = (await rest(page, "/scenes")) as {
    scenes: Array<{ id: string; name: string }>;
  };
  const snowman = list.scenes.find((s) => s.name === "Snowman");
  expect(snowman).toBeDefined();
  const envelope = (await rest(page, `/scenes/${snowman!.id}`)) as {
    nodes: Array<{ id: string }>;
  };
  const ids = envelope.nodes.map((n) => n.id);
  for (const want of [
    "snow_base",
    "snow_middle",
    "snow_head",
    "snow_scarf",
    "snow_hat",
  ]) {
    expect(ids).toContain(want);
  }

  // No `createFirst` toast anywhere on the path.
  expect(
    report.notifications.some((n) => n.message === "Create a scene first."),
  ).toBe(false);

  expect(pageErrors).toEqual([]);
});

test("G-11: the Scenes pane offers all three actions; Import creates then opens", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEmpty(page);

  const scenesPane = page.locator("#panes section", {
    has: page.locator("h2", { hasText: "Scenes" }),
  });
  await expect(
    scenesPane.getByRole("button", { name: "New scene" }),
  ).toBeVisible();
  await expect(
    scenesPane.getByRole("button", { name: "Import" }),
  ).toBeVisible();
  await expect(
    scenesPane.getByRole("button", { name: "Try a sample" }),
  ).toBeVisible();

  await scenesPane.getByRole("button", { name: "Import" }).click();
  // The pending dialog is taken on window focus (the mock host has
  // no router; the real host navigates, which takes it).
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __plastis3dMock: { restRequests: Array<{ path: string }> };
        }
      ).__plastis3dMock.restRequests.some((r) => r.path === "/scenes"),
    { timeout: 10000 },
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page
      .locator("#route")
      .getByRole("dialog", { name: "Import a model" }),
  ).toBeVisible({ timeout: 15000 });

  // The created scene is the "Untitled" scene Import needs.
  const list = (await rest(page, "/scenes")) as {
    scenes: Array<{ id: string; name: string }>;
  };
  expect(list.scenes.some((s) => s.name === "Untitled")).toBe(true);

  const report = await mockReport(page);
  expect(
    report.notifications.some((n) => n.message === "Create a scene first."),
  ).toBe(false);

  expect(pageErrors).toEqual([]);
});

test("E-03: the viewport pane shares the empty state (no hardcoded text)", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEmpty(page);

  const viewportPane = page.locator("#panes section", {
    has: page.locator("h2", { hasText: "Plastis3D" }),
  });
  await expect(
    viewportPane.getByText("Make something in 3D"),
  ).toBeVisible();
  await expect(
    viewportPane.getByText("You can also ask Hermes to build a scene for you.", { exact: false }),
  ).toBeVisible();
  await expect(
    viewportPane.getByRole("button", { name: "New scene" }),
  ).toBeVisible();
  await expect(
    viewportPane.getByRole("button", { name: "Import" }),
  ).toBeVisible();
  await expect(
    viewportPane.getByRole("button", { name: "Try a sample" }),
  ).toBeVisible();
  // The old hardcoded string is gone (its absence from the bundle is
  // also grepped in the Phase 2 verification).
  await expect(
    viewportPane.getByText("import one to get started"),
  ).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("N-08: the editor empty-state Import opens the dialog, never toasts createFirst", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEmpty(page);

  await page
    .locator("#route")
    .getByRole("button", { name: "Import" })
    .click();
  await expect(
    page
      .locator("#route")
      .getByRole("dialog", { name: "Import a model" }),
  ).toBeVisible({ timeout: 15000 });

  const report = await mockReport(page);
  expect(
    report.notifications.some((n) => n.message === "Create a scene first."),
  ).toBe(false);

  expect(pageErrors).toEqual([]);
});
