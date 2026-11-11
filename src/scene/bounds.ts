// src/scene/bounds.ts — stats-and-bounds placeholder for models the
// view will not parse (Stage 4, PR4 §4.1).
//
// Shown when the template cache returns null (over the draw cap,
// tris null, drawable false) or a typed failure (G-13: a 413
// ASSET_TOO_LARGE or any other fetch/parse failure): the asset is
// over the draw cap, tris is null, drawable is false, or the bytes
// could not be fetched/parsed (including the gateway's 501
// NOT_IMPLEMENTED for GET /assets until PR7 lands). The placeholder
// is a wireframe bounding box (LineSegments, Box3Helper-style)
// carrying the asset stats in userData so the pane can display them.
// It creates no geometry beyond the box edges and never calls
// GLTFLoader. The wire box uses the theme stroke colour
// (--ui-stroke-secondary) when the caller passes one (G-13).
//
// This module MUST NOT import @hermes/plugin-sdk.

import * as THREE from "three";
import { parseCssColor } from "../theme";
import type { AssetSpec, Bounds } from "../types";

export interface StatsPlaceholder {
  /** The group to add to the scene (contains the wireframe box). */
  group: THREE.Group;
  /** The box the wireframe was drawn from, in the asset's local space. */
  box: THREE.Box3;
}

/**
 * Build the placeholder for one asset. When stats.bounds is present
 * the box is drawn from it; otherwise a unit box centred on the origin
 * is used and the pane should say the bounds are unknown. The asset
 * id, sha256, and full stats are stored on group.userData for the pane
 * to display; nothing here renders text.
 *
 * `stroke` is the theme stroke colour (--ui-stroke-secondary, passed
 * in by the caller, which already reads it via readTheme() — no second
 * theme read here). When it is absent or unparseable the wire box
 * falls back to the old hardcoded grey, so a surface that has not
 * applied a theme yet still draws the box.
 */
export function createStatsPlaceholder(
  asset: AssetSpec,
  stroke?: string,
): StatsPlaceholder {
  const stats = asset.stats ?? {};
  const bounds: Bounds | undefined = stats.bounds ?? undefined;
  const box = new THREE.Box3();
  if (bounds) {
    box.min.set(bounds.min[0], bounds.min[1], bounds.min[2]);
    box.max.set(bounds.max[0], bounds.max[1], bounds.max[2]);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  } else {
    box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
  }
  let colour = 0x808080;
  // The caller passes a colour already resolved by resolveCssColor
  // (a #rrggbb). parseCssColor rather than THREE.Color: THREE.Color
  // warns and returns white for CSS Color 4 forms instead of throwing.
  const parsed = stroke ? parseCssColor(stroke) : null;
  if (parsed) {
    colour = new THREE.Color()
      .setRGB(parsed.r, parsed.g, parsed.b, THREE.SRGBColorSpace)
      .getHex();
  }
  const helper = new THREE.Box3Helper(box, colour);
  helper.userData.assetId = asset.id;
  const group = new THREE.Group();
  group.name = `bounds:${asset.id}`;
  group.userData.assetId = asset.id;
  group.userData.sha256 = asset.sha256;
  group.userData.stats = stats;
  group.userData.hasBounds = bounds !== undefined;
  group.add(helper);
  return { group, box };
}

/** Dispose a placeholder created by createStatsPlaceholder. */
export function disposeStatsPlaceholder(placeholder: StatsPlaceholder): void {
  placeholder.group.traverse((obj) => {
    const line = obj as THREE.LineSegments;
    if (line.geometry) line.geometry.dispose();
    const mat = (line as THREE.LineSegments).material;
    if (mat) {
      for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose();
    }
  });
}
