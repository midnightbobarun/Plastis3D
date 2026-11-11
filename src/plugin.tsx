import { initLearning } from "./state/learning";
import { CAPTURE_REQUESTED_EVENT, startCaptureService } from "./viewport/capture";
import { ViewSettings } from "./settings/ViewSettings";
import { SceneCard } from "./cards/SceneCard";
import type { TranscriptDirectiveProps } from "@hermes/plugin-sdk";
import { sharedTemplateCache } from "./scene/cache";
// src/plugin.tsx — Plastis3D desktop half (Stage 5, PR5).
//
// register() binds the shared scene-data layer, resolves the sourceKey,
// and registers:
//   - BOTH panes in PANES_AREA (unchanged from PR4): viewport right /
//     420px, scenes left / 220px. Both ship together — the SDK disables
//     a plugin when its only contributed pane closes, and a route does
//     not count.
//   - the editor route /plastis3d in ROUTES_AREA,
//   - the "Plastis3D" sidebar row in SIDEBAR_NAV_AREA,
//   - the status chip in STATUSBAR_AREAS.right (order 120),
//   - four palette rows in PALETTE_AREA (Open Editor, New Scene, Import
//     Model, Export GLB).
// It also subscribes ONCE to plugin.plastis3d.editor.focus: while a
// gizmo drag is down the focus is deferred (editorFocus.ts — the gizmo
// manager flushes it on drag end); otherwise it sets the source-scoped
// scene, navigates to /plastis3d?scene=<id> unless already showing that
// id, and invalidates the scene data.
//
// Rules honored here:
//   - Runtime imports are only @hermes/plugin-sdk, react, react/jsx-runtime
//     (three.js is bundled). No dynamic import(), no eval, no new Function.
//   - No KEYBINDS_AREA, no config_schema, no TOOL_MEDIA_RENDERER_AREA.
import {
  TRANSCRIPT_DIRECTIVE_AREA,
  PALETTE_AREA,
  PANES_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  captureGatewayFileDownload,
  gatewayActivationEpoch,
  host,
} from "@hermes/plugin-sdk";
import type { HermesPlugin, PluginContext } from "@hermes/plugin-sdk";
import { ViewportPane } from "./viewport/ViewportPane";
import { ScenesPane } from "./editor/ScenesPane";
import { PaneFrame } from "./ui/PaneFrame";
import { Editor } from "./editor/Editor";
import { StatusChip } from "./editor/StatusChip";
import { releaseAllLeases } from "./scene/leases";
import type { RestFn } from "./api";
import {
  disposeSceneData,
  initSceneData,
  invalidateSceneData,
  resolveSourceKey,
} from "./state/sceneQuery";
import { getActiveSceneId, setEditorSceneId } from "./state/activeScene";
import { setPendingDialog } from "./editor/pendingDialog";
import { isGizmoDragging, isReparentDragging } from "./state/dragLock";
import {
  deferEditorFocus,
  registerFocusFlusher,
} from "./state/editorFocus";
import type { EditorFocusPayload } from "./state/editorFocus";
import { runExportClick } from "./io/exportFlow";
import { COPY } from "./copy";
import { injectStyles } from "./ui/styles";
import { initViewPrefs } from "./state/viewPrefs";

/** The agent tool's "open in Desktop" event (tools.py open_in_desktop). */
const EDITOR_FOCUS_EVENT = "plugin.plastis3d.editor.focus";

/** Last scene id a focus event navigated to — skip re-navigating to it. */
let lastFocusedSceneId: string | null = null;

