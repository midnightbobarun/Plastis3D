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

test("dialog renders; folder door hides with noFilesDoor when ctx.files is unavailable and the path door stays", async ({
  page,
}) => {
  await gotoEditor(page);
  // Flip the mock's files door off (older shell: no ctx.files) and
  // remount, so the editor receives files=null. A page reload resets
  // the flag, so later tests in this file are unaffected.
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __plastis3dMock: MockReport & {
          __setFilesEnabled: (enabled: boolean) => void;
          __remount: () => Promise<void>;
        };
      }
    ).__plastis3dMock;
    mock.__setFilesEnabled(false);
    return mock.__remount();
  });
  await expect(page.locator("[data-plastis-root=editor]")).toBeVisible({
    timeout: 15000,
  });
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await expect(dialog).toContainText("Import a model");
  // With no files door the folder door hides and shows the
  // noFilesDoor sentence.
  await expect(dialog).toContainText(
    "This Hermes window can't read a local folder. Use a path on the Hermes computer.",
  );
  await expect(
    dialog.getByRole("button", { name: "Choose a folder" }),
  ).toHaveCount(0);
  // The backend-path door is always present.
  await expect(
    dialog.getByLabel("Path on the Hermes computer"),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Import path" }),
  ).toBeVisible();
  expect(pageErrorsOf(page)).toEqual([]);
});

test("with a granted folder the listing shows model files only", async ({
  page,
}) => {
  await gotoEditor(page);
  await seedFiles(
    page,
    {
      "model.glb": {
        size: 1024,
        dataUrl: "data:model/gltf-binary;base64,AAAA",
      },
      "other.gltf": {
        size: 2048,
        dataUrl: "data:model/gltf+json;base64,AAAA",
      },
    },
    [
      { name: "model.glb", path: "model.glb", isDirectory: false },
      { name: "notes.txt", path: "notes.txt", isDirectory: false },
      { name: "plate.STL", path: "plate.STL", isDirectory: false },
      { name: "chair.obj", path: "chair.obj", isDirectory: false },
      { name: "scan.ply", path: "scan.ply", isDirectory: false },
      { name: "chair.mtl", path: "chair.mtl", isDirectory: false },
      { name: "other.gltf", path: "other.gltf", isDirectory: false },
      { name: ".hidden.glb", path: ".hidden.glb", isDirectory: false },
      { name: "subfolder", path: "subfolder", isDirectory: true },
    ],
  );
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await expect(dialog.getByText("Models")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "model.glb" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "other.gltf" }),
  ).toBeVisible();
  for (const name of ["plate.STL", "chair.obj", "scan.ply"]) {
    await expect(dialog.getByRole("button", { name })).toBeVisible();
  }
  // The .mtl is a sidecar, not a model: it is never listed as one.
  await expect(
    dialog.getByRole("button", { name: "chair.mtl" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "notes.txt" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: ".hidden.glb" }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "subfolder" }),
  ).toHaveCount(0);
});

test("pre-check refusal shows desktopCap and posts nothing", async ({ page }) => {
  await gotoEditor(page);
  await seedFiles(
    page,
    {
      "huge.glb": { size: 20 * 1024 * 1024 },
    },
    [{ name: "huge.glb", path: "huge.glb", isDirectory: false }],
  );
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
  // Poll-proof (PR7 fix of the pre-existing flake): count only
  // /imports POSTs, never the total — the 4 s scene poll (list +
  // scene GET) fires between a total count and its assertion and made
  // the old exact-total check timing-sensitive.
  const importsBefore = (await mockReport(page)).restRequests.filter((r) =>
    r.path.endsWith("/imports"),
  ).length;
  await dialog.getByRole("button", { name: "huge.glb" }).click();
  // The 20 MiB stat fails the encoded-length pre-check: the desktopCap
  // sentence appears inline and the dialog stays open.
  await expect(dialog).toContainText(
    "The desktop reader has a size limit. If the Hermes backend is this computer, ask the assistant to import the file's full path.",
  );
  expect(
    (await mockReport(page)).restRequests.filter((r) =>
      r.path.endsWith("/imports"),
    ).length,
  ).toBe(importsBefore);
});

test("backend-path import posts to the mock rest and closes on success", async ({ page }) => {
  await gotoEditor(page);
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
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

test("folder import posts the upload and closes on success", async ({
  page,
}) => {
  await gotoEditor(page);
  // Seed the real fixture bytes, so the POST carries a genuine GLB
  // (the mock ignores the bytes and returns the same fixture asset,
  // but the upload shape is then faithful end to end). Playwright
  // runs specs with the repo root as cwd.
  const fixtureBytes = readFileSync("tests/fixtures/two-primitive.glb");
  const fixtureBase64 = Buffer.from(fixtureBytes).toString("base64");
  await seedFiles(
    page,
    {
      "model.glb": {
        size: fixtureBytes.length,
        dataUrl: `data:model/gltf-binary;base64,${fixtureBase64}`,
      },
    },
    [{ name: "model.glb", path: "model.glb", isDirectory: false }],
  );
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await dialog.getByRole("button", { name: "model.glb" }).click();
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.some(
        (r) => r.path === "/scenes/demo-scene/imports",
      );
    })
    .toBe(true);
  const post = (await mockReport(page)).restRequests.find(
    (r) => r.path === "/scenes/demo-scene/imports",
  );
  const body = (post!.opts as { body: Record<string, unknown> }).body;
  expect(body).toMatchObject({ baseRevision: 1 });
  expect(
    (body.upload as { filename: string; contentType: string }).filename,
  ).toBe("model.glb");
  expect(
    (body.upload as { filename: string; contentType: string }).contentType,
  ).toBe("model/gltf-binary");
  // The upload bytes are the fixture GLB, byte for byte, as base64 text:
  // ctx.rest carries JSON only and the gateway reads a base64 string.
  const uploaded = (
    (post!.opts as { body: { upload: { bytes: unknown } } }).body.upload
  ).bytes;
  expect(typeof uploaded).toBe("string");
  expect(uploaded).toBe(fixtureBase64);
  // PR7: the mock returns the canned import success, so the dialog
  // closes and the stored scene gains a model node at revision 2.
  await expect(dialog).toHaveCount(0);
  const envelope = await sceneEnvelope(page);
  expect(envelope.scene.revision).toBe(2);
  expect(envelope.nodes.some((n) => n.kind === "model")).toBe(true);
  expect(pageErrorsOf(page)).toEqual([]);
});

