// src/editor/useModelDrop.tsx — drop a model file anywhere on the editor, its side panel or the pane.
//
// Electron navigates the window to a dropped file unless dragover and drop are cancelled, so every root that
// uses this hook always cancels them for file drags. A model (GLB, glTF, OBJ, STL or PLY) is handed to the
// Import dialog through the pending-dialog slot, which opens in the editor (navigating there from the pane).
// With no scene open the "Untitled" scene is created first, the same as the header's Import button.
import { useCallback, useState } from "react";
import type { DragEvent, ReactElement } from "react";
import { gatewayActivationEpoch, host } from "@hermes/plugin-sdk";
import type { RestFn } from "../api";
import { isImportableName } from "../io/importFlow";
import { getActiveSceneId } from "../state/activeScene";
import { setPendingDialog } from "./pendingDialog";
import { createUntitledScene } from "./sceneActions";

export const DROP_NOT_A_MODEL = "Drop a GLB, glTF, OBJ, STL or PLY file.";

function carriesFiles(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  return !!types && Array.from(types).includes("Files");
}

export interface ModelDrop {
  /** Spread on the root element. */
  handlers: {
    onDragEnter: (event: DragEvent) => void;
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
  /** Render inside the root (the root must be positioned). */
  overlay: ReactElement | null;
}

export function useModelDrop(rest: RestFn, sourceKey: string): ModelDrop {
  const [dragging, setDragging] = useState(false);

  const over = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }, []);

  const leave = useCallback((event: DragEvent) => {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    setDragging(false);
  }, []);

  const drop = useCallback(
    (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      if (!isImportableName(file.name)) {
        host.notify({ kind: "warning", message: DROP_NOT_A_MODEL });
        return;
      }
      void (async () => {
        let sceneId = getActiveSceneId(sourceKey);
        if (!sceneId) sceneId = await createUntitledScene(rest, sourceKey);
        if (!sceneId) return;
        setPendingDialog({
          kind: "import",
          sceneId,
          sourceKey,
          epoch: gatewayActivationEpoch(),
          invoker: null,
          file,
        });
        host.navigate(`/plastis3d?scene=${sceneId}`);
      })();
    },
    [rest, sourceKey],
  );

  return {
    handlers: { onDragEnter: over, onDragOver: over, onDragLeave: leave, onDrop: drop },
    overlay: dragging ? (
      <div className="p3d-drop-overlay" aria-hidden="true">
        Drop a model to import it
      </div>
    ) : null,
  };
}
