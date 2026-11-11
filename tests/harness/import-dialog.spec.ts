// tests/harness/import-dialog.spec.ts — Tier 4 import dialog tests (Stage 5, PR5).
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
//   .__setProfileRoutes(routes) + __remount(): void
//   .__files = {folders, listing, files: Record<path, {size, dataUrl?}>}
//   mock rest is stateful (POST export resolves the canned PR6
//   success; POST imports resolves the canned PR7 success).
//
// SEED SHAPE (merge fix): the mock's files door reads __files as
//   { folders: ImportFolder[], listing: ImportFileEntry[],
//     files: Record<path, {size, dataUrl?}> }
// — `listing` is a FLAT array (the mock's list() returns it verbatim,
// ignoring the folder argument), not a per-folder Record. The dialog
// is opened AFTER seeding + __remount(), so the door reads the seed
// on mount.
// ROUTE ASSUMPTION (merge fix): the mock has no router — every
// registered ROUTES_AREA contribution renders into #route on load,
// so the editor is reached at mock-host.html#/plastis3d (the hash is
// ignored; the route renders regardless).
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const MOCK_HOST = "/tests/harness/mock-host.html";

interface MockReport {
  started: boolean;
  errors: string[];
  restCalls: unknown[];
  restRequests: Array<{ path: string; opts?: unknown }>;
  notifications: Array<{ kind: string; message: string }>;
}

interface MockWithFiles {
  __plastis3dMock: MockReport & {
    __files: unknown;
    __remount: () => void;
  };
}

async function mockReport(page: import("@playwright/test").Page): Promise<MockReport> {
  return (await page.evaluate(
    () => (window as unknown as { __plastis3dMock: MockReport }).__plastis3dMock,
  )) as MockReport;
}

interface SceneEnvelopeLike {
  scene: { id: string; revision: number };
  nodes: Array<{ id: string; kind: string; modelAssetId?: string }>;
  assets: Array<{ id: string; sha256: string }>;
}

/** Read the mock's stored scene directly (no 4 s poll wait). */
async function sceneEnvelope(
  page: import("@playwright/test").Page,
): Promise<SceneEnvelopeLike> {
  return (await page.evaluate(() =>
    (
      window as unknown as {
        __plastis3dMock: { __rest: (path: string) => Promise<unknown> };
      }
    ).__plastis3dMock.__rest("/scenes/demo-scene"),
  )) as SceneEnvelopeLike;
}

async function gotoEditor(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await expect(page.locator("[data-plastis-root=editor]")).toBeVisible({
    timeout: 15000,
  });
}

async function openImport(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Open a model", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Import a model" }),
  ).toBeVisible();
}

async function seedFiles(
  page: import("@playwright/test").Page,
  files: Record<string, { size: number; dataUrl?: string }>,
  listing: Array<{ name: string; path: string; isDirectory: boolean }>,
): Promise<void> {
  // Await the remount (PR7): firing it without awaiting let the test
  // open the dialog while the remount was mid-flight, which flaked
  // the listing under load (the dialog read the folder door before
  // the new mount settled).
  await page.evaluate(
    ({ files: seedFiles, listing: seedListing }) => {
      const mock = (window as unknown as MockWithFiles).__plastis3dMock;
      mock.__files = {
        folders: [{ id: "folder-1", name: "Models", path: "/models" }],
        listing: seedListing,
        files: seedFiles,
      };
      return mock.__remount();
    },
    { files, listing },
  );
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

test("model import prioritizes the file picker and hides granted folders", async ({ page }) => {
  await gotoEditor(page);
  await seedFiles(page, { "model.glb": { size: 4, dataUrl: "data:model/gltf-binary;base64,AAAA" } }, [
    { name: "model.glb", path: "model.glb", isDirectory: false },
  ]);
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await expect(dialog.getByRole("button", { name: "Choose a file…" })).toBeFocused();
  await expect(dialog.getByText("Models", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "model.glb" })).toHaveCount(0);
  await expect(dialog.getByLabel("Path on the Hermes computer")).toBeHidden();
  await dialog.getByText("Import using a path").click();
  await expect(dialog.getByLabel("Path on the Hermes computer")).toBeVisible();
});

test("backend-path import posts to the mock rest and closes on success", async ({ page }) => {
  await gotoEditor(page);
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await dialog.getByText("Import using a path").click();
  await dialog
    .getByLabel("Path on the Hermes computer")
    .fill("/backend/model.glb");
  await dialog.getByRole("button", { name: "Import path" }).click();
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) =>
          r.path === "/scenes/demo-scene/imports" &&
          (r.opts as { method?: string } | undefined)?.method === "POST",
      );
    })
    .toBe(true);
  const post = (await mockReport(page)).restRequests.find(
    (r) => r.path === "/scenes/demo-scene/imports",
  );
  expect((post!.opts as { body: Record<string, unknown> }).body).toMatchObject({
    backendPath: "/backend/model.glb",
    baseRevision: 1,
  });
  // PR7: the mock returns the canned import success, so the dialog
  // closes and the stored scene gains a model node at revision 2.
  await expect(dialog).toHaveCount(0);
  const envelope = await sceneEnvelope(page);
  expect(envelope.scene.revision).toBe(2);
  const model = envelope.nodes.find((n) => n.kind === "model");
  expect(model).toBeDefined();
  expect(
    envelope.assets.some((a) => a.id === model!.modelAssetId),
  ).toBe(true);
  expect(pageErrorsOf(page)).toEqual([]);
});

test("file picker imports the selected model", async ({ page }) => {
  await gotoEditor(page);
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  const fixture = readFileSync("tests/fixtures/two-primitive.glb");
  await dialog.getByLabel("Choose a model file").setInputFiles({ name: "model.glb", mimeType: "model/gltf-binary", buffer: fixture });
  await expect(dialog).toHaveCount(0);
  const post = (await mockReport(page)).restRequests.find((r) => r.path === "/scenes/demo-scene/imports");
  expect((post!.opts as { body: { upload: { filename: string; bytes: string } } }).body.upload).toMatchObject({ filename: "model.glb", bytes: fixture.toString("base64") });
});
