// src/ui/materials.ts — the material presets and the colour palette
// (UI/UX redesign §7.4). These are scene VALUES the user writes into a
// material (hex is allowed here: redesign §4.2 exceptions), not chrome.

import type { MaterialSpec } from "../types";

export interface MaterialPreset {
  id: string;
  label: string;
  /** One plain line for the tooltip. */
  hint: string;
  roughness: number;
  metalness: number;
  opacity: number;
  /** A colour the preset sets, or null to keep the current colour. */
  color: string | null;
  /** "self" = emissive is the colour itself (Glow); "none" = black. */
  emissive: "self" | "none";
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  { id: "clay", label: "Clay", hint: "Soft and even — the default look", roughness: 0.6, metalness: 0, opacity: 1, color: null, emissive: "none" },
  { id: "matte", label: "Matte", hint: "Chalky, no shine at all", roughness: 0.95, metalness: 0, opacity: 1, color: null, emissive: "none" },
  { id: "plastic", label: "Plastic", hint: "A gentle, toy-like sheen", roughness: 0.35, metalness: 0, opacity: 1, color: null, emissive: "none" },
  { id: "glossy", label: "Glossy", hint: "Polished, with crisp highlights", roughness: 0.12, metalness: 0, opacity: 1, color: null, emissive: "none" },
  { id: "metal", label: "Metal", hint: "Brushed metal in this colour", roughness: 0.3, metalness: 1, opacity: 1, color: null, emissive: "none" },
  { id: "gold", label: "Gold", hint: "Warm polished gold", roughness: 0.25, metalness: 1, opacity: 1, color: "#d4a83f", emissive: "none" },
  { id: "rubber", label: "Rubber", hint: "Dull and slightly soft", roughness: 0.85, metalness: 0, opacity: 1, color: null, emissive: "none" },
  { id: "glass", label: "Glass", hint: "Clear and see-through", roughness: 0.05, metalness: 0, opacity: 0.35, color: "#dfeef5", emissive: "none" },
  { id: "glow", label: "Glow", hint: "Lights itself up in its own colour", roughness: 0.5, metalness: 0, opacity: 1, color: null, emissive: "self" },
];

export interface PaletteColor {
  name: string;
  hex: string;
}

export const PALETTE: PaletteColor[] = [
  { name: "Chalk", hex: "#f2efe9" },
  { name: "Sand", hex: "#d9c7a3" },
  { name: "Terracotta", hex: "#c9653b" },
  { name: "Tomato", hex: "#e0483e" },
  { name: "Coral", hex: "#f07c6a" },
  { name: "Marigold", hex: "#f2b33d" },
  { name: "Lemon", hex: "#f4dc5b" },
  { name: "Leaf", hex: "#6baf4b" },
  { name: "Moss", hex: "#3f6b3a" },
  { name: "Teal", hex: "#2e9c97" },
  { name: "Sky", hex: "#5ba8e0" },
  { name: "Ocean", hex: "#2d5da8" },
  { name: "Plum", hex: "#7b4b94" },
  { name: "Blush", hex: "#e9a8b8" },
  { name: "Graphite", hex: "#4a4e55" },
  { name: "Ink", hex: "#1e2126" },
];

const NEAR = 0.02;

/** The fields a preset writes, given the material's current colour. */
export function presetFields(
  preset: MaterialPreset,
  current: Pick<MaterialSpec, "color">,
): Partial<MaterialSpec> {
  const color = preset.color ?? current.color;
  return {
    color,
    roughness: preset.roughness,
    metalness: preset.metalness,
    opacity: preset.opacity,
    emissive: preset.emissive === "self" ? color : "#000000",
  };
}

/** The preset a material currently matches, or null (a custom mix). */
export function matchingPreset(material: MaterialSpec): MaterialPreset | null {
  const glowing = material.emissive.toLowerCase() !== "#000000";
  for (const preset of MATERIAL_PRESETS) {
    if (Math.abs(material.roughness - preset.roughness) > NEAR) continue;
    if (Math.abs(material.metalness - preset.metalness) > NEAR) continue;
    if (Math.abs(material.opacity - preset.opacity) > NEAR) continue;
    if (preset.color && preset.color.toLowerCase() !== material.color.toLowerCase()) continue;
    if ((preset.emissive === "self") !== glowing) continue;
    return preset;
  }
  return null;
}

/** The palette name for a hex, or null. */
export function paletteName(hex: string): string | null {
  const lower = hex.toLowerCase();
  return PALETTE.find((c) => c.hex === lower)?.name ?? null;
}
