// tests/harness/viewport.spec.ts — Tier 4 viewport + poll tests (Stage 4, PR4).
//
// Loads the built bundle in the mock host (Playwright Chromium,
// SwiftShader WebGL) and verifies: the WebGL canvas initializes and
// renders primitives (renderer-info triangles + a real readPixels pixel
// check), container resize updates the canvas size, the Scenes pane
// lists the fixture scene and selecting it loads it in the viewport,
// the WebGL2 fallback ErrorState appears when WebGL is disabled, and
// the 4-second scene poll runs while the viewport is visible and stops
// when it is hidden.
//
// Broadcast note: the mock never emits gateway events, so the poll is
// what these tests observe; the broadcast is primary in the real host
// (its delivery was proven live in PR1). What IS asserted here is that
// the data layer subscribed exactly once to plugin.plastis3d.scene.changed.
import { test, expect, chromium } from "@playwright/test";

const MOCK_HOST = "/tests/harness/mock-host.html";

interface MockReport {
  started: boolean;
  pluginId: string | null;
  contributions: Array<{ id: string; area: string; title?: string }>;
  panesMounted: string[];
  canvasPresent: boolean;
  errors: string[];
  restCalls: unknown[];
  navigations: string[];
  eventSubscriptions: string[];
}

interface ViewportTelemetry {
  frames: number;
  triangles: number;
  calls: number;
  geometries: number;
  textures: number;
  hasLease: boolean;
  visible: boolean;
  error: string | null;
}

async function mockReport(page: import("@playwright/test").Page): Promise<MockReport> {
  return (await page.evaluate(
    () => (window as unknown as { __plastis3dMock: MockReport }).__plastis3dMock,
  )) as MockReport;
}

async function viewportTelemetry(
  page: import("@playwright/test").Page,
): Promise<ViewportTelemetry | undefined> {
  return await page.evaluate(
    () =>
      (window as unknown as { __plastis3dViewport?: ViewportTelemetry })
        .__plastis3dViewport,
  );
}

async function sceneCallCount(page: import("@playwright/test").Page): Promise<number> {
  const report = await mockReport(page);
  return report.restCalls.filter((p) => p === "/scenes/demo-scene").length;
}

async function listCallCount(page: import("@playwright/test").Page): Promise<number> {
  const report = await mockReport(page);
  return report.restCalls.filter((p) => p === "/scenes").length;
}

test.beforeEach(async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  // Stash on the page object for the tests that assert zero errors.
  (page as unknown as { __pageErrors: string[] }).__pageErrors = pageErrors;
});

function pageErrorsOf(page: import("@playwright/test").Page): string[] {
  return (page as unknown as { __pageErrors: string[] }).__pageErrors ?? [];
}

test("viewport renders primitives, scenes pane lists the fixture scene", async ({
  page,
}) => {
  await page.goto(MOCK_HOST);
  await expect(page.locator("#status")).toContainText("canvas present", {
    timeout: 15000,
  });

  const report = await mockReport(page);
  expect(report.started).toBe(true);
  expect(report.pluginId).toBe("plastis3d");
  expect(report.panesMounted).toEqual(["viewport", "scenes"]);
  expect(report.canvasPresent).toBe(true);
  expect(report.errors).toEqual([]);
  expect(pageErrorsOf(page)).toEqual([]);

  // The data layer subscribed exactly once to the scene-changed broadcast.
  expect(
    report.eventSubscriptions.filter((t) => t === "plugin.plastis3d.scene.changed"),
  ).toHaveLength(1);

  // The live renderer drew triangles (box + sphere + child box + grid).
  await expect
    .poll(async () => (await viewportTelemetry(page))?.triangles ?? 0)
    .toBeGreaterThan(0);
  const telemetry = await viewportTelemetry(page);
  expect(telemetry?.hasLease).toBe(true);

  // Real pixel check: read the drawing buffer back (the viewport sets
  // preserveDrawingBuffer) and require more than one distinct color.
  const pixels = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return { error: "no canvas" };
    const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return { error: "no webgl2 context" };
    const w = canvas.width;
    const h = canvas.height;
    const data = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    const colors = new Set<number>();
    let bright = 0;
    const samples = Math.ceil((w * h) / 16);
    for (let i = 0; i < w * h; i += 16) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      colors.add((r << 16) | (g << 8) | b);
      if (r + g + b > 120) bright += 1;
    }
    return { width: w, height: h, distinctColors: colors.size, bright, samples };
  });
  expect(pixels.error).toBeUndefined();
  expect(pixels.distinctColors).toBeGreaterThan(10);
  expect(pixels.bright).toBeGreaterThan(0);

  // The Scenes pane lists the fixture scene. (Scoped to the list: the
  // viewport header's scene <select> also contains an option with this
  // text, and a closed <select>'s option is not "visible" to Playwright.)
  await expect(
    page.locator("ul li button", { hasText: "Demo Scene" }),
  ).toBeVisible();
  const items = page.locator("ul li button");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Demo Scene");
  await expect(items.first()).toContainText("rev 1");
});

