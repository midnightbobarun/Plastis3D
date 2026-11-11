// src/scene/text.ts — 3D text from the bundled font (PR23). Pure: no DOM, so Vitest tests it directly.
//
// opentype.js (parsed lazily, once) gives glyph outlines. They become THREE.Shapes (holes come from the
// winding), are extruded with ExtrudeGeometry (three core), laid out by `align` and `lineHeight`, and
// returned as an indexed mesh ready for POST /scenes/{id}/bakes. The pivot is the baseline at the
// alignment point: x = 0 is the left edge, the centre or the right edge of each line, y = 0 the first
// baseline, and the depth is centred on z. A character the font lacks is refused (TEXT_GLYPH_MISSING),
// never drawn as a box. Over 100,000 triangles, or slower than 250 ms, is TEXT_TOO_COMPLEX.
import * as THREE from "three";
import { parse } from "opentype.js";
import type { Font, Glyph } from "opentype.js";
import { BUNDLED_FONT_BASE64, BUNDLED_FONT_ID } from "../assets/font";
import type { EditMesh } from "./meshEdit";

export interface TextBevel { enabled: boolean; thickness: number; size: number }
export interface TextParams {
  text: string; size: number; depth: number; bevel: TextBevel; curveSegments: number;
  align: "left" | "center" | "right"; lineHeight: number; font: typeof BUNDLED_FONT_ID;
}

export const DEFAULT_TEXT_PARAMS: TextParams = {
  text: "Text", size: 0.2, depth: 0.05, bevel: { enabled: false, thickness: 0.01, size: 0.01 },
  curveSegments: 4, align: "left", lineHeight: 1.2, font: BUNDLED_FONT_ID,
};

export const MAX_TEXT_TRIANGLES = 100_000;
export const TEXT_TIME_BUDGET_MS = 250;

export type TextErrorCode = "TEXT_INVALID" | "TEXT_GLYPH_MISSING" | "TEXT_TOO_COMPLEX";
export class TextError extends Error {
  readonly code: TextErrorCode;
  readonly chars: string[];
  constructor(code: TextErrorCode, message: string, chars: string[] = []) { super(message); this.name = "TextError"; this.code = code; this.chars = chars; }
}

const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** The same rules as the server's `text` generator validation (plastis3d_scene/validate.py). */
export function validateTextParams(input: unknown): TextParams {
  const p = input as Partial<TextParams> | null;
  const fail = (m: string): never => { throw new TextError("TEXT_INVALID", m); };
  if (!p || typeof p !== "object") return fail("The text settings are missing.");
  if (typeof p.text !== "string" || p.text.length < 1 || p.text.length > 200 || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(p.text)) fail("Text must be 1 to 200 characters.");
  if (!inRange(p.size, 0.01, 10)) fail("Size must be from 0.01 to 10 metres.");
  const size = p.size as number;
  if (!inRange(p.depth, 0, size)) fail("Depth must be from 0 to the size.");
  if (!inRange(p.lineHeight, 0.8, 3)) fail("Line height must be from 0.8 to 3.");
  if (!Number.isInteger(p.curveSegments) || (p.curveSegments as number) < 1 || (p.curveSegments as number) > 12) fail("Curve segments must be a whole number from 1 to 12.");
  if (p.align !== "left" && p.align !== "center" && p.align !== "right") fail("Align must be left, centre or right.");
  if (p.font !== BUNDLED_FONT_ID) fail("Only the bundled font is available.");
  const b = p.bevel;
  if (!b || typeof b.enabled !== "boolean" || !inRange(b.thickness, 0, size) || !inRange(b.size, 0, size)) fail("The bevel settings are out of range.");
  return p as TextParams;
}

