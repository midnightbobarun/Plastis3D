import { describe, expect, it } from "vitest";
import { buildTextMesh, bundledFont, DEFAULT_TEXT_PARAMS, estimateTriangles, missingGlyphs, textWidth, TextError, validateTextParams } from "../../src/scene/text";
import type { TextParams } from "../../src/scene/text";
import { buildTopology, triangleCount } from "../../src/scene/meshEdit";

const P = (changes: Partial<TextParams> = {}): TextParams => ({ ...DEFAULT_TEXT_PARAMS, ...changes });
const bounds = (m: { positions: Float32Array }) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < m.positions.length / 3; v++) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.positions[v * 3 + k]); hi[k] = Math.max(hi[k], m.positions[v * 3 + k]); }
  return { lo, hi };
};
const code = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as TextError).code; } return null; };

describe("the bundled font", () => {
  it("loads once, in the font's own units", () => {
    expect(bundledFont()).toBe(bundledFont());
    expect(bundledFont().unitsPerEm).toBe(2048);
  });
  it("has every printable Latin-1 character, and reports the ones it lacks", () => {
    const f = bundledFont();
    expect(missingGlyphs(f, "Hello, wörld! ÀÉÎÕÜ ß ½ ©")).toEqual([]);
    expect(missingGlyphs(f, "A 日本 ☃ B ☃")).toEqual(["日", "本", "☃"]);
  });
});

describe("glyph holes and mesh shape", () => {
  it("'o', 'A' and '8' have holes, so their meshes have more triangles than a solid of the same outline would", () => {
    const solid = buildTextMesh(P({ text: "l" }));
    for (const ch of ["o", "A", "8"]) {
      const mesh = buildTextMesh(P({ text: ch }));
      const t = buildTopology(mesh);
      // A hole is a second boundary loop: the cap has boundary edges used by one triangle in two separate loops.
      expect(triangleCount(mesh)).toBeGreaterThan(triangleCount(solid));
      expect(t.edges.length).toBeGreaterThan(0);
    }
    // The counter of "o" is empty space: no vertex of the front cap lies at the glyph centre.
    const o = buildTextMesh(P({ text: "o", depth: 0 }));
    const { lo, hi } = bounds(o);
    const cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    let covered = false;
    for (let f = 0; f < triangleCount(o); f++) {
      const [a, b, c] = [0, 1, 2].map((k) => o.indices[f * 3 + k] * 3);
      const [ax, ay, bx, by, px, py] = [o.positions[a], o.positions[a + 1], o.positions[b], o.positions[b + 1], cx, cy];
      const cxv = o.positions[c], cyv = o.positions[c + 1];
      const d = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
      const d1 = d(px, py, ax, ay, bx, by), d2 = d(px, py, bx, by, cxv, cyv), d3 = d(px, py, cxv, cyv, ax, ay);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) covered = true;
    }
    expect(covered).toBe(false);
  });

  it("is deterministic: a fixed string gives fixed vertex and index counts", () => {
    const a = buildTextMesh(P({ text: "Hello", curveSegments: 4 }));
    const b = buildTextMesh(P({ text: "Hello", curveSegments: 4 }));
    expect(a.positions.length / 3).toBe(b.positions.length / 3);
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
    expect(a.positions.length / 3).toBe(2604);
    expect(triangleCount(a)).toBe(868);
    expect(buildTextMesh(P({ text: "Hello", curveSegments: 2 })).indices.length).toBeLessThan(a.indices.length);
  });

  it("is indexed, finite, with matching arrays and a centred depth", () => {
    const m = buildTextMesh(P({ text: "Plastis", depth: 0.1 }));
    expect(m.normals.length).toBe(m.positions.length);
    expect(m.uvs!.length / 2).toBe(m.positions.length / 3);
    expect(Array.from(m.positions).every(Number.isFinite)).toBe(true);
    expect(Math.max(...m.indices)).toBeLessThan(m.positions.length / 3);
    const { lo, hi } = bounds(m);
    expect(lo[2]).toBeCloseTo(-0.05, 5);
    expect(hi[2]).toBeCloseTo(0.05, 5);
  });

  it("a bevel adds geometry, and depth 0 gives a flat sign", () => {
    const plain = buildTextMesh(P({ text: "B" }));
    const beveled = buildTextMesh(P({ text: "B", bevel: { enabled: true, thickness: 0.01, size: 0.01 } }));
    expect(triangleCount(beveled)).toBeGreaterThan(triangleCount(plain));
    const flat = bounds(buildTextMesh(P({ text: "B", depth: 0 })));
    expect(flat.hi[2] - flat.lo[2]).toBeCloseTo(0, 6);
  });
});