test("selecting the scene in the Scenes pane loads it in the viewport", async ({
  page,
}) => {
  await page.goto(MOCK_HOST);
  await expect(page.locator("#status")).toContainText("canvas present", {
    timeout: 15000,
  });

  const item = page.locator("ul li button", { hasText: "Demo Scene" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(item).toHaveAttribute("data-active", "true");

  // The viewport status line shows the selected scene (name, revision,
  // analytic stats from the fixture envelope). Scoped to #panes: the
  // status chip (in #statusbar) also shows "376 tris".
  await expect(page.getByText("Demo Scene · rev 1")).toBeVisible();
  await expect(
    page.locator("#panes").getByText("376 tris"),
  ).toBeVisible();
  await expect(page.locator("#panes canvas")).toBeVisible();
});

test("container resize updates the canvas size", async ({ page }) => {
  await page.goto(MOCK_HOST);
  await expect(page.locator("#status")).toContainText("canvas present", {
    timeout: 15000,
  });
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  const before = await canvas.evaluate((el) => (el as HTMLCanvasElement).width);
  expect(before).toBeGreaterThan(100);

  // Shrink the viewport pane's section; ResizeObserver must propagate
  // the new size to the renderer.
  await page.evaluate(() => {
    const section = [...document.querySelectorAll("section")].find(
      (s) => s.querySelector("h2")?.textContent === "Plastis3D",
    );
    if (!section) throw new Error("viewport section not found");
    (section as HTMLElement).style.flex = "0 0 300px";
  });
  // Wait for the renderer to propagate the shrink: the poll condition
  // is the shrunk size, not a lower bound (the pre-resize width already
  // satisfies a lower bound, so the poll would return before the
  // ResizeObserver fires).
  await expect
    .poll(async () => canvas.evaluate((el) => (el as HTMLCanvasElement).width))
    .toBeLessThanOrEqual(310);
  const after = await canvas.evaluate((el) => (el as HTMLCanvasElement).width);
  expect(after).toBeLessThanOrEqual(310);
  expect(after).not.toBe(before);
});

test("WebGL2 fallback: ErrorState when WebGL is unavailable", async () => {
  // A second browser launched with WebGL disabled — the real
  // no-WebGL2 environment, not a stubbed context. Verified by probe:
  // canvas.getContext("webgl2") returns null under these flags.
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-webgl", "--disable-webgl2"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://localhost:5173${MOCK_HOST}`);
    // Scoped to #panes: the editor route renders the same ErrorState
    // in #route, so the unscoped text matches twice.
    await expect(
      page.locator("#panes").getByText("Plastis3D cannot draw 3D in this browser"),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator("canvas")).toHaveCount(0);
    // The Scenes pane keeps working without WebGL2 (list only).
    await expect(
      page.locator("ul li button", { hasText: "Demo Scene" }),
    ).toBeVisible();
  } finally {
    await browser.close();
  }
});

test("scene poll: 4 s refetch while visible, stops when hidden", async ({
  page,
}) => {
  test.setTimeout(90000);
  // ?panesOnly=1: the editor route is a second eligible scene poller
  // (its viewport polls the same shared record), so hiding the pane
  // alone would never stop the poll on the mount-everything page.
  await page.goto(`${MOCK_HOST}?panesOnly=1`);
  await expect(page.locator("#status")).toContainText("canvas present", {
    timeout: 15000,
  });

  // The frame loop is running while visible.
  const framesA = (await viewportTelemetry(page))?.frames ?? 0;
  await page.waitForTimeout(1000);
  const framesB = (await viewportTelemetry(page))?.frames ?? 0;
  expect(framesB).toBeGreaterThan(framesA);

  // While the viewport is visible the scene refetches on the 4 s
  // interval: the initial fetch plus at least one poll in ~9 s.
  const callsBefore = await sceneCallCount(page);
  expect(callsBefore).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(9000);
  const callsVisible = await sceneCallCount(page);
  expect(callsVisible).toBeGreaterThanOrEqual(callsBefore + 1);

  // Hide the viewport: the scene poll must stop. The list poll (the
  // Scenes pane is still visible) keeps running as the control.
  const listBefore = await listCallCount(page);
  await page.evaluate(() => {
    (window as unknown as { __plastis3dMock: MockReport & {
      setPaneVisible: (id: string, visible: boolean) => void;
    } }).__plastis3dMock.setPaneVisible("plastis3d:viewport", false);
  });
  const framesHiddenA = (await viewportTelemetry(page))?.frames ?? 0;
  // Settle first (PR7): the hide stops the poll via a React effect
  // cleanup, which runs after the pane-visibility atom flips — a 4 s
  // tick already due when the hide lands can fire once before the
  // cleanup runs (observed repeatedly as exactly one straggler,
  // callsHidden = callsVisible + 1, never more). Waiting out one
  // full interval lets that straggler land and the cleanup complete,
  // so the baseline below is stable and the assertion stays strict:
  // zero new scene fetches while hidden.
  await page.waitForTimeout(4500);
  const callsHiddenBaseline = await sceneCallCount(page);
  await page.waitForTimeout(9000);
  const callsHidden = await sceneCallCount(page);
  expect(callsHidden).toBe(callsHiddenBaseline);
  const listAfter = await listCallCount(page);
  expect(listAfter).toBeGreaterThan(listBefore);
  // ...and the frame loop paused (no new frames while hidden).
  const framesHiddenB = (await viewportTelemetry(page))?.frames ?? 0;
  expect(framesHiddenB).toBe(framesHiddenA);
});
