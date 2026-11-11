// src/editor/EditorSidePanel.tsx — the pane's face while the editor is open.
//
// The editor route owns the 3D view and its tools. This panel, docked beside
// it, carries the Scene outline and the Properties inspector for the same
// scene, driven by the shared selection and gizmo-mode stores
// (state/editorSession.ts). Outline on top, properties below, each scrolls.
import type { PluginContext } from "@hermes/plugin-sdk";
import type { RestFn } from "../api";
import { Icon } from "../ui/icons";
import { useEditorPanels, sharedGizmoMode, sharedSelection } from "../state/editorSession";
import { Inspector } from "./Inspector";
import { Outliner } from "./Outliner";
import { useModelDrop } from "./useModelDrop";

export function EditorSidePanel({ ctx }: { ctx: PluginContext }) {
  const panels = useEditorPanels();
  const modelDrop = useModelDrop(ctx.rest as unknown as RestFn, panels?.sourceKey ?? "");
  if (!panels) {
    return (
      <div className="p3d-root p3d-pane-standby" role="status">
        <Icon name="model" size={20} />
        <p>Open a scene in the editor to see its outline and properties here.</p>
      </div>
    );
  }
  const rest = ctx.rest as unknown as RestFn;
  const selection = sharedSelection();
  const gizmoMode = sharedGizmoMode();
  return (
    <div className="p3d-root p3d-sidepanel" data-plastis-root="sidepanel" tabIndex={-1} onKeyDown={(e) => panels.onKeyDown?.(e.nativeEvent)} {...modelDrop.handlers}>
      {modelDrop.overlay}
      <section className="p3d-sidepanel-outline" aria-label="Scene outline">
        <Outliner
          pulseIds={panels.pulseIds}
          rest={rest}
          scene={panels.scene}
          selection={selection}
          gizmoMode={gizmoMode}
          sourceKey={panels.sourceKey}
        />
      </section>
      <section className="p3d-sidepanel-props" aria-label="Properties">
        <Inspector
          rest={rest}
          scene={panels.scene}
          selection={selection}
          stats={panels.stats}
          sourceKey={panels.sourceKey}
          files={ctx.files ?? null}
          gizmoMode={gizmoMode}
        />
      </section>
    </div>
  );
}