function register(ctx: PluginContext) {
  // Bind the shared scene-data layer (single broadcast subscription,
  // 4 s visibility-gated poll) before any pane renders.
  initSceneData(ctx);
  ctx.registerSettingsPage?.({ id: "view", title: "Plastis3D", render: () => <ViewSettings /> });
  const sourceKey = resolveSourceKey();
  // PR32: the one namespaced stylesheet (removed on dispose, like the
  // host's Radio plugin) and the shared view preferences.
  const removeStyles = injectStyles();
  ctx.onDispose(removeStyles);
  initViewPrefs(ctx.storage ?? null);
  initLearning(ctx.storage ?? null);
  const rest = ctx.rest as unknown as RestFn;

  // Plugin-wide backstop: release every renderer lease and stop every
  // poll timer. Component unmounts already do their own cleanup; this
  // only covers a dispose with surfaces still mounted.
  ctx.onDispose(() => {
    releaseAllLeases();
    sharedTemplateCache.clear();
    disposeSceneData();
  });

  // --- capture.requested (PR22) ----------------------------------------------
  // The agent's screenshot tool asks an open scene view for a PNG. The
  // service claims, draws and posts; the broadcast only hurries it along.
  const captureService = startCaptureService(rest);
  ctx.onDispose(captureService.stop);
  ctx.onEvent(CAPTURE_REQUESTED_EVENT, () => captureService.check());

  // --- editor.focus ---------------------------------------------------------
  // One handler, shared by the live subscription and the deferred-focus
  // flusher (the gizmo manager runs it on drag end).
  function handleFocus(payload: EditorFocusPayload): void {
    setEditorSceneId(payload.sourceKey, payload.sceneId);
    if (lastFocusedSceneId !== payload.sceneId) {
      lastFocusedSceneId = payload.sceneId;
      host.navigate(`/plastis3d?scene=${payload.sceneId}`);
    }
    invalidateSceneData(payload.sourceKey, payload.sceneId);
  }
  registerFocusFlusher(handleFocus);

  ctx.onEvent(EDITOR_FOCUS_EVENT, (event: unknown) => {
    const frame =
      event && typeof event === "object" && "payload" in event
        ? (event as { payload?: unknown }).payload
        : event;
    const sceneId =
      frame && typeof frame === "object"
        ? (frame as { scene?: unknown }).scene
        : undefined;
    if (typeof sceneId !== "string" || !sceneId) return;
    const payload: EditorFocusPayload = { sceneId, sourceKey };
    if (isGizmoDragging() || isReparentDragging()) {
      // The pointer-up POST goes out first; the drag manager flushes
      // this after the drag settles.
      deferEditorFocus(payload);
      return;
    }
    handleFocus(payload);
  });

  ctx.register({ id: "scene-card", area: TRANSCRIPT_DIRECTIVE_AREA, data: { name: "plastis3d", render: (props: TranscriptDirectiveProps) => <SceneCard {...props} ctx={ctx} sourceKey={sourceKey} /> } });

  // --- panes (PR4, unchanged) -------------------------------------------------
  ctx.register({
    id: "viewport",
    area: PANES_AREA,
    title: "Plastis3D",
    data: { placement: "right", dock: { pane: "workspace", pos: "right" }, width: "360px" },
    render: () => <PaneFrame><ViewportPane ctx={ctx} sourceKey={sourceKey} /></PaneFrame>,
  });
  ctx.register({
    id: "scenes",
    area: PANES_AREA,
    title: "Scenes",
    data: { placement: "left", dock: { pane: "workspace", pos: "left" }, width: "220px" },
    render: () => <PaneFrame><ScenesPane ctx={ctx} sourceKey={sourceKey} /></PaneFrame>,
  });

  // --- editor route -------------------------------------------------------------
  ctx.register({
    id: "editor",
    area: ROUTES_AREA,
    title: "Plastis3D",
    data: { path: "/plastis3d" },
    render: () => <Editor ctx={ctx} sourceKey={sourceKey} />,
  });

  // --- sidebar nav ----------------------------------------------------------------
  ctx.register({
    id: "nav",
    area: SIDEBAR_NAV_AREA,
    data: { path: "/plastis3d", label: "Plastis3D", codicon: "project" },
  });

  // --- status chip ------------------------------------------------------------------
  ctx.register({
    id: "chip",
    area: STATUSBAR_AREAS.right,
    order: 120,
    render: () => <StatusChip sourceKey={sourceKey} />,
  });

  // --- palette -------------------------------------------------------------------------
  const paletteRow = (
    id: string,
    label: string,
    keywords: string[],
    run: () => void,
  ): void => {
    ctx.register({
      id,
      area: PALETTE_AREA,
      data: { id, label, keywords, run },
    });
  };

  paletteRow(
    "open-editor",
    "Plastis3D: Open editor",
    ["3d", "scene", "gltf", "glb"],
    () => {
      const active = getActiveSceneId(sourceKey);
      host.navigate(active ? `/plastis3d?scene=${active}` : "/plastis3d");
    },
  );
  paletteRow("sample-scene", "Plastis3D: Try a sample scene", ["3d", "sample"], () => {
    setPendingDialog({ kind: "samples", sourceKey, epoch: gatewayActivationEpoch(), invoker: null });
    host.navigate("/plastis3d");
  });
  paletteRow("new-scene", "Plastis3D: New scene", ["3d", "scene"], () => {
    setPendingDialog({
      kind: "new",
      sourceKey,
      epoch: gatewayActivationEpoch(),
      // 0-C: the palette has no invoking control in the editor — the
      // close falls back to the editor root.
      invoker: null,
    });
    host.navigate("/plastis3d");
  });
  paletteRow(
    "import-model",
    "Plastis3D: Import model…",
    ["3d", "glb", "gltf"],
    () => {
      const active = getActiveSceneId(sourceKey);
      if (!active) {
        host.notify({ kind: "info", message: COPY.createFirst });
        return;
      }
      setPendingDialog({
        kind: "import",
        sceneId: active,
        sourceKey,
        epoch: gatewayActivationEpoch(),
        // 0-C: the palette has no invoking control in the editor — the
        // close falls back to the editor root.
        invoker: null,
      });
      host.navigate(`/plastis3d?scene=${active}`);
    },
  );
  paletteRow(
    "export-glb",
    "Plastis3D: Save as GLB…",
    ["3d", "glb", "export", "save"],
    () => {
      const active = getActiveSceneId(sourceKey);
      if (!active) {
        host.notify({ kind: "info", message: COPY.createFirst });
        return;
      }
      // No button to relabel here, so the two-click fallback's second
      // half is the info toast with the backend path (ui-design §export).
      void runExportClick(rest, active, {
        capture: () => captureGatewayFileDownload(),
        notify: (kind, message) => host.notify({ kind, message }),
      }).then((result) => {
        if (result.ok && !result.saved) {
          host.notify({
            kind: "info",
            message: `Exported. Hermes saved it at ${result.pending.path}.`,
          });
        }
      });
    },
  );
}

const plugin: HermesPlugin = {
  id: "plastis3d",
  name: "Plastis3D",
  // Both halves default off (standalone-editor.md decision 15).
  defaultEnabled: false,
  register,
};

export default plugin;
