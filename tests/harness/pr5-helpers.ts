// tests/harness/pr5-helpers.ts — shared Tier 4 helpers for the PR5 specs.
// Not a spec itself (no .spec.ts suffix, so Playwright does not run it).
// Mirrors the report shape of the mock host (tests/harness/mock-host.ts).
import * as THREE from "three";
import type { Page } from "@playwright/test";

export const MOCK_HOST = "/tests/harness/mock-host.html";

export interface RestRequest {
  path: string;
  opts?: unknown;
  sourceKey: string;
}

export interface MockReport {
  started: boolean;
  startedAt?: number;
  panesMounted: string[];
  routesMounted: string[];
  contributions: string[];
  errors: string[];
  restCalls: string[];
  restRequests: RestRequest[];
  notifications: Array<{ kind: "notify" | "notifyError"; message: string }>;
  downloads: Array<{ path: string; suggestedName?: string; sourceKey: string }>;
  gatewayEpoch: number;
  /** 0-E broadcast helper: deliver a gateway event to the subscribers. */
  __emit: (type: string, event: unknown) => void;
  /** 0-E: deliver plugin.plastis3d.scene.changed for a scene + revision. */
  __emitSceneChanged: (sceneId: string, revision: number) => void;
  /** 0-E: flip the (prefers-reduced-motion: reduce) matchMedia stub. */
  __setReducedMotion: (reduced: boolean) => void;
  /** 0-E: set the host.state.viewport stub value. */
  __setViewport: (viewport: {
    width: number;
    height: number;
    narrow: boolean;
  }) => void;
  /** 0-E: read the current host.state.viewport stub value. */
  __viewport: () => { width: number; height: number; narrow: boolean };
  /** N-01: change the useTheme() themeName. */
  __setThemeName: (name: string) => void;
}

export interface ViewportTelemetry {
  frames?: number;
  triangles?: number;
  calls?: number;
  geometries?: number;
  textures?: number;
  hasLease?: boolean;
  visible: boolean;
  error?: string | null;
  orbitEnabled?: boolean;
  gizmoDragging?: boolean;
  gizmoMode?: string;
  selectedPrimary?: string | null;
  selectedPosition?: [number, number, number] | null;
  gizmoHandleX?: { x: number; y: number } | null;
  sourceKey?: string;
  cameraPosition?: [number, number, number];
  controlsTarget?: [number, number, number];
  /** G-03: OrbitControls.enableDamping on the surface. */
  dampingEnabled?: boolean;
  /** The scene revision the surface is currently showing. */
  sceneRev?: number | null;
  /** N-01: scene.background as a CSS hex string, or null. */
  background?: string | null;
  /** N-01: how many times applyTheme has run on the surface. */
  themeReads?: number;
}

export async function mockReport(page: Page): Promise<MockReport> {
  return page.evaluate(
    () => window.__plastis3dMock as unknown as MockReport,
  );
}

export async function viewportTelemetry(
  page: Page,
): Promise<ViewportTelemetry | undefined> {
  return page.evaluate(
    () => window.__plastis3dViewport as unknown as ViewportTelemetry,
  );
}

/** The editor route's telemetry (the pane writes __plastis3dViewport). */
export async function editorTelemetry(
  page: Page,
): Promise<ViewportTelemetry | undefined> {
  return page.evaluate(
    () =>
      (window as unknown as { __plastis3dViewportEditor?: ViewportTelemetry })
        .__plastis3dViewportEditor,
  );
}

/** The currently focused element, for focus assertions (0-E). */
export async function activeElement(page: Page): Promise<{
  tagName: string;
  id: string;
  ariaLabel: string | null;
  text: string;
} | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      tagName: el.tagName,
      id: el.id,
      ariaLabel: el.getAttribute("aria-label"),
      text: (el.textContent ?? "").trim().slice(0, 80),
    };
  });
}

