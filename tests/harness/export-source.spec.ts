// tests/harness/export-source.spec.ts — Tier 4, Stage 5 (PR5) +
// PR6 export success path: the export save targets the
// connection/profile captured at capture time, never the current one.
// The first test exercises the mock's download capture fake directly
// (capture → switch hosts → invoke → assert the recorded download
// targets the CAPTURED connection). The second test clicks the editor's
// Save as GLB… button and asserts the click → POST → save path against
// the mock's canned PR6 export success. src/io/exportFlow.ts is the
// chrome agent's; the real export flow is theirs to test against
// this fake.
import { expect, test } from "@playwright/test";
import {
  gotoMock,
  installErrorCollector,
  mockReport,
  viewportTelemetry,
} from "./pr5-helpers";

test("a captured export still targets the captured connection after a host switch", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  const before = await mockReport(page);
  expect(before.downloads).toHaveLength(0);

  // Capture the download under connection 1.
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as { __captureDownload: () => void })
      .__captureDownload(),
  );

  // Switch hosts to connection 2 and remount.
  await page.evaluate(() => {
    const mock = window.__plastis3dMock as unknown as {
      __setProfileRoutes: (routes: unknown) => void;
      __remount: () => Promise<void>;
    };
    mock.__setProfileRoutes([
      {
        profile: "default",
        targetProfile: "default",
        connectionId: "mock-connection-2",
        mode: "local",
      },
    ]);
    return mock.__remount();
  });
  await page.waitForFunction(
    () =>
      (window.__plastis3dViewport as unknown as { sourceKey: string })
        .sourceKey === "mock-connection-2:default",
    { timeout: 15000 },
  );
  const telemetry = await viewportTelemetry(page);
  expect(telemetry?.sourceKey).toBe("mock-connection-2:default");

  // Invoke the captured save: it must record connection 1, never 2.
  await page.evaluate(() =>
    (window.__plastis3dMock as unknown as {
      __invokeCapturedDownload: (path: string, suggestedName: string) => Promise<void>;
    }).__invokeCapturedDownload("/exports/demo-scene.glb", "demo-scene.glb"),
  );
  const report = await mockReport(page);
  expect(report.downloads).toHaveLength(1);
  expect(report.downloads[0].path).toBe("/exports/demo-scene.glb");
  expect(report.downloads[0].suggestedName).toBe("demo-scene.glb");
  expect(report.downloads[0].sourceKey).toBe("mock-connection-1:default");

  expect(pageErrors).toEqual([]);
});

test("clicking Save as GLB… posts the export and saves with the returned path/filename", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  const before = await mockReport(page);
  expect(before.downloads).toHaveLength(0);

  // The editor route's Save as GLB… button: capture first, POST, then
  // invoke the captured save with the mock's canned success result.
  await page.getByRole("button", { name: "Save as GLB…", exact: true }).click({ timeout: 15000 });
  await page.waitForFunction(
    () =>
      (window.__plastis3dMock as unknown as { downloads: unknown[] })
        .downloads.length === 1,
    { timeout: 15000 },
  );

  const report = await mockReport(page);
  expect(report.downloads).toHaveLength(1);
  expect(report.downloads[0].path).toMatch(
    /^\/exports\/demo-scene-r\d+\.glb$/,
  );
  // The save dialog offers the scene's name, not the server's id-r<rev> file name.
  expect(report.downloads[0].suggestedName).toBe("Demo-Scene.glb");
  expect(report.downloads[0].sourceKey).toBe("mock-connection-1:default");
  // The POST itself went out (not just the captured save).
  expect(
    report.restRequests.some(
      (r) =>
        r.path === "/scenes/demo-scene/export" &&
        (r.opts as { method?: string } | undefined)?.method === "POST",
    ),
  ).toBe(true);

  expect(pageErrors).toEqual([]);
});
