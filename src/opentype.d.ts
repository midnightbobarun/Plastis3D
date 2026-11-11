// Minimal types for the parts of opentype.js 2.0 this plugin uses (the package ships none).
declare module "opentype.js" {
  export interface PathCommand { type: "M" | "L" | "C" | "Q" | "Z"; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }
  export interface Path { commands: PathCommand[] }
  export interface Glyph { index: number; name?: string; advanceWidth?: number; getPath(x: number, y: number, fontSize: number): Path }
  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    charToGlyph(char: string): Glyph;
    getKerningValue(left: Glyph, right: Glyph): number;
  }
  export function parse(buffer: ArrayBuffer): Font;
}