/** Deliver a scene.changed broadcast for a scene + revision (0-E). */
export async function emitSceneChanged(
  page: Page,
  sceneId: string,
  revision: number,
): Promise<void> {
  await page.evaluate(
    ([id, rev]) =>
      (
        window as unknown as {
          __plastis3dMock: MockReport;
        }
      ).__plastis3dMock.__emitSceneChanged(id, rev),
    [sceneId, revision] as [string, number],
  );
}

/** Flip the (prefers-reduced-motion: reduce) matchMedia stub (0-E). */
export async function setReducedMotion(
  page: Page,
  reduced: boolean,
): Promise<void> {
  await page.evaluate(
    (r) =>
      (
        window as unknown as { __plastis3dMock: MockReport }
      ).__plastis3dMock.__setReducedMotion(r),
    reduced,
  );
}

/** Flip the host.state.viewport narrow stub (0-E). */
export async function setViewportNarrow(
  page: Page,
  narrow: boolean,
): Promise<void> {
  await page.evaluate(
    (n) =>
      (
        window as unknown as { __plastis3dMock: MockReport }
      ).__plastis3dMock.__setViewport({
        width: n ? 320 : 1280,
        height: 800,
        narrow: n,
      }),
    narrow,
  );
}

/** Change the useTheme() themeName stub (N-01). */
export async function setThemeName(page: Page, name: string): Promise<void> {
  await page.evaluate(
    (n) =>
      (
        window as unknown as { __plastis3dMock: MockReport }
      ).__plastis3dMock.__setThemeName(n),
    name,
  );
}

/** Install the page-error collector used by every PR5 spec. */
export function installErrorCollector(page: Page): string[] {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });
  return pageErrors;
}

/** Load the mock host and wait until the viewport is rendering. */
export async function gotoMock(page: Page): Promise<void> {
  await page.goto(MOCK_HOST);
  // The tick writes __plastis3dViewport every frame once the renderer
  // is up — its presence proves the viewport mounted and is rendering.
  // (The telemetry has no canvasPresent field; the canvas element is
  // the other half of the check.)
  await page.locator("canvas").first().waitFor({ state: "attached", timeout: 20000 });
  await page.waitForFunction(
    () => (window as unknown as { __plastis3dViewport?: unknown }).__plastis3dViewport !== undefined,
    { timeout: 20000 },
  );
}

/** Load the mock host and wait until the editor route is mounted. */
export async function gotoEditor(page: Page): Promise<void> {
  await page.goto(`${MOCK_HOST}#/plastis3d`);
  await page
    .locator("[data-plastis-root=editor]")
    .waitFor({ state: "visible", timeout: 20000 });
  await page
    .locator("#route canvas")
    .first()
    .waitFor({ state: "attached", timeout: 20000 });
}

/** The PATCH requests the mock host has seen, in order. */
export async function patchRequests(page: Page): Promise<
  Array<{
    path: string;
    body: { baseRevision: number; ops: Array<Record<string, unknown>> };
    sourceKey: string;
  }>
> {
  const report = await mockReport(page);
  // The method lives in opts.method — the path never contains "PATCH".
  return report.restRequests
    .filter(
      (r) =>
        r.path.includes("/scenes/") &&
        (r.opts as { method?: string } | undefined)?.method === "PATCH",
    )
    .map((r) => ({
      path: r.path,
      body: (r.opts as { body: unknown }).body as {
        baseRevision: number;
        ops: Array<Record<string, unknown>>;
      },
      sourceKey: r.sourceKey,
    }));
}

/** The number of PATCH requests the mock host has seen so far. */
export async function patchCount(page: Page): Promise<number> {
  return (await patchRequests(page)).length;
}

/**
 * Project a world-space point onto the page using the mock viewport's
 * known initial camera (position (4, 3, 6), target origin, fov 40,
 * near 0.05, far 500). The camera has not moved yet at the point the
 * PR5 specs click — no orbit has happened — so this projection is
 * exact. Returns page coordinates for Playwright's mouse.
 * `canvasSelector` scopes the bounding box (default: the first canvas
 * on the page, i.e. the pane's; pass "#route canvas" for the editor).
 */