describe("layout", () => {
  it("size scales the text", () => {
    const a = bounds(buildTextMesh(P({ text: "H", size: 0.2 }))), b = bounds(buildTextMesh(P({ text: "H", size: 0.4 })));
    expect((b.hi[1] - b.lo[1]) / (a.hi[1] - a.lo[1])).toBeCloseTo(2, 3);
  });
  it("the baseline is y = 0: capitals sit above it and descenders below", () => {
    const h = bounds(buildTextMesh(P({ text: "H" })));
    expect(h.lo[1]).toBeCloseTo(0, 2);
    expect(h.hi[1]).toBeGreaterThan(0.1);
    expect(bounds(buildTextMesh(P({ text: "p" }))).lo[1]).toBeLessThan(-0.02);
  });
  it("left, centre and right alignment put the pivot at the left edge, the middle and the right edge", () => {
    const text = "Hello";
    const width = textWidth(P({ text }));
    const left = bounds(buildTextMesh(P({ text, align: "left" }))), centre = bounds(buildTextMesh(P({ text, align: "center" }))), right = bounds(buildTextMesh(P({ text, align: "right" })));
    expect(left.lo[0]).toBeGreaterThan(-0.02);
    expect(left.hi[0]).toBeCloseTo(width, 1);
    expect((centre.lo[0] + centre.hi[0]) / 2).toBeCloseTo(0, 1);
    expect(right.hi[0]).toBeCloseTo(0, 1);
    expect(right.lo[0]).toBeCloseTo(-width, 1);
  });
  it("lines step down by lineHeight times the size, and each line aligns on its own width", () => {
    const one = bounds(buildTextMesh(P({ text: "H" })));
    const two = bounds(buildTextMesh(P({ text: "H\nH", lineHeight: 1.5 })));
    expect(one.lo[1] - two.lo[1]).toBeCloseTo(1.5 * 0.2, 2);
    const centred = bounds(buildTextMesh(P({ text: "HHHH\nH", align: "center" })));
    expect((centred.lo[0] + centred.hi[0]) / 2).toBeCloseTo(0, 1);
  });
});

describe("limits and validation", () => {
  it("refuses a missing glyph by name and never draws a box", () => {
    try { buildTextMesh(P({ text: "A日B" })); throw new Error("no error"); } catch (e) { expect((e as TextError).code).toBe("TEXT_GLYPH_MISSING"); expect((e as TextError).chars).toEqual(["日"]); }
  });
  it("estimates before extruding and refuses over the cap", () => {
    const f = bundledFont();
    expect(estimateTriangles(f, P({ text: "Hello" }))).toBeGreaterThan(790 * 0.5);
    expect(code(() => buildTextMesh(P({ text: "W".repeat(200), size: 1, curveSegments: 12, bevel: { enabled: true, thickness: 0.1, size: 0.1 } })))).toBe("TEXT_TOO_COMPLEX");
  });
  it("refuses a build that overruns the time budget", () => {
    let t = 0;
    expect(code(() => buildTextMesh(P({ text: "Hi" }), bundledFont(), () => (t += 300)))).toBe("TEXT_TOO_COMPLEX");
  });
  it("whitespace alone has nothing to draw", () => {
    expect(code(() => buildTextMesh(P({ text: "   " })))).toBe("TEXT_INVALID");
  });
  it("validates every parameter with the server's rules", () => {
    const bad: Array<Partial<TextParams>> = [
      { text: "" }, { text: "x".repeat(201) }, { text: "a\u0007" }, { size: 0 }, { size: 11 }, { size: Number.NaN }, { depth: -1 }, { depth: 0.5 },
      { curveSegments: 0 }, { curveSegments: 13 }, { curveSegments: 2.5 }, { align: "justify" as never }, { lineHeight: 0.5 }, { lineHeight: 4 },
      { font: "comic" as never }, { bevel: { enabled: true, thickness: 5, size: 0 } }, { bevel: { enabled: 1 as never, thickness: 0, size: 0 } },
    ];
    for (const changes of bad) expect(code(() => validateTextParams(P(changes))), JSON.stringify(changes)).toBe("TEXT_INVALID");
    expect(validateTextParams(P({ text: "ok\nfine" })).text).toBe("ok\nfine");
    expect(code(() => validateTextParams(null))).toBe("TEXT_INVALID");
  });
});
