// tests/harness/schema-newer.spec.ts — Tier 4 (R-12, PR6 follow-up).
//
// A scene written by a newer Plastis3D answers GET /scenes/{id} with
// 400 SCHEMA_NEWER (spec.ERROR_HTTP_STATUS). The editor shows the
// newerSchema title in its own ErrorState: no canvas for that scene,
// no toast, and the raw gateway message never reaches the DOM. The
// mock rejects the way the Webapp transport does
// (`Error("400: {…}")`), so the client's gatewayBody() parsing is
// exercised end to end.
import { expect, test } from "@playwright/test";
import { gotoMock, installErrorCollector, mockReport } from "./pr5-helpers";

const RAW_MESSAGE = "scene schema 99 is newer than this plugin's 1";

test("a newer-schema scene shows the newerSchema title in the editor", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);
  // A second scene for the editor, so the pane keeps drawing demo-scene.
  const created = (await page.evaluate(() =>
    (
      window as unknown as {
        __plastis3dMock: { __rest: (path: string, opts?: unknown) => Promise<unknown> };
      }
    ).__plastis3dMock.__rest("/scenes", { method: "POST", body: { name: "Newer" } }),
  )) as { scene: { id: string } };
  const sceneId = created.scene.id;
  await page.evaluate(([id, message]) => {
    (
      window as unknown as {
        __plastis3dMock: {
          __setSceneError: (
            id: string,
            error: { status: number; code: string; message: string } | null,
          ) => void;
        };
      }
    ).__plastis3dMock.__setSceneError(id, {
      status: 400,
      code: "SCHEMA_NEWER",
      message,
    });
  }, [sceneId, RAW_MESSAGE] as [string, string]);

  await page.evaluate((id) => {
    window.location.hash = `#/plastis3d?scene=${id}`;
  }, sceneId);

  const route = page.locator("#route");
  await expect(
    route.getByText("This scene was written by a newer Plastis3D."),
  ).toBeVisible({ timeout: 20000 });
  await expect(route.locator("canvas")).toHaveCount(0);
  await expect(page.getByText(RAW_MESSAGE)).toHaveCount(0);

  const report = await mockReport(page);
  expect(report.notifications).toEqual([]);
  expect(report.restRequests.some((r) => r.path === `/scenes/${sceneId}`)).toBe(true);
  expect(pageErrors).toEqual([]);
});
