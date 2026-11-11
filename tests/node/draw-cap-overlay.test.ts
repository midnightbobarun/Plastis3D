// tests/node/draw-cap-overlay.test.ts — the draw-cap overlay text
// selector (Tier 2, Phase 4 G-13).
//
// Covers src/viewport/drawCapOverlay.ts: the pure function returns
// the exact sentences for the four not-drawn cases, including the MB
// figure (bytes / 1_048_576, one decimal) and plain numbers throughout
// (N-02 — no toLocaleString() grouping anywhere in the overlay).
import { describe, expect, it } from "vitest";
import { COPY } from "../../src/copy";
import { drawCapOverlayText } from "../../src/viewport/drawCapOverlay";

describe("drawCapOverlayText", () => {
  it("over-cap shows tooLarge with tris and MB, plain numbers", () => {
    const text = drawCapOverlayText({
      reason: "over-cap",
      tris: 150000,
      bytes: 12582912,
    });
    expect(text.title).toBe(COPY.tooLarge);
    expect(text.title).toBe("Too large to draw in the Hermes window.");
    // 12,582,912 bytes is exactly 12.0 MB; tris has no grouping comma.
    expect(text.detail).toBe(
      "150000 triangles · 12.0 MB. The scene is saved.",
    );
  });

  it("over-cap with one-decimal MB rounds, never groups", () => {
    const text = drawCapOverlayText({
      reason: "over-cap",
      tris: 1234567,
      bytes: 1572864,
    });
    expect(text.detail).toBe(
      "1234567 triangles · 1.5 MB. The scene is saved.",
    );
  });

  it("over-cap without known numbers has no second line", () => {
    expect(
      drawCapOverlayText({ reason: "over-cap", tris: null, bytes: null }),
    ).toEqual({ title: COPY.tooLarge, detail: null });
    expect(
      drawCapOverlayText({ reason: "over-cap", tris: 150000, bytes: null }),
    ).toEqual({ title: COPY.tooLarge, detail: null });
  });

  it("asset-too-large (413) uses the same tooLarge sentence and the spec stats", () => {
    const text = drawCapOverlayText({
      reason: "asset-too-large",
      tris: 840,
      bytes: 2184,
    });
    expect(text.title).toBe(COPY.tooLarge);
    // The 413 body carries no stats, so the spec's stored figures are
    // the source: 2,184 bytes is 0.0 MB at one decimal.
    expect(text.detail).toBe("840 triangles · 0.0 MB. The scene is saved.");
  });

  it("tris null shows storedNotDrawn, plus notTriangles when ignored mentions a mode", () => {
    const withMode = drawCapOverlayText({
      reason: "not-triangles",
      tris: null,
      bytes: 2184,
      ignored: ["mesh 0 primitive 1: mode 1 (LINES) is not TRIANGLES; skipped"],
    });
    expect(withMode.title).toBe(COPY.storedNotDrawn);
    expect(withMode.title).toBe(
      "Plastis3D stored this model but will not draw it.",
    );
    expect(withMode.detail).toBe(COPY.notTriangles);
    expect(withMode.detail).toBe("It isn't a triangle mesh.");

    const withoutMode = drawCapOverlayText({
      reason: "not-triangles",
      tris: null,
      bytes: 2184,
      ignored: ["camera in node 2"],
    });
    expect(withoutMode.title).toBe(COPY.storedNotDrawn);
    expect(withoutMode.detail).toBeNull();

    const noIgnored = drawCapOverlayText({
      reason: "not-triangles",
      tris: null,
      bytes: 2184,
    });
    expect(noIgnored.detail).toBeNull();
  });

  it("an unavailable fetch stays storedNotDrawn with no second line", () => {
    expect(
      drawCapOverlayText({ reason: "unavailable", tris: 840, bytes: 2184 }),
    ).toEqual({ title: COPY.storedNotDrawn, detail: null });
  });

  it("not-drawable with both figures (the byte-limit case) is tooLarge with the stats line", () => {
    expect(
      drawCapOverlayText({ reason: "not-drawable", tris: 60000, bytes: 14_400_000 }),
    ).toEqual({
      title: COPY.tooLarge,
      detail: "60000 triangles · 13.7 MB. The scene is saved.",
    });
  });

  it("not-drawable with a figure unknown stays storedNotDrawn with no second line", () => {
    expect(
      drawCapOverlayText({ reason: "not-drawable", tris: 840, bytes: null }),
    ).toEqual({ title: COPY.storedNotDrawn, detail: null });
  });
});
