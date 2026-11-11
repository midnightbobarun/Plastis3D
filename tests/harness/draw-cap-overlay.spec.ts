// tests/harness/draw-cap-overlay.spec.ts — Tier 4, Phase 4 (G-13).
//
// A model the pane cannot draw gets a centred overlay in the canvas
// area — never a toast, never a raw error — with the sentence the
// reason calls for: over-cap and asset-too-large name the spec's
// stored figures, not-triangles names the mode, unavailable stays at
// storedNotDrawn. The overlay is pointer-events none, so orbit still
// works with it up.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  mockReport,
  viewportTelemetry,
} from "./pr5-helpers";

const MOCK_ASSET_SHA256 =
  "ba710c41bffcdee203548ba1f24160bd20c6a873f79e4df23f37924937812acd";

async function restCall(
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

async function emitChanged(
  page: import("@playwright/test").Page,
  sceneId: string,
  revision: number,
): Promise<void> {
  await page.evaluate(
    ([id, rev]) =>
      (
        window as unknown as {
          __plastis3dMock: {
            __emitSceneChanged: (sceneId: string, revision: number) => void;
          };
        }
      ).__plastis3dMock.__emitSceneChanged(id, rev),
    [sceneId, revision] as [string, number],
  );
}

/** Attach an asset row + model node to the fixture scene via __rest. */
async function attachModel(
  page: import("@playwright/test").Page,
  asset: Record<string, unknown>,
  nodeName: string,
): Promise<void> {
  const envelope = (await restCall(page, "/scenes/demo-scene")) as {
    scene: { revision: number };
  };
  const patched = (await restCall(page, "/scenes/demo-scene", {
    method: "PATCH",
    body: {
      baseRevision: envelope.scene.revision,
      ops: [
        {
          op: "import_asset",
          asset,
          node: {
            id: `n_${nodeName.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`,
            name: nodeName,
            kind: "model",
            transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
            parent: null,
            visible: true,
            modelAssetId: asset.id,
          },
        },
      ],
    },
  })) as { scene: { revision: number } };
  // Deliver the new revision so the pane refetches immediately
  // instead of waiting for the 4 s poll.
  await emitChanged(page, "demo-scene", patched.scene.revision);
}

function closeTo(
  actual: [number, number, number] | undefined,
  want: readonly [number, number, number],
  eps = 0.05,
): boolean {
  if (!actual) return false;
  return actual.every((v, i) => Math.abs(v - want[i]) < eps);
}

/** Wait for the fixture scene to render, then return its triangle count. */
async function readyBaseline(
  page: import("@playwright/test").Page,
): Promise<number> {
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  return (await viewportTelemetry(page))?.triangles ?? 0;
}

test("an over-cap model draws the bounds overlay with its stored figures", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const baseline = await readyBaseline(page);
  expect(baseline).toBeGreaterThan(0);

  await attachModel(
    page,
    {
      id: "a_big",
      sha256: "a".repeat(64),
      file: "assets/big.glb",
      format: "glb",
      bytes: 12582912,
      originalName: "big.glb",
      sourceFormat: "glb",
      stats: {
        tris: 150000,
        verts: 75000,
        meshes: 1,
        drawable: true,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    },
    "Big Model",
  );

  const panes = page.locator("#panes");
  await expect(
    panes.getByText('Model “Big Model” (big.glb)'),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    panes.getByText("Too large to draw in the Hermes window."),
  ).toBeVisible();
  await expect(
    panes.getByText("150000 triangles · 12.0 MB. The scene is saved."),
  ).toBeVisible();

  // The model does not draw (triangles stay at baseline), no toast,
  // and the byte route was never hit — the gate fires before fetching.
  const after = await viewportTelemetry(page);
  expect(after?.triangles).toBe(baseline);
  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);
  expect(
    report.restRequests.some((r) => r.path === `/assets/${"a".repeat(64)}`),
  ).toBe(false);

  // Orbit still works with the overlay up (it is pointer-events none).
  await page.locator("#panes canvas").first().scrollIntoViewIfNeeded();
  const box = await page.locator("#panes canvas").first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy - 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const orbited = await viewportTelemetry(page);
  expect(orbited?.cameraPosition).toBeDefined();
  expect(closeTo(orbited?.cameraPosition, [4, 3, 6], 0.05)).toBe(false);

  expect(pageErrors).toEqual([]);
});

