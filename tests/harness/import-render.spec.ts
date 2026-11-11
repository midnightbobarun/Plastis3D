// tests/harness/import-render.spec.ts — Tier 4 import render tests (PR7).
//
// Proves the drawable path end to end against the mock: dialog import
// -> POST /imports (canned PR7 success) -> the editor picks up the new
// revision on its 4 s poll -> the viewport fetches the asset through
// GET /assets (D1 base64 envelope) -> TemplateCache parses the bytes
// with GLTFLoader -> the imported model renders (triangles rise).
// The mock's bytes are the real two-primitive.glb fixture, so a parse
// here is the same parse the Tier 3 oracle proves on the fixture.
//
// The fixture sha256 below must match MOCK_ASSET_SHA256 in
// tests/harness/mock-host.ts (sha256sum tests/fixtures/two-primitive.glb).
import { test, expect } from "@playwright/test";

const MOCK_HOST = "/tests/harness/mock-host.html";
const MOCK_ASSET_SHA256 =
  "ba710c41bffcdee203548ba1f24160bd20c6a873f79e4df23f37924937812acd";

interface MockReport {
  started: boolean;
  errors: string[];
  restCalls: unknown[];
  restRequests: Array<{ path: string; opts?: unknown }>;
  notifications: Array<{ kind: string; message: string }>;
  __rest: (path: string, opts?: unknown) => Promise<unknown>;
}

interface EditorTelemetry {
  triangles?: number;
  sceneRev?: number | null;
  selectedPrimary?: string | null;
  error?: string | null;
}

async function mockReport(page: import("@playwright/test").Page): Promise<MockReport> {
  return (await page.evaluate(
    () => (window as unknown as { __plastis3dMock: MockReport }).__plastis3dMock,
  )) as MockReport;
}

async function editorTelemetry(
  page: import("@playwright/test").Page,
): Promise<EditorTelemetry | undefined> {
  return page.evaluate(
    () =>
      (window as unknown as { __plastis3dViewportEditor?: EditorTelemetry })
        .__plastis3dViewportEditor,
  );
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

test("imported asset renders from the mock's base64 bytes", async ({ page }) => {
  await gotoEditor(page);

  // Baseline: the editor viewport is rendering the fixture scene.
  await expect
    .poll(async () => (await editorTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  const baseline = (await editorTelemetry(page))?.triangles ?? 0;

  await openImport(page);
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await dialog.getByText("Import using a path").click();
  await dialog
    .getByLabel("Path on the Hermes computer")
    .fill("/backend/model.glb");
  await dialog.getByRole("button", { name: "Import path" }).click();

  // The import succeeds: the dialog closes.
  await expect(dialog).toHaveCount(0);

  // The editor picks up revision 2 on its 4 s poll.
  await expect
    .poll(async () => (await editorTelemetry(page))?.sceneRev ?? 0, {
      timeout: 20000,
    })
    .toBe(2);

  // The model renders: triangles rise above the fixture baseline
  // (376) by the fixture's 36 — the TemplateCache fetched the bytes
  // through GET /assets and GLTFLoader parsed them.
  await expect
    .poll(async () => (await editorTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(baseline);

  // The byte route was actually used: a GET /assets for the fixture
  // hash went out.
  const report = await mockReport(page);
  expect(
    report.restRequests.some(
      (r) => r.path === `/assets/${MOCK_ASSET_SHA256}`,
    ),
  ).toBe(true);

  // The imported model node is the selection (the dialog selects the
  // new model node on success).
  const envelope = (await page.evaluate(() =>
    (
      window as unknown as { __plastis3dMock: MockReport }
    ).__plastis3dMock.__rest("/scenes/demo-scene"),
  )) as {
    nodes: Array<{ id: string; kind: string }>;
  };
  const model = envelope.nodes.find((n) => n.kind === "model");
  expect(model).toBeDefined();
  expect((await editorTelemetry(page))?.selectedPrimary).toBe(model!.id);

  expect(pageErrorsOf(page)).toEqual([]);
});

test("GET /assets returns the D1 base64 envelope for the fixture hash", async ({
  page,
}) => {
  await gotoEditor(page);
  const payload = (await page.evaluate(
    (sha) =>
      (
        window as unknown as { __plastis3dMock: MockReport }
      ).__plastis3dMock.__rest(`/assets/${sha}`),
    MOCK_ASSET_SHA256,
  )) as { ok: boolean; sha256: string; size: number; bytes: string };
  expect(payload.ok).toBe(true);
  expect(payload.sha256).toBe(MOCK_ASSET_SHA256);
  expect(payload.size).toBe(2184);
  expect(typeof payload.bytes).toBe("string");
  // The base64 decodes to exactly `size` bytes.
  const decodedLength = await page.evaluate((base64) => atob(base64).length, payload.bytes);
  expect(decodedLength).toBe(2184);
  expect(pageErrorsOf(page)).toEqual([]);
});

test("GET /assets rejects an unknown hash with ASSET_NOT_FOUND", async ({
  page,
}) => {
  await gotoEditor(page);
  const code = await page.evaluate(async () => {
    try {
      await (
        window as unknown as { __plastis3dMock: MockReport }
      ).__plastis3dMock.__rest(
        "/assets/0000000000000000000000000000000000000000000000000000000000000000",
      );
      return "no-error";
    } catch (err) {
      return (err as Error & { code?: string }).code ?? "no-code";
    }
  });
  expect(code).toBe("ASSET_NOT_FOUND");
  expect(pageErrorsOf(page)).toEqual([]);
});
