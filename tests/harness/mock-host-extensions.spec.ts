// tests/harness/mock-host-extensions.spec.ts — Tier 4 smoke tests for
// the Phase 0 (0-E) mock-host extensions.
//
// Covers: the matchMedia stub for (prefers-reduced-motion: reduce)
// (toggleable per test, change listeners notified), the
// host.state.viewport.narrow stub (toggleable per test), the broadcast
// helper (a scene.changed payload distinct from a poll refetch — an
// emit refetches promptly, not on the 4 s poll schedule), and the
// document.activeElement assertion helper. The pane-root keydown
// dispatch is deliberately NOT built here — it serves only excluded
// G-01 (see D-IMPL-03 in the decisions file).
import { expect, test } from "@playwright/test";
import {
  activeElement,
  emitSceneChanged,
  gotoEditor,
  gotoMock,
  installErrorCollector,
  mockReport,
  setReducedMotion,
  setViewportNarrow,
} from "./pr5-helpers";

test("matchMedia stub: reduced-motion flips per test and notifies listeners", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  const matchesBefore = await page.evaluate(
    () =>
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(matchesBefore).toBe(false);

  await page.evaluate(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    (window as unknown as { __rmmEvents: boolean[] }).__rmmEvents = [];
    query.addEventListener("change", (event) => {
      (window as unknown as { __rmmEvents: boolean[] }).__rmmEvents.push(
        event.matches,
      );
    });
  });
  await setReducedMotion(page, true);
  const matchesAfter = await page.evaluate(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(matchesAfter).toBe(true);
  const events = await page.evaluate(
    () =>
      (window as unknown as { __rmmEvents: boolean[] }).__rmmEvents,
  );
  expect(events).toEqual([true]);

  await setReducedMotion(page, false);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        ),
      { timeout: 5000 },
    )
    .toBe(false);
  expect(pageErrors).toEqual([]);
});

test("viewport stub: narrow flips per test and reads back", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  const before = await page.evaluate(
    () => window.__plastis3dMock.__viewport(),
  );
  expect(before).toEqual({ width: 1280, height: 800, narrow: false });

  await setViewportNarrow(page, true);
  const narrow = await page.evaluate(
    () => window.__plastis3dMock.__viewport(),
  );
  expect(narrow).toEqual({ width: 320, height: 800, narrow: true });

  await setViewportNarrow(page, false);
  const wide = await page.evaluate(
    () => window.__plastis3dMock.__viewport(),
  );
  expect(wide.narrow).toBe(false);
  expect(pageErrors).toEqual([]);
});

test("broadcast helper: scene.changed refetches promptly, not on the poll schedule", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoMock(page);

  // The pane shows rev 1. Bump the mock store to rev 2, then deliver
  // the broadcast: the refetch (and the UI update) must land well
  // inside one 4 s poll interval, proving the broadcast path fired.
  await expect(page.locator("#panes")).toContainText("rev 1");
  await page.evaluate(() => window.__plastis3dMock.__bumpRevision());
  await emitSceneChanged(page, "demo-scene", 2);
  await expect
    .poll(() => page.locator("#panes").textContent(), { timeout: 2500 })
    .toContain("rev 2");
  expect(pageErrors).toEqual([]);
});

test("activeElement helper reports the focused element", async ({
  page,
}) => {
  const pageErrors = installErrorCollector(page);
  await gotoEditor(page);

  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("[data-plastis-root=editor]");
    root?.focus();
  });
  const focused = await activeElement(page);
  expect(focused?.tagName).toBe("DIV");
  expect(pageErrors).toEqual([]);
});
