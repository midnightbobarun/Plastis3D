// src/viewport/drawCapOverlay.ts — the draw-cap overlay text selector (G-13).
//
// Pure function, no DOM / SDK / three: Vitest tests it directly. The
// five not-drawn cases get distinct overlay states — over-cap,
// asset-too-large (a 413 from the byte route), not-triangles (tris
// null), not-drawable (drawable false with a triangle count), and
// unavailable (any other fetch/parse failure) — each with its
// specified, reassuring sentence and the right numbers. Plain numbers
// throughout (N-02): no toLocaleString() grouping anywhere in the
// overlay.
//
// The 413 body NEVER carries stats (verifiable in-repo:
// dashboard/plugin_api.py builds ASSET_TOO_LARGE with only code +
// message, and PlastisError.to_dict() emits only {ok, code, message}
// plus optional path / currentRevision). The UI doc's Q-REMOTE
// condition (:1037) — "a 413 is the bounds overlay only when it is an
// asset GET whose body includes `stats`" — can never be satisfied by
// this gateway, so the spec's stored stats (stats.bounds, stats.tris,
// the same numbers the view already has) are always the source of the
// overlay's figures, not a conditional branch. If a future gateway
// ever adds `stats` to the 413 body, that is a new decision, not a
// branch in this fix (see D-IMPL-20).

import { COPY } from "../copy";

/** The five not-drawn reasons the overlay distinguishes (G-13):
 * over-cap, asset-too-large (a 413 from the byte route),
 * not-triangles (tris null), not-drawable (drawable false with a
 * triangle count), and unavailable (any other fetch/parse failure). */
export type DrawCapReason =
  | "over-cap"
  | "asset-too-large"
  | "not-triangles"
  | "not-drawable"
  | "unavailable";

export interface DrawCapOverlayInfo {
  reason: DrawCapReason;
  /** Spec stats.tris (null when the asset has no triangle count). */
  tris: number | null;
  /** Spec asset.bytes (null when unknown). */
  bytes: number | null;
  /** Spec stats.ignored entries (e.g. "mesh 0 primitive 1: mode 1 (LINES)…"). */
  ignored?: string[];
}

export interface DrawCapOverlayText {
  title: string;
  /** Second line, or null when the case has none. */
  detail: string | null;
}

/**
 * The overlay's sentences for one not-drawn model. Over-cap,
 * asset-too-large, and not-drawable with both figures known share the
 * tooLarge title; their second line shows
 * the spec's stored figures ("{tris} triangles · {MB} MB. The scene
 * is saved.", MB = bytes / 1_048_576, one decimal) only when both
 * numbers are known. Tris null is storedNotDrawn, plus the
 * notTriangles second line when `ignored` mentions a mode (the
 * import path lists non-TRIANGLES primitives there as "mode N
 * (NAME) is not TRIANGLES; skipped"). Anything else that could not
 * be fetched is storedNotDrawn with no second line.
 */
export function drawCapOverlayText(
  info: DrawCapOverlayInfo,
): DrawCapOverlayText {
  switch (info.reason) {
    case "over-cap":
    case "asset-too-large":
      return {
        title: COPY.tooLarge,
        detail:
          info.tris !== null && info.bytes !== null
            ? `${info.tris} triangles · ${(info.bytes / 1_048_576).toFixed(1)} MB. The scene is saved.`
            : null,
      };
    case "not-triangles":
      return {
        title: COPY.storedNotDrawn,
        detail: (info.ignored ?? []).some((entry) => /mode/i.test(entry))
          ? COPY.notTriangles
          : null,
      };
    case "not-drawable":
      // The import gate sets drawable false only for non-TRIANGLES (tris
      // null → not-triangles first), tris over the cap (over-cap first),
      // or bytes over the ~12 MiB byte-route limit. So not-drawable with
      // a numeric tris is the byte case, and it really is too large
      // (ui-design §Draw cap; pre-PR9 completion plan, audit A-1).
      if (info.tris !== null && info.bytes !== null) {
        return {
          title: COPY.tooLarge,
          detail: `${info.tris} triangles · ${(info.bytes / 1_048_576).toFixed(1)} MB. The scene is saved.`,
        };
      }
      return { title: COPY.storedNotDrawn, detail: null };
    case "unavailable":
      return { title: COPY.storedNotDrawn, detail: null };
  }
}