let cachedFont: Font | null = null;
/** The bundled font, parsed once. */
export function bundledFont(): Font {
  if (!cachedFont) {
    const binary = atob(BUNDLED_FONT_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    cachedFont = parse(bytes.buffer);
  }
  return cachedFont;
}

/** Characters (other than newline) the font has no glyph for. */
export function missingGlyphs(font: Font, text: string): string[] {
  const missing: string[] = [];
  for (const ch of text) {
    if (ch === "\n") continue;
    if (font.charToGlyph(ch).index === 0 && !missing.includes(ch)) missing.push(ch);
  }
  return missing;
}

interface Line { glyphs: Glyph[]; advances: number[]; width: number }

function layoutLine(font: Font, text: string, size: number): Line {
  const scale = size / font.unitsPerEm;
  const glyphs = [...text].map((ch) => font.charToGlyph(ch));
  const advances: number[] = [];
  let x = 0;
  glyphs.forEach((glyph, i) => {
    advances.push(x);
    x += (glyph.advanceWidth ?? 0) * scale;
    if (i + 1 < glyphs.length) x += font.getKerningValue(glyph, glyphs[i + 1]) * scale;
  });
  return { glyphs, advances, width: x };
}

/** A fast upper bound on the triangles before any extrusion happens. */
export function estimateTriangles(font: Font, params: TextParams): number {
  let points = 0;
  for (const ch of params.text) {
    if (ch === "\n") continue;
    for (const c of font.charToGlyph(ch).getPath(0, 0, 1000).commands) {
      points += c.type === "C" || c.type === "Q" ? params.curveSegments : c.type === "Z" ? 0 : 1;
    }
  }
  // Two caps (about one triangle per outline point each) and a wall of two triangles per point per layer.
  return Math.ceil(points * (2 + 2 + (params.bevel.enabled ? 4 : 0)));
}

/** Build the text mesh. Throws TextError for bad parameters, missing glyphs or too much geometry. */
export function buildTextMesh(input: unknown, font: Font = bundledFont(), now: () => number = () => performance.now()): EditMesh {
  const params = validateTextParams(input);
  const started = now();
  const missing = missingGlyphs(font, params.text);
  if (missing.length) throw new TextError("TEXT_GLYPH_MISSING", `The bundled font has no glyph for: ${missing.join(" ")}`, missing);
  if (estimateTriangles(font, params) > MAX_TEXT_TRIANGLES) throw new TextError("TEXT_TOO_COMPLEX", "This text is too detailed. Use fewer characters, a lower curve setting or no bevel.");

  const scale = params.size / font.unitsPerEm;
  const lines = params.text.split("\n").map((line) => layoutLine(font, line, params.size));
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  lines.forEach((line, lineIndex) => {
    const shapePath = new THREE.ShapePath();
    const offset = params.align === "left" ? 0 : params.align === "center" ? -line.width / 2 : -line.width;
    const baseline = -lineIndex * params.lineHeight * params.size;
    line.glyphs.forEach((glyph, i) => {
      if (glyph.index === 0) return;
      const x0 = offset + line.advances[i];
      for (const c of glyph.getPath(0, 0, params.size).commands) {
        const px = (v: number | undefined) => (v ?? 0) + x0;
        const py = (v: number | undefined) => -(v ?? 0) + baseline; // opentype paths are y-down
        if (c.type === "M") shapePath.moveTo(px(c.x), py(c.y));
        else if (c.type === "L") shapePath.lineTo(px(c.x), py(c.y));
        else if (c.type === "Q") shapePath.quadraticCurveTo(px(c.x1), py(c.y1), px(c.x), py(c.y));
        else if (c.type === "C") shapePath.bezierCurveTo(px(c.x1), py(c.y1), px(c.x2), py(c.y2), px(c.x), py(c.y));
      }
    });
    const shapes = shapePath.toShapes(false);
    if (!shapes.length) return; // a blank line
    const geometry = new THREE.ExtrudeGeometry(shapes, {
      depth: params.depth, curveSegments: params.curveSegments, bevelEnabled: params.bevel.enabled && params.depth > 0,
      bevelThickness: params.bevel.thickness, bevelSize: params.bevel.size, bevelSegments: 1,
    });
    const p = geometry.getAttribute("position"), n = geometry.getAttribute("normal"), u = geometry.getAttribute("uv");
    const base = positions.length / 3;
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i) - params.depth / 2);
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      uvs.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) indices.push(base + i);
    geometry.dispose();
    if (indices.length / 3 > MAX_TEXT_TRIANGLES) throw new TextError("TEXT_TOO_COMPLEX", "This text is too detailed. Use fewer characters, a lower curve setting or no bevel.");
  });
  void scale;
  if (indices.length < 3) throw new TextError("TEXT_INVALID", "There is nothing to draw: the text has no visible characters.");
  if (now() - started > TEXT_TIME_BUDGET_MS) throw new TextError("TEXT_TOO_COMPLEX", "This text took too long to build. Use fewer characters, a lower curve setting or no bevel.");
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices) };
}

/** The text's width of its longest line in metres (for placement and tests). */
export function textWidth(params: TextParams, font: Font = bundledFont()): number {
  return Math.max(...params.text.split("\n").map((line) => layoutLine(font, line, params.size).width));
}
