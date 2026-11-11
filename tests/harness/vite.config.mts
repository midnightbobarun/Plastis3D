// tests/harness/vite.config.ts — Vite dev server for the Tier 4 mock host.
//
// Serves the repo root so mock-host.html and the built desktop/plugin.js are
// both reachable, and aliases '@hermes/plugin-sdk' to mock-host.ts: the SDK
// has no npm distribution (it is provided by the Desktop app), so the mock
// host stubs it here and npm react is the host React stand-in.
//
// Run from the repo root:
//   npx vite --config tests/harness/vite.config.ts
// Then open: http://localhost:5173/tests/harness/mock-host.html
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessDir, "../..");

export default defineConfig({
  root: repoRoot,
  server: {
    port: 5173,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: {
      "@hermes/plugin-sdk": resolve(harnessDir, "mock-host.ts"),
    },
  },
  // Scan only the harness pages for dependency pre-bundling. The repo
  // root also contains the ignored `plastisweb/` checkout, whose own
  // node_modules has a different three version; letting Vite crawl it
  // prebundles that copy and mixes two three builds in one page.
  optimizeDeps: {
    entries: ["tests/harness/*.html"],
  },
});
