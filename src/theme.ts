// src/theme.ts — read the pane's theme from computed styles (Stage 4,
// PR4 §4.2; N-01 walk-up, UI/UX fix 2026-11-07; colour resolver,
// UI/UX redesign §1.1 row 11, 2026-11-09).
//
// Reads the pane's computed background plus the --ui-accent,
// --ui-stroke-secondary, and --ui-text-secondary custom properties via
// getComputedStyle. No MutationObserver on document.body.
//
// Hermes v0.23.0 reports its colours in CSS Color 4 forms: computed
// backgrounds are `color(srgb r g b)`, and several tokens are nested
// `color-mix(in srgb, …)` expressions. THREE.Color parses neither — it
// logs "Unknown color model" and silently keeps white, which made the
// viewport white in both themes with an invisible white grid. So no raw
// CSS string reaches THREE.Color any more: every colour goes through
// resolveCssColor(), which lets the browser compute the value and then
// parses the few serialisations a browser produces.

export interface PaneTheme {
  background: string;
  accent: string;
  stroke: string;
  /** --ui-text-secondary (grid lines, PR32). */
  textSecondary: string;
  /** --ui-red / --ui-blue: the X and Z axis lines (redesign §5.3). */
  red: string;
  blue: string;
}

/** A resolved sRGB colour, channels 0..1, alpha 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const TRANSPARENT = "rgba(0, 0, 0, 0)";

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Parse one numeric component: "50%" -> 0.5 of `scale`, "0.3" -> 0.3. */
function component(token: string, scale: number): number | null {
  const t = token.trim();
  if (t === "none") return 0;
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * scale : null;
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the serialisations a browser produces for a computed colour,
 * plus hex: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`
 * (comma or space syntax), `color(srgb r g b [/ a])` and the keyword
 * `transparent`. Returns null for anything else (oklch, color-mix,
 * names): the DOM resolver below turns those into one of these forms.
 * Pure — no DOM — so it is unit-tested in Node.
 */
export function parseCssColor(input: string): Rgba | null {
  const css = input.trim().toLowerCase();
  if (!css) return null;
  if (css === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (css.startsWith("#")) {
    const hex = css.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    const expand = (s: string) => (s.length === 1 ? s + s : s);
    let parts: string[];
    if (hex.length === 3 || hex.length === 4) parts = hex.split("").map(expand);
    else if (hex.length === 6 || hex.length === 8) parts = hex.match(/../g) ?? [];
    else return null;
    const [r, g, b, a = "ff"] = parts;
    return {
      r: parseInt(r, 16) / 255,
      g: parseInt(g, 16) / 255,
      b: parseInt(b, 16) / 255,
      a: parseInt(a, 16) / 255,
    };
  }
  const fn = /^([a-z-]+)\((.*)\)$/.exec(css);
  if (!fn) return null;
  const [, name, body] = fn;
  // Split off "/ alpha", then split on commas or whitespace.
  const [main, alphaPart] = body.split("/");
  let tokens = main.split(/[\s,]+/).filter(Boolean);
  let alphaToken = alphaPart?.trim();
  if (name === "rgb" || name === "rgba") {
    if (tokens.length === 4 && alphaToken === undefined) {
      alphaToken = tokens[3];
      tokens = tokens.slice(0, 3);
    }
    if (tokens.length !== 3) return null;
    const rgb = tokens.map((t) => component(t, 255));
    if (rgb.some((v) => v === null)) return null;
    const a = alphaToken === undefined ? 1 : component(alphaToken, 1);
    if (a === null) return null;
    return {
      r: clamp01((rgb[0] as number) / 255),
      g: clamp01((rgb[1] as number) / 255),
      b: clamp01((rgb[2] as number) / 255),
      a: clamp01(a),
    };
  }
  if (name === "color") {
    const space = tokens.shift();
    if (space !== "srgb" || tokens.length !== 3) return null;
    const rgb = tokens.map((t) => component(t, 1));
    if (rgb.some((v) => v === null)) return null;
    const a = alphaToken === undefined ? 1 : component(alphaToken, 1);
    if (a === null) return null;
    return {
      r: clamp01(rgb[0] as number),
      g: clamp01(rgb[1] as number),
      b: clamp01(rgb[2] as number),
      a: clamp01(a),
    };
  }
  return null;
}

/** `rgba` composited over an opaque `under` (straight alpha). */
export function compositeOver(rgba: Rgba, under: Rgba): Rgba {
  const a = rgba.a;
  return {
    r: rgba.r * a + under.r * (1 - a),
    g: rgba.g * a + under.g * (1 - a),
    b: rgba.b * a + under.b * (1 - a),
    a: 1,
  };
}

/** `#rrggbb` for an opaque colour (alpha ignored). */
export function rgbaToHex(rgba: Rgba): string {
  const h = (v: number) =>
    Math.round(clamp01(v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(rgba.r)}${h(rgba.g)}${h(rgba.b)}`;
}

let probeCanvas: CanvasRenderingContext2D | null | undefined;

/** Last resort: paint the colour on a 1×1 2D canvas and read it back. */
function canvasProbe(css: string): Rgba | null {
  if (typeof document === "undefined") return null;
  if (probeCanvas === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probeCanvas = canvas.getContext("2d", { willReadFrequently: true });
  }
  const ctx = probeCanvas;
  if (!ctx) return null;
  // A value the browser rejects leaves fillStyle unchanged: set two
  // different sentinels; if the colour sticks after both, it parsed.
  ctx.fillStyle = "#010203";
  ctx.fillStyle = css;
  const first = ctx.fillStyle;
  ctx.fillStyle = "#040506";
  ctx.fillStyle = css;
  if (ctx.fillStyle !== first) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

/**
 * Resolve any CSS colour the browser accepts (including `color-mix`,
 * `oklch`, `color(srgb …)`, names and `var()` chains when `within` is
 * given) to sRGB. `within` is an element of the plugin's own subtree; a
 * hidden probe span is appended there for the computed-style read and
 * removed at once (never host markup). Returns null when the value is
 * empty or not a colour, so the caller applies its own fallback —
 * never white by accident.
 */
export function resolveCssColor(css: string, within?: Element | null): Rgba | null {
  const value = css.trim();
  if (!value) return null;
  const direct = parseCssColor(value);
  if (direct) return direct;
  if (typeof document !== "undefined" && within) {
    const probe = document.createElement("span");
    probe.style.display = "none";
    probe.style.color = value;
    if (probe.style.color) {
      within.appendChild(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      const parsed = parseCssColor(computed);
      if (parsed) return parsed;
      return canvasProbe(computed) ?? canvasProbe(value);
    }
  }
  return canvasProbe(value);
}

function computedBackground(element: Element): string {
  const value = getComputedStyle(element).backgroundColor.trim();
  if (!value || value === TRANSPARENT) return "";
  const parsed = parseCssColor(value);
  if (parsed && parsed.a === 0) return "";
  return value;
}

/**
 * Read the theme for the pane containing `from` (the canvas's parent
 * element — the Viewport mount div). The background walks up from
 * `from` until it is not transparent; with no `from` it starts at
 * document.body. Custom properties come from document.body in all cases.
 * Values are raw CSS strings: pass them through resolveCssColor().
 */
export function readTheme(from?: Element | null): PaneTheme {
  if (typeof document === "undefined") {
    return { background: "", accent: "", stroke: "", textSecondary: "", red: "", blue: "" };
  }
  let background = "";
  let element: Element | null = from ?? document.body;
  while (element) {
    background = computedBackground(element);
    if (background) break;
    element = element.parentElement;
  }
  const bodyStyle = getComputedStyle(document.body);
  return {
    background,
    accent: bodyStyle.getPropertyValue("--ui-accent").trim(),
    stroke: bodyStyle.getPropertyValue("--ui-stroke-secondary").trim(),
    textSecondary: bodyStyle.getPropertyValue("--ui-text-secondary").trim(),
    red: bodyStyle.getPropertyValue("--ui-red").trim(),
    blue: bodyStyle.getPropertyValue("--ui-blue").trim(),
  };
}

/** Relative luminance (WCAG) of an opaque sRGB colour. */
export function luminance(rgba: Rgba): number {
  const lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(rgba.r) + 0.7152 * lin(rgba.g) + 0.0722 * lin(rgba.b);
}