export async function projectPoint(
  page: Page,
  point: [number, number, number],
  canvasSelector = "canvas",
): Promise<{ x: number; y: number }> {
  const box = await page.locator(canvasSelector).first().boundingBox();
  if (!box) throw new Error("no canvas bounding box");
  const camera = new THREE.PerspectiveCamera(
    40,
    box.width / box.height,
    0.05,
    500,
  );
  camera.position.set(4, 3, 6);
  camera.lookAt(0, 0, 0);
  // Vector3.project reads matrixWorldInverse, which is only refreshed
  // by updateMatrixWorld (a render would do it; this camera never
  // renders). Without this the projection uses a stale view matrix.
  camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(point[0], point[1], point[2]).project(camera);
  return {
    x: box.x + ((v.x + 1) / 2) * box.width,
    y: box.y + ((1 - v.y) / 2) * box.height,
  };
}

/** Click the canvas at a world-space point (plain click = select). */
export async function clickWorldPoint(
  page: Page,
  point: [number, number, number],
  modifiers?: { shift?: boolean },
  canvasSelector = "canvas",
): Promise<void> {
  // The editor route's canvas sits below the fold on the tall mock
  // page; boundingBox() is viewport-relative, so the canvas must be
  // scrolled into view BEFORE projecting (a no-op when already
  // visible, e.g. the pane canvas).
  await page.locator(canvasSelector).first().scrollIntoViewIfNeeded();
  let { x, y } = await projectPoint(page, point, canvasSelector);
  // The mock page grows the canvas with the inspector, so a tall canvas can put the
  // projected point below (or above) the visible window: scroll it into view first.
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  if (y < 8 || y > viewportHeight - 8) {
    await page.evaluate((dy) => window.scrollBy(0, dy), y - viewportHeight / 2);
    ({ x, y } = await projectPoint(page, point, canvasSelector));
  }
  if (modifiers?.shift) {
    // Hold Shift on the keyboard: mouse.click's `modifiers` option
    // does NOT set shiftKey on the pointer events in this Chromium /
    // CDP path (proven: pointerdown arrived with shift=false), so the
    // click would replace the selection instead of adding to it.
    await page.keyboard.down("Shift");
    try {
      await page.mouse.click(x, y);
    } finally {
      await page.keyboard.up("Shift");
    }
  } else {
    await page.mouse.click(x, y);
  }
}

/** Wait until the viewport's selected primary is the given node id. */
export async function waitForPrimary(
  page: Page,
  id: string,
  timeout = 10000,
): Promise<void> {
  await page.waitForFunction(
    (want) =>
      (window.__plastis3dViewport as unknown as ViewportTelemetry)
        ?.selectedPrimary === want,
    id,
    { timeout },
  );
}

/** Wait until the EDITOR viewport's selected primary is the given node id. */
export async function waitForEditorPrimary(
  page: Page,
  id: string,
  timeout = 10000,
): Promise<void> {
  await page.waitForFunction(
    (want) =>
      (
        window as unknown as {
          __plastis3dViewportEditor?: ViewportTelemetry;
        }
      ).__plastis3dViewportEditor?.selectedPrimary === want,
    id,
    { timeout },
  );
}

/**
 * Switch the toolbar to a gizmo mode by its aria-label.
 *
 * Scoped to the pane: the editor route renders the same mode buttons
 * with the same aria-labels (the G-10 accessible names), so an unscoped
 * `getByRole("button", ...)` matches both and throws a strict-mode
 * violation. Every caller drives the pane's viewport.
 */
export async function setGizmoMode(
  page: Page,
  label: "Select (Q)" | "Move (W)" | "Rotate (E)" | "Scale (R)",
): Promise<void> {
  await page.locator("#panes").getByRole("button", { name: label }).click();
}
