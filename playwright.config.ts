// playwright.config.ts — Tier 4 harness config (Stage 4, PR4).
//
// Runs the specs in tests/harness against the Vite dev server serving
// the mock host. Chromium runs as root on this VM, so --no-sandbox is
// required (PR1 note). Workers: 1 — the specs count rest calls and
// observe 4 s poll timing, so they run serially.
//
// The mock host loads the BUILT desktop/plugin.js, so build first:
//   npm run test:harness   (builds, then runs these specs)
// Run Playwright detached to a log file: foreground exec runs of the
// harness stalled in session plumbing in PR1 while the same check
// detached completed in ~2 s.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/harness",
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    launchOptions: { args: ["--no-sandbox"] },
  },
  webServer: {
    command: "npx vite --config tests/harness/vite.config.mts",
    url: "http://localhost:5173/tests/harness/mock-host.html",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
