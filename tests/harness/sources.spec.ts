// tests/harness/sources.spec.ts — Tier 4, Stage 5 (PR5): sources never
// cross. The same scene id on two gateways/profiles is two sources:
// query data and GLB templates are fetched fresh under the new
// sourceKey after a switch, never reused from the old source; a
// request in flight across a switch stays with its old source.
//
// OUT OF SCOPE here (chrome agent's half, no route/palette exists in
// this branch to trigger them): pending dialogs and save actions
// crossing sources. Save actions are covered by export-source.spec.ts
// via the mock's download capture.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  mockReport,
  viewportTelemetry,
} from "./pr5-helpers";

const ROUTE_A = {
  profile: "default",
  targetProfile: "default",
  connectionId: "mock-connection-1",
  mode: "local",
};
const ROUTE_B = {
  profile: "default",
  targetProfile: "default",
  connectionId: "mock-connection-2",
  mode: "local",
};

async function setRoutesAndRemount(page: Parameters<typeof gotoMock>[0], routes: unknown): Promise<void> {
  await page.evaluate(
    (r) => {
      const mock = window.__plastis3dMock as unknown as {
        __setProfileRoutes: (routes: unknown) => void;
        __remount: () => Promise<void>;
      };
      mock.__setProfileRoutes(r);
      return mock.__remount();
    },
    routes,
  );
}

test("switching gateways refetches scene data and GLB templates under the new source", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Add a model node via the mock-only import_asset op so an asset
  // fetch happens (a GLB template the cache must not share across
  // sources). The fixture is at revision 1.
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __rest: (path: string, opts: unknown) => Promise<unknown> })
      .__rest("/scenes/demo-scene", {
        method: "PATCH",
        body: {
          baseRevision: 1,
          ops: [
            {
              op: "import_asset",
              asset: {
                id: "a_mock",
                sha256: "mock-sha-1",
                file: "assets/mock-sha-1.glb",
                format: "glb",
                bytes: 1000,
                originalName: "mock.glb",
                sourceFormat: "glb",
                stats: { tris: 100, verts: 60, drawable: true },
              },
              node: {
                name: "Mock model",
                kind: "model",
                modelAssetId: "a_mock",
                transform: { t: [0, 2, 0], r: [0, 0, 0], s: [1, 1, 1] },
                parent: null,
                visible: true,
              },
            },
          ],
        },
      }),
  );

  // The poll refetches the scene (now rev 2, with the model node) and
  // the template cache fetches the GLB under source A.
  await page.waitForFunction(
    () =>
      (window.__plastis3dMock as unknown as { restRequests: Array<{ path: string; sourceKey: string }> })
        .restRequests.some(
          (r) => r.path === "/assets/mock-sha-1" && r.sourceKey === "mock-connection-1:default",
        ),
    { timeout: 15000 },
  );
  // The mock gateway 404s the asset, so the view shows the model as a
  // placeholder, not a draw: the overlay names the model and carries
  // the storedNotDrawn sentence ("...will not draw it."). Scoped to
  // #panes — the editor route renders the same overlay, so an unscoped
  // text lookup matches twice.
  const panes = page.locator("#panes");
  await expect(panes.getByText(/Mock model/)).toBeVisible({ timeout: 15000 });
  await expect(
    panes.getByText("Plastis3D stored this model but will not draw it."),
  ).toBeVisible({ timeout: 15000 });

  // Switch to gateway B (same scene id, different connection).
  await setRoutesAndRemount(page, [ROUTE_B]);
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { sourceKey: string })
        .sourceKey === "mock-connection-2:default",
    { timeout: 15000 },
  );
  const afterSwitch = await viewportTelemetry(page);
  expect(afterSwitch?.visible).toBe(true);

  // Fresh scene data under B: a GET /scenes/demo-scene with sourceKey B.
  await page.waitForFunction(
    () =>
      (window.__plastis3dMock as unknown as { restRequests: Array<{ path: string; sourceKey: string }> })
        .restRequests.some(
          (r) => r.path === "/scenes/demo-scene" && r.sourceKey === "mock-connection-2:default",
        ),
    { timeout: 15000 },
  );
  // Fresh GLB template under B: the cache was purged on the switch,
  // not reused from A.
  await page.waitForFunction(
    () =>
      (window.__plastis3dMock as unknown as { restRequests: Array<{ path: string; sourceKey: string }> })
        .restRequests.filter(
          (r) => r.path === "/assets/mock-sha-1" && r.sourceKey === "mock-connection-2:default",
        ).length >= 1,
    { timeout: 15000 },
  );
  // The scene still draws (rev 2, the same spec) under the new source.
  const report = await mockReport(page);
  const sceneGetsB = report.restRequests.filter(
    (r) => r.path === "/scenes/demo-scene" && r.sourceKey === "mock-connection-2:default",
  );
  expect(sceneGetsB.length).toBeGreaterThanOrEqual(1);
  const assetGetsA = report.restRequests.filter(
    (r) => r.path === "/assets/mock-sha-1" && r.sourceKey === "mock-connection-1:default",
  );
  const assetGetsB = report.restRequests.filter(
    (r) => r.path === "/assets/mock-sha-1" && r.sourceKey === "mock-connection-2:default",
  );
  expect(assetGetsA.length).toBeGreaterThanOrEqual(1);
  expect(assetGetsB.length).toBeGreaterThanOrEqual(1);

  expect(pageErrors).toEqual([]);
});

test("a request in flight across a switch stays with its old source", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // Delay the next rest call, fire a GET under A without awaiting it,
  // then switch to B immediately. The in-flight GET must complete
  // under A; the new source fetches fresh under B.
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __delayNextRest: (ms: number) => void })
      .__delayNextRest(800),
  );
  const inflight = page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __rest: (path: string) => Promise<unknown> })
      .__rest("/scenes/demo-scene"),
  );
  await setRoutesAndRemount(page, [ROUTE_B]);
  await inflight;
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { sourceKey: string })
        .sourceKey === "mock-connection-2:default",
    { timeout: 15000 },
  );

  const report = await mockReport(page);
  // The delayed GET completed under A (its sourceKey was captured at
  // call time), and B fetched the scene fresh under its own key.
  const sceneGetsA = report.restRequests.filter(
    (r) => r.path === "/scenes/demo-scene" && r.sourceKey === "mock-connection-1:default",
  );
  const sceneGetsB = report.restRequests.filter(
    (r) => r.path === "/scenes/demo-scene" && r.sourceKey === "mock-connection-2:default",
  );
  expect(sceneGetsA.length).toBeGreaterThanOrEqual(1);
  expect(sceneGetsB.length).toBeGreaterThanOrEqual(1);
  const telemetry = await viewportTelemetry(page);
  expect(telemetry?.sourceKey).toBe("mock-connection-2:default");
  expect(telemetry?.visible).toBe(true);

  expect(pageErrors).toEqual([]);
});
