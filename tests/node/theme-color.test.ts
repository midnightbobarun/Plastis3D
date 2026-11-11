// Redesign §1.1 row 11: the host's computed colours are CSS Color 4
// strings that THREE.Color cannot parse. parseCssColor covers every
// serialisation a browser produces for a computed colour.
import { describe, expect, it } from "vitest";
import {
  compositeOver,
  luminance,
  parseCssColor,
  resolveCssColor,
  rgbaToHex,
} from "../../src/theme";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-3;

describe("parseCssColor", () => {
  it("parses the host's light background, color(srgb …)", () => {
    const c = parseCssColor("color(srgb 0.996235 0.996235 0.996235)");
    expect(c).not.toBeNull();
    expect(close(c!.r, 0.996235)).toBe(true);
    expect(c!.a).toBe(1);
  });
  it("parses color(srgb …) with an alpha", () => {
    const c = parseCssColor("color(srgb 0.0509804 0.0625882 0.0810196 / 0.5)");
    expect(c!.a).toBe(0.5);
    expect(rgbaToHex(c!)).toBe("#0d1015");
  });
  it("parses rgb, rgba and space syntax", () => {
    expect(parseCssColor("rgb(255, 0, 0)")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseCssColor("rgba(0, 0, 255, 0.25)")!.a).toBe(0.25);
    expect(parseCssColor("rgb(0 128 0 / 50%)")!.a).toBe(0.5);
  });
  it("parses hex in all four lengths", () => {
    expect(rgbaToHex(parseCssColor("#0053fd")!)).toBe("#0053fd");
    expect(rgbaToHex(parseCssColor("#fff")!)).toBe("#ffffff");
    expect(parseCssColor("#ffffff80")!.a).toBeCloseTo(0.502, 2);
    expect(parseCssColor("#f008")!.a).toBeCloseTo(0.533, 2);
  });
  it("parses transparent as zero alpha", () => {
    expect(parseCssColor("transparent")!.a).toBe(0);
  });
  it("returns null for forms only the browser can resolve, and garbage", () => {
    expect(
      parseCssColor(
        "color-mix(in srgb, #0053fd 16%, color-mix(in srgb, #1f2328 7%, transparent))",
      ),
    ).toBeNull();
    expect(parseCssColor("oklch(0.7 0.1 200)")).toBeNull();
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("not a colour")).toBeNull();
    expect(parseCssColor("#ggg")).toBeNull();
    expect(parseCssColor("")).toBeNull();
  });
  it("resolveCssColor without a DOM returns null for unresolvable forms, never white", () => {
    expect(resolveCssColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
    expect(resolveCssColor("")).toBeNull();
    expect(rgbaToHex(resolveCssColor("color(srgb 0 0 0)")!)).toBe("#000000");
  });
});

describe("compositeOver and luminance", () => {
  it("composites a faint stroke over a dark background", () => {
    const stroke = { r: 1, g: 1, b: 1, a: 0.1 };
    const bg = { r: 0, g: 0, b: 0, a: 1 };
    const out = compositeOver(stroke, bg);
    expect(close(out.r, 0.1)).toBe(true);
    expect(out.a).toBe(1);
  });
  it("orders luminance", () => {
    expect(luminance({ r: 1, g: 1, b: 1, a: 1 })).toBeCloseTo(1, 5);
    expect(luminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
  });
});