// Pre-PR9 completion plan, audit A-1: a file over the ~12 MiB byte
// limit imports with drawable false and a triangle count under the cap.
// It is "too large", with its figures — not the bare storedNotDrawn.
test("a model over the byte limit (drawable false, under the cap) says it is too large", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const baseline = await readyBaseline(page);

  await attachModel(
    page,
    {
      id: "a_fat",
      sha256: "f".repeat(64),
      file: "assets/fat.glb",
      format: "glb",
      bytes: 14400000,
      originalName: "fat.glb",
      sourceFormat: "glb",
      stats: {
        tris: 60000,
        verts: 180000,
        meshes: 1,
        drawable: false,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    },
    "Fat Model",
  );

  const panes = page.locator("#panes");
  await expect(panes.getByText("Model “Fat Model” (fat.glb)")).toBeVisible({
    timeout: 10000,
  });
  await expect(
    panes.getByText("Too large to draw in the Hermes window."),
  ).toBeVisible();
  await expect(
    panes.getByText("60000 triangles · 13.7 MB. The scene is saved."),
  ).toBeVisible();
  await expect(
    panes.getByText("Plastis3D stored this model but will not draw it."),
  ).toHaveCount(0);

  const after = await viewportTelemetry(page);
  expect(after?.triangles).toBe(baseline);
  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);
  expect(
    report.restRequests.some((r) => r.path === `/assets/${"f".repeat(64)}`),
  ).toBe(false);
  expect(pageErrors).toEqual([]);
});

test("a not-triangles model names the mode in its overlay", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const baseline = await readyBaseline(page);

  await attachModel(
    page,
    {
      id: "a_lines",
      sha256: "b".repeat(64),
      file: "assets/lines.glb",
      format: "glb",
      bytes: 2184,
      originalName: "lines.glb",
      sourceFormat: "glb",
      stats: {
        tris: null,
        verts: 108,
        meshes: 1,
        drawable: true,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        ignored: [
          "mesh 0 primitive 1: mode 1 (LINES) is not TRIANGLES; skipped",
        ],
      },
    },
    "Lines Model",
  );

  const panes = page.locator("#panes");
  await expect(
    panes.getByText("Plastis3D stored this model but will not draw it."),
  ).toBeVisible({ timeout: 10000 });
  await expect(
    panes.getByText("It isn't a triangle mesh."),
  ).toBeVisible();

  const after = await viewportTelemetry(page);
  expect(after?.triangles).toBe(baseline);
  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);

  expect(pageErrors).toEqual([]);
});

test("a 413 from the byte route draws the bounds overlay, no toast", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const baseline = await readyBaseline(page);

  // Arm the 413 before the attach: the cache fetch runs once the
  // scene refetch lands.
  await page.evaluate(
    (sha) =>
      (
        window as unknown as {
          __plastis3dMock: {
            __setAssetTooLarge: (sha256: string, on: boolean) => void;
          };
        }
      ).__plastis3dMock.__setAssetTooLarge(sha, true),
    MOCK_ASSET_SHA256,
  );
  await attachModel(
    page,
    {
      id: "a_two_primitive",
      sha256: MOCK_ASSET_SHA256,
      file: `assets/${MOCK_ASSET_SHA256}.glb`,
      format: "glb",
      bytes: 2184,
      originalName: "two-primitive.glb",
      sourceFormat: "glb",
      stats: {
        tris: 36,
        verts: 108,
        meshes: 2,
        drawable: true,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    },
    "Two Primitive",
  );

  const panes = page.locator("#panes");
  await expect(
    panes.getByText("Too large to draw in the Hermes window."),
  ).toBeVisible({ timeout: 10000 });
  // The overlay's figures are the spec's stored stats (the 413 body
  // never carries stats): 36 triangles, 2184 bytes → 0.0 MB.
  await expect(
    panes.getByText("36 triangles · 0.0 MB. The scene is saved."),
  ).toBeVisible();

  // No toast, no GLTFLoader call (the bytes never arrived), and the
  // byte route WAS hit — the 413 came back from it.
  const after = await viewportTelemetry(page);
  expect(after?.triangles).toBe(baseline);
  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);
  expect(
    report.restRequests.some((r) => r.path === `/assets/${MOCK_ASSET_SHA256}`),
  ).toBe(true);

  expect(pageErrors).toEqual([]);
});

test("an unavailable fetch stays at storedNotDrawn with no second line", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  const baseline = await readyBaseline(page);

  await attachModel(
    page,
    {
      id: "a_missing",
      sha256: "c".repeat(64),
      file: "assets/missing.glb",
      format: "glb",
      bytes: 2184,
      originalName: "missing.glb",
      sourceFormat: "glb",
      stats: {
        tris: 840,
        verts: 420,
        meshes: 1,
        drawable: true,
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    },
    "Missing Model",
  );

  const panes = page.locator("#panes");
  await expect(
    panes.getByText("Plastis3D stored this model but will not draw it."),
  ).toBeVisible({ timeout: 10000 });

  const after = await viewportTelemetry(page);
  expect(after?.triangles).toBe(baseline);
  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);
  expect(
    report.restRequests.some((r) => r.path === `/assets/${"c".repeat(64)}`),
  ).toBe(true);

  expect(pageErrors).toEqual([]);
});
