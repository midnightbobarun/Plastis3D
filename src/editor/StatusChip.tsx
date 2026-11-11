// src/editor/StatusChip.tsx — the status-bar chip (Stage 5, PR5).
//
// STATUSBAR_AREAS.right, order 120: the active scene name plus its
// triangle count — "Name · 1.2k tris" (840 tris under 1,000, one decimal
// plus k at or above 1,000), "Name" when the count is not a number, or
// "Plastis3D" when there is no active scene. Click navigates to the
// editor for that scene, or to /plastis3d when there is none. No other
// status items.

import { useEffect } from "react";
import { host } from "@hermes/plugin-sdk";
import { Button } from "@hermes/plugin-sdk";
import { setAvailableScenes, useActiveSceneId } from "../state/activeScene";
import { useScene, useSceneList } from "../state/sceneQuery";

export interface StatusChipProps {
  sourceKey: string;
}

/** 840 -> "840 tris"; 1234 -> "1.2k tris". */
export function formatTris(tris: number): string {
  if (tris < 1000) return `${tris} tris`;
  return `${(tris / 1000).toFixed(1)}k tris`;
}

export function StatusChip({ sourceKey }: StatusChipProps) {
  // The chip is always visible (status bar), so its records stay eligible.
  const list = useSceneList(sourceKey, { eligible: true });
  const activeId = useActiveSceneId(sourceKey);
  const scene = useScene(sourceKey, activeId, {
    eligible: activeId !== null,
  });

  useEffect(() => {
    if (list.data) {
      setAvailableScenes(
        sourceKey,
        list.data.map((s) => s.id),
      );
    }
  }, [sourceKey, list.data]);

  const name = activeId
    ? (list.data?.find((s) => s.id === activeId)?.name ?? activeId)
    : "Plastis3D";
  const tris = scene.data?.stats.tris;
  const label =
    activeId && typeof tris === "number"
      ? `${name} · ${formatTris(tris)}`
      : name;

  return (
    <Button
      variant="ghost"
      size="xs"
      title={activeId ? `Open ${name} in the editor` : "Open the Plastis3D editor"}
      onClick={() =>
        host.navigate(
          activeId ? `/plastis3d?scene=${activeId}` : "/plastis3d",
        )
      }
    >
      {label}
    </Button>
  );
}