// R-04: ctx.files listings stop at 10,000 entries (host cap) and report
// `truncated`. The dialog keeps what it listed, says the folder has more
// files than it listed, and the path door stays usable.
test("a truncated folder listing says so and keeps the path door", async ({
  page,
}) => {
  await gotoEditor(page);
  await page.evaluate(() => {
    const mock = (window as unknown as MockWithFiles).__plastis3dMock;
    mock.__files = {
      folders: [{ id: "folder-1", name: "Models", path: "/models" }],
      listing: [{ name: "model.glb", path: "model.glb", isDirectory: false }],
      files: { "model.glb": { size: 1024, dataUrl: "data:model/gltf-binary;base64,AAAA" } },
      truncated: true,
    };
    return mock.__remount();
  });
  await expect(page.locator("[data-plastis-root=editor]")).toBeVisible({
    timeout: 15000,
  });
  await openImport(page);

  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await expect(dialog.getByRole("button", { name: "model.glb" })).toBeVisible();
  await expect(
    dialog.getByText("This folder has more files than Plastis3D listed. Use a path."),
  ).toBeVisible();
  const pathField = dialog.getByLabel("Path on the Hermes computer");
  await pathField.fill("/models/elsewhere/big.glb");
  await expect(dialog.getByRole("button", { name: "Import path" })).toBeEnabled();
  expect(pageErrorsOf(page)).toEqual([]);
});

test("an OBJ is posted with the .mtl it names as a base64 sidecar", async ({
  page,
}) => {
  await gotoEditor(page);
  const obj = "mtllib materials\\Chair.MTL\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\nf 1 2 3\n";
  const mtl = "newmtl red\nKd 1 0 0\nmap_Kd wood.png\n";
  const dataUrl = (text: string) =>
    `data:text/plain;base64,${Buffer.from(text).toString("base64")}`;
  await seedFiles(
    page,
    {
      "chair.obj": { size: obj.length, dataUrl: dataUrl(obj) },
      // Listed under a different case than the OBJ writes it.
      "chair.mtl": { size: mtl.length, dataUrl: dataUrl(mtl) },
      "wood.png": { size: 4, dataUrl: "data:image/png;base64,AAAA" },
    },
    [
      { name: "chair.obj", path: "chair.obj", isDirectory: false },
      { name: "chair.mtl", path: "chair.mtl", isDirectory: false },
      { name: "wood.png", path: "wood.png", isDirectory: false },
    ],
  );
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await dialog.getByRole("button", { name: "chair.obj" }).click();
  await expect
    .poll(async () =>
      (await mockReport(page)).restRequests.some(
        (r) => r.path === "/scenes/demo-scene/imports",
      ),
    )
    .toBe(true);
  const post = (await mockReport(page)).restRequests.find(
    (r) => r.path === "/scenes/demo-scene/imports",
  );
  const upload = (
    post!.opts as {
      body: {
        upload: {
          filename: string;
          contentType: string;
          bytes: string;
          sidecars?: Array<{ filename: string; bytes: string }>;
        };
      };
    }
  ).body.upload;
  expect(upload.filename).toBe("chair.obj");
  expect(upload.contentType).toBe("model/obj");
  expect(Buffer.from(upload.bytes, "base64").toString()).toBe(obj);
  // Named as the OBJ wrote it (the gateway matches by that name); only the
  // .mtl travels. The texture the .mtl points at is never read.
  expect(upload.sidecars).toHaveLength(1);
  expect(upload.sidecars![0].filename).toBe("Chair.MTL");
  expect(Buffer.from(upload.sidecars![0].bytes, "base64").toString()).toBe(mtl);
  const reads = await page.evaluate(
    () =>
      (window as unknown as { __plastis3dMock: { __fileReads: string[] } })
        .__plastis3dMock.__fileReads,
  );
  expect(reads).toEqual(["chair.obj", "chair.mtl"]); // wood.png is never read
});

test("an STL is posted with no sidecar", async ({ page }) => {
  await gotoEditor(page);
  await seedFiles(
    page,
    { "plate.stl": { size: 84, dataUrl: "data:model/stl;base64,AAAA" } },
    [{ name: "plate.stl", path: "plate.stl", isDirectory: false }],
  );
  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await dialog.getByRole("button", { name: "plate.stl" }).click();
  await expect
    .poll(async () =>
      (await mockReport(page)).restRequests.some(
        (r) => r.path === "/scenes/demo-scene/imports",
      ),
    )
    .toBe(true);
  const post = (await mockReport(page)).restRequests.find(
    (r) => r.path === "/scenes/demo-scene/imports",
  );
  const upload = (post!.opts as { body: { upload: Record<string, unknown> } })
    .body.upload;
  expect(upload.filename).toBe("plate.stl");
  expect(upload.contentType).toBe("model/stl");
  expect(upload.sidecars).toBeUndefined();
});
