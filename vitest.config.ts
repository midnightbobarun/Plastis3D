// vitest.config.ts — Tier 2 (pure TS, Node) test config.
//
// Only tests/node runs here: the builder, cache, and api modules must
// not import @hermes/plugin-sdk, so no SDK stub is needed. The
// Playwright harness (tests/harness) is a separate Tier 4 setup and is
// not included.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/node/**/*.test.ts", "tests/node/**/*.test.mjs"],
    environment: "node",
  },
});
