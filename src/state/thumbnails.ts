// src/state/thumbnails.ts — scene thumbnails for the picker and the Scenes pane (PR14).
//
// The editor posts a small PNG after an edit settles (src/editor/useThumbnailUploader.ts). Surfaces
// show it in place of the letter tile. A fetched thumbnail is cached by source, scene and revision, so
// each is read once per revision. A thumbnail is a convenience: any failure falls back to the letter tile.
import { useEffect, useState } from "react";
import { getThumbnail } from "../api";
import type { RestFn } from "../api";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const MAX_CACHED = 64;

const keyOf = (sourceKey: string, sceneId: string, revision: number): string => `${sourceKey}\n${sceneId}\n${revision}`;

export function thumbnailUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

/** Fetch (once per revision) a scene's thumbnail as a data URL, or null. */
export function loadThumbnail(rest: RestFn, sourceKey: string, sceneId: string, revision: number): Promise<string | null> {
  const key = keyOf(sourceKey, sceneId, revision);
  if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = getThumbnail(rest, sceneId)
    .then((found) => (found ? thumbnailUrl(found.png) : null))
    .catch(() => null)
    .then((url) => {
      cache.set(key, url);
      if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
      inflight.delete(key);
      return url;
    });
  inflight.set(key, request);
  return request;
}

/** The thumbnail for a scene row, or null while loading / when it has none. */
export function useThumbnail(rest: RestFn, sourceKey: string, sceneId: string, revision: number | null | undefined): string | null {
  const key = revision ? keyOf(sourceKey, sceneId, revision) : "";
  const [url, setUrl] = useState<string | null>(() => (key ? (cache.get(key) ?? null) : null));
  useEffect(() => {
    if (!revision) { setUrl(null); return undefined; }
    let live = true;
    void loadThumbnail(rest, sourceKey, sceneId, revision).then((next) => { if (live) setUrl(next); });
    return () => { live = false; };
  }, [rest, sourceKey, sceneId, revision]);
  return url;
}

/** Test hook: forget every cached thumbnail. */
export function clearThumbnailCache(): void {
  cache.clear();
  inflight.clear();
}

/** The scenes whose name contains the query, case-insensitively. An empty query keeps them all. */
export function filterScenes<T extends { name: string }>(scenes: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? scenes.filter((scene) => scene.name.toLowerCase().includes(needle)) : [...scenes];
}
