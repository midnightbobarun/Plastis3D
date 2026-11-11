// src/ui/SceneTile.tsx — a scene's tile: its thumbnail when it has one, else the letter tile (PR14).
import type { CSSProperties } from "react";
import type { RestFn } from "../api";
import { useThumbnail } from "../state/thumbnails";
import { sceneHue } from "./format";

export function SceneTile({
  rest, sourceKey, sceneId, name, revision, size, radius, font,
}: {
  rest: RestFn; sourceKey: string; sceneId: string; name: string;
  /** The revision the stored thumbnail shows (from the scene list), or null. */
  revision: number | null | undefined;
  size: number; radius: number; font: number;
}) {
  const url = useThumbnail(rest, sourceKey, sceneId, revision);
  const style = { flex: `0 0 ${size}px`, width: size, height: size, borderRadius: radius, fontSize: font, ["--p3d-hue" as string]: sceneHue(sceneId) } as CSSProperties;
  if (url) {
    return <img className="p3d-scene-tile" data-testid="scene-thumbnail" alt="" aria-hidden="true" src={url} style={{ ...style, objectFit: "cover", background: "var(--p3d-surface-2, #23262d)" }} />;
  }
  return <span className="p3d-scene-tile" aria-hidden="true" style={style}>{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}
