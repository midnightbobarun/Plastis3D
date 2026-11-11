// src/editor/useThumbnailUploader.ts — keep a scene's thumbnail fresh (PR14).
//
// After an edit settles (3 s with no new revision, no drag, no mesh edit session open) the editor
// draws a 192 px PNG of the clean view and posts it with the revision it shows. It posts only when the
// stored thumbnail is for a different revision, so opening a scene that is up to date posts nothing.
// A thumbnail is a convenience: every failure is silent.
import { useEffect, useRef } from "react";
import { putThumbnail } from "../api";
import type { RestFn } from "../api";
import { bytesToBase64 } from "../io/importFlow";
import { isGizmoDragging } from "../state/dragLock";
import type { SceneSpec, SceneSummary } from "../types";

export const THUMBNAIL_SETTLE_MS = 3000;

export function useThumbnailUploader(opts: {
  rest: RestFn;
  sourceKey: string;
  scene: SceneSpec | null;
  list: readonly SceneSummary[] | null;
  draw: { current: (() => Promise<Uint8Array>) | null };
  editing: boolean;
  /** The scene store is not answering: say nothing to it (an extra request would only add noise). */
  paused: boolean;
}): void {
  const { rest, scene, list, draw, editing, paused } = opts;
  const posted = useRef(new Set<string>());
  const stored = scene ? list?.find((s) => s.id === scene.id)?.thumbnailRevision : undefined;
  const id = scene?.id;
  const revision = scene?.revision;
  const hasNodes = (scene?.nodes.length ?? 0) > 0;
  useEffect(() => {
    if (!id || !revision || !hasNodes || editing || paused || list === null) return undefined;
    if (stored === revision || posted.current.has(`${id}:${revision}`)) return undefined;
    const timer = setTimeout(() => {
      if (isGizmoDragging() || !draw.current) return;
      posted.current.add(`${id}:${revision}`);
      void draw.current()
        .then((png) => putThumbnail(rest, id, revision, bytesToBase64(png))) // the list's own 4 s poll picks the new revision up
        .catch(() => posted.current.delete(`${id}:${revision}`));
    }, THUMBNAIL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [rest, id, revision, hasNodes, editing, paused, stored, list, draw]);
}
