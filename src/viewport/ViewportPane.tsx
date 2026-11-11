// src/viewport/ViewportPane.tsx — the Viewport pane (Stage 4, PR4 §4.2;
// PR5 header/toolbar/stats).
//
// Resolves the active scene id (the Scenes pane's selection, shared
// through src/state/activeScene.ts), subscribes via useScene, and
// renders the Viewport plus loading/empty/error states, a header, a
// toolbar row, and a status line. The pane itself holds no renderer;
// Viewport.tsx owns the WebGL lifecycle. The pane stays usable when
// WebGL2 is unavailable: that failure is contained inside Viewport.tsx
// as an ErrorState.
//
// Layout (PR32, UI/UX redesign §6.2): a 40px header (scene select +
// "Editor" button), then the studio stage filling the pane with glass
// overlays — a compact tool dock (Q/W/E/R, Frame, Reset view) top-left
// and a footer (name · rev · tris · verts · nodes, the selection badge
// that opens the editor, Grid, Wireframe, View menu). No Add in the
// pane: the editor and the palette own creation (§6.2).
//
// Keys (G-01, ui-design Key Decision 5 / §Focus): the pane root is a
// `div tabIndex={-1} data-plastis-root="pane"`, focused when its canvas is
// clicked, and the ONE shared handler (editor/keybindings.ts) is attached
// to it with ctx.addEventListener — never window, never KEYBINDS_AREA.
// Keys apply to the root that received them, so the pane and the editor
// route never both act on one key press. The callbacks are the editor's
// own sceneActions / api calls; Delete opens the same ConfirmDialog.
//
// The pane creates ONE gizmoMode store + ONE selection store per mount
// (useMemo) and passes them to <Viewport> and the toolbar row. There is
// no shared Toolbar.tsx in 0.1.0: each surface renders its own toolbar
// row from the gizmoMode store (PR5 decision 7).
//
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ErrorState,
  gatewayActivationEpoch,
  GlyphSpinner,
  host,
  Skeleton,
  StatusDot,
  useValue,
} from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import { envelopeToScene, redoScene, undoScene } from "../api";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";
import { ViewMenu } from "../editor/Editor";
import { ConfirmDialog } from "../editor/ConfirmDialog";
import { restoreFocusDeferred } from "../editor/focusReturn";
import { createEditorKeyHandler } from "../editor/keybindings";
import { LiveRegion } from "../editor/LiveRegion";
import { NoSceneEmptyState } from "../editor/NoSceneEmptyState";
import { setPendingDialog } from "../editor/pendingDialog";
import {
  createUntitledScene,
  deleteNodes,
  duplicateNodes,
  subtreeIds,
  toastApiError,
  toggleNodesVisibility,
} from "../editor/sceneActions";
import type { NodeSpec } from "../types";
import { createGizmoModeStore, useGizmoMode } from "../gizmos/gizmoMode";
import type { GizmoMode } from "../gizmos/gizmoMode";
import {
  setAvailableScenes,
  setPaneSceneId,
  usePaneSceneId,
} from "../state/activeScene";
import { announceLoadingScene } from "../state/announcer";
import { useScene, useSceneList } from "../state/sceneQuery";
import { createSelectionStore, useSelection } from "../state/selection";
import { Viewport } from "./Viewport";
import { useEditorOpen } from "../state/editorOpen";
import { EditorSidePanel } from "../editor/EditorSidePanel";
import { DockShell } from "../ui/DockShell";
import { useModelDrop } from "../editor/useModelDrop";

export interface ViewportPaneProps {
  ctx: PluginContext;
  sourceKey: string;
}










const MODE_LABELS: Record<GizmoMode, string> = {
  select: "Select",
  translate: "Move",
  rotate: "Rotate",
  scale: "Scale",
};

const MODE_KEYS: Record<GizmoMode, string> = {
  select: "Q",
  translate: "W",
  rotate: "E",
  scale: "R",
};

/**
 * The pane stands down while the full editor is open: one editor view, not
 * two. The inner pane (and its WebGL lease) unmounts and comes back with the
 * same scene when the editor closes.
 */
export function ViewportPane(props: ViewportPaneProps) {
  const editorOpen = useEditorOpen();
  if (editorOpen) return <EditorSidePanel ctx={props.ctx} />;
  return <ViewportPaneInner {...props} />;
}

function ViewportPaneInner({ ctx, sourceKey }: ViewportPaneProps) {
  const modelDrop = useModelDrop(ctx.rest as unknown as RestFn, sourceKey);
  const visible = useValue(host.paneVisibility("plastis3d:viewport"));
  const list = useSceneList(sourceKey, { eligible: visible });

  // One gizmo-mode store + one selection store per mount.
  const selection = useMemo(() => createSelectionStore(), []);
  const gizmoMode = useMemo(() => createGizmoModeStore(), []);
  const selectionSnap = useSelection(selection);
  const modeSnap = useGizmoMode(gizmoMode);

  const [committing, setCommitting] = useState(false);

  const [paneWidth, setPaneWidth] = useState(0);
  // A callback ref, not a []-deps effect over a useRef: the pane's
  // early-return branches (loading / error / empty) render a div
  // WITHOUT the ref, so on mount rootRef.current is null and a
  // []-deps effect would return before ever attaching the observer —
  // leaving paneWidth stuck at 0 (wide false, narrowToolbar true)
  // once the scene branch mounts. The callback ref attaches when the
  // scene branch's div mounts and disconnects when it unmounts.
  const rootRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return undefined;
    const update = () => setPaneWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // G-01: the root element, kept in state so the keydown effect below
  // re-attaches when the scene branch's root mounts (the early-return
  // branches render no root). Merged with the ResizeObserver ref.
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const paneRootRef = useCallback(
    (el: HTMLDivElement | null) => {
      setRootEl(el);
      const cleanup = rootRef(el);
      return () => {
        cleanup?.();
        setRootEl(null);
      };
    },
    [rootRef],
  );
  // The view gizmo shows from 360 px (§6.2); the Viewport measures
  // its own stage width, so the pane width is kept only for telemetry.
  void paneWidth;

  useEffect(() => {
    if (list.data) {
      setAvailableScenes(
        sourceKey,
        list.data.map((s) => s.id),
      );
    }
  }, [sourceKey, list.data]);

  const activeId = usePaneSceneId(sourceKey);
  const scene = useScene(sourceKey, activeId, {
    eligible: visible && activeId !== null,
  });

  const sceneName = useMemo(() => {
    if (!activeId) return "";
    const row = list.data?.find((s) => s.id === activeId);
    return row ? row.name : activeId;
  }, [activeId, list.data]);

  // A stable SceneSpec: envelopeToScene allocates a new object, so
  // memoize on the envelope — otherwise Viewport would rebuild the
  // Three.js scene on every pane render.
  const sceneSpec = useMemo(
    () => (scene.data ? envelopeToScene(scene.data, sceneName) : null),
    [scene.data, sceneName],
  );

  const rest = ctx.rest as unknown as RestFn;

  // --- keys (G-01) -------------------------------------------------------------
  // Refs, so the once-bound handler always reads the current scene and
  // the current undo/redo gates (the same pattern as Editor.tsx, N-11).
  const sceneRef = useRef<{
    id: string;
    revision: number;
    nodes: NodeSpec[];
  } | null>(null);
  sceneRef.current = scene.data
    ? {
        id: scene.data.scene.id,
        revision: scene.data.scene.revision,
        nodes: scene.data.nodes,
      }
    : null;
  const feedbackRef = useRef({ canUndo: false, canRedo: false });
  feedbackRef.current = {
    canUndo: scene.data?.feedback.canUndo ?? false,
    canRedo: scene.data?.feedback.canRedo ?? false,
  };
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmWasOpenRef = useRef(false);

  async function doUndo(): Promise<void> {
    const s = sceneRef.current;
    if (!s) return;
    try {
      await undoScene(rest, s.id, s.revision);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function doRedo(): Promise<void> {
    const s = sceneRef.current;
    if (!s) return;
    try {
      await redoScene(rest, s.id, s.revision);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function toggleSelectionVisibility(): Promise<void> {
    const s = sceneRef.current;
    const ids = selection.getSnapshot().ids;
    if (!s || ids.length === 0) return;
    try {
      const visibleById = new Map(
        s.nodes.map((n) => [n.id, n.visible] as const),
      );
      await toggleNodesVisibility(rest, s, ids, visibleById);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function duplicateSelection(): Promise<void> {
    const s = sceneRef.current;
    const ids = selection.getSnapshot().ids;
    if (!s || ids.length === 0) return;
    try {
      const before = new Set(s.nodes.map((n) => n.id));
      const envelope = await duplicateNodes(rest, s, ids);
      const created = envelope.nodes
        .map((n) => n.id)
        .filter((id) => !before.has(id));
      if (created.length > 0) selection.set(created);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function deleteSelection(): Promise<void> {
    setConfirmDelete(false);
    const s = sceneRef.current;
    const ids = selection.getSnapshot().ids;
    if (!s || ids.length === 0) return;
    try {
      const removed = new Set<string>();
      for (const id of ids) {
        for (const sub of subtreeIds(s.nodes, id)) removed.add(sub);
      }
      await deleteNodes(rest, s, s.nodes, ids);
      for (const id of removed) selection.remove(id);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  const keyHandler = useMemo(
    () =>
      createEditorKeyHandler({
        gizmoMode,
        selection,
        getScene: () => {
          const s = sceneRef.current;
          return s ? { id: s.id, revision: s.revision } : null;
        },
        canUndo: () => feedbackRef.current.canUndo,
        canRedo: () => feedbackRef.current.canRedo,
        onToggleVisibility: () => void toggleSelectionVisibility(),
        onDeleteRequest: () => {
          if (selection.getSnapshot().ids.length > 0) setConfirmDelete(true);
        },
        onDuplicate: () => void duplicateSelection(),
        onUndo: () => void doUndo(),
        onRedo: () => void doRedo(),
      }),
    // The callbacks close over refs + stable stores only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gizmoMode, selection],
  );

  useEffect(() => {
    if (!rootEl) return undefined;
    return ctx.addEventListener(
      rootEl,
      "keydown",
      keyHandler as unknown as EventListener,
    );
  }, [ctx, rootEl, keyHandler]);

  // Closing the delete confirm (Delete, Cancel, Escape) returns focus to
  // the pane root, one frame after the dialog unmounts (the editor's
  // fallback path; the key press has no invoking control).
  useEffect(() => {
    if (confirmDelete) {
      confirmWasOpenRef.current = true;
      return;
    }
    if (!confirmWasOpenRef.current) return;
    confirmWasOpenRef.current = false;
    restoreFocusDeferred(null, rootEl);
  }, [confirmDelete, rootEl]);

  // The pane opens dialogs through the editor: New via the pending
  // dialog + navigate (as the Scenes pane does); Import via
  // create-then-import (D-PLAN-04) — never a `createFirst` toast.
  function openNew(e: React.MouseEvent<HTMLButtonElement>): void {
    setPendingDialog({
      kind: "new",
      sourceKey,
      epoch: gatewayActivationEpoch(),
      invoker: e.currentTarget,
    });
    host.navigate("/plastis3d");
  }

  async function openImport(e: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    // 0-C: capture the invoker synchronously BEFORE the await — React
    // clears e.currentTarget once the handler's dispatch completes.
    const invoker = e.currentTarget;
    const id = await createUntitledScene(rest, sourceKey);
    if (!id) return;
    setPendingDialog({
      kind: "import",
      sceneId: id,
      sourceKey,
      epoch: gatewayActivationEpoch(),
      invoker,
    });
    host.navigate("/plastis3d");
  }

  // G-12: loading keeps the chrome mounted — the header, toolbar, and
  // stats line render through the load, with the host Skeleton in the
  // canvas area and "Loading…" on the stats line. The surface must not
  // pop in. Only the error and empty branches early-return (G-14 owns
  // the error branches). The root div below is always rendered now, so
  // the callback ref attaches on mount even while loading (D-IMPL-13's
  // attach problem cannot recur through these branches).
  const listLoading = list.status === "loading" && !list.data;
  // G-12: "loading" means a scene is on its way — never "there is no
  // active scene". With no scenes left the list is empty and the empty
  // state owns the surface; with a non-empty list but no activeId yet
  // (the list effect has not seeded `available`), the one-render gap
  // still reads as loading. An error record with no data is the error
  // branch's job, not a skeleton. `!sceneSpec` covers the fetch while
  // a scene record is resolving.
  const listHasScenes = (list.data?.length ?? 0) > 0;
  const sceneLoading =
    !listLoading &&
    listHasScenes &&
    !(scene.status === "error" && !scene.data) &&
    (activeId === null || !sceneSpec);
  const loading = listLoading || sceneLoading;

  // G-06/G-12: the scene GET in flight announces "Loading scene…"
  // (deduped per (source, scene) across surfaces); the revision
  // announcement follows when the scene arrives (sceneQuery).
  const sceneLoadingForAnnounce =
    activeId !== null && scene.status === "loading" && !scene.data;
  useEffect(() => {
    if (sceneLoadingForAnnounce && activeId !== null) {
      announceLoadingScene(sourceKey, activeId);
    }
  }, [sceneLoadingForAnnounce, activeId, sourceKey]);

  // G-14: a store failure is the host ErrorState (storeTitle /
  // storeBody), never plain text echoing the raw server message.
  // "Try again" refetches the scene list (errata Issue 5). The
  // description is storeRetry once a GET previously succeeded in this
  // session. The branch also fires when the list is exhausted (two
  // consecutive failed polls with last good data in hand).
  if ((list.status === "error" && !list.data) || list.storeExhausted) {
    return (
      <div className="p3d-root p3d-pane">
        <div className="p3d-message">
          <ErrorState
            title={COPY.storeTitle}
            description={
              COPY[list.storeSentence]
            }
          >
            <button type="button" onClick={() => list.refetch()}>
              Try again
            </button>
          </ErrorState>
        </div>
      </div>
    );
  }

  if (list.data && list.data.length === 0) {
    return (
      <div className="p3d-root p3d-pane" style={{ overflow: "auto" }}>
        <NoSceneEmptyState
          rest={rest}
          sourceKey={sourceKey}
          onNew={openNew}
          onImport={(e) => void openImport(e)}
          compact
        />
      </div>
    );
  }

  // G-14: the scene-load error branch gets the same treatment — the
  // host ErrorState, never the raw message. "Try again" refetches the
  // scene GET (errata Issue 5), not the list. The branch also fires
  // when the scene record is exhausted (two consecutive failed polls
  // with last good data in hand).
  if ((scene.status === "error" && !scene.data) || scene.storeExhausted) {
    return (
      <div className="p3d-root p3d-pane">
        <div className="p3d-message">
          <ErrorState
            title={COPY.storeTitle}
            description={
              COPY[scene.storeSentence]
            }
          >
            <button type="button" onClick={() => scene.refetch()}>
              Try again
            </button>
          </ErrorState>
        </div>
      </div>
    );
  }

  const stats = scene.data?.stats;
  const multiSelected = selectionSnap.ids.length > 1;
  // sceneSpec is null while loading (G-12): the badge reads nothing
  // until the scene arrives — guard every sceneSpec read below.
  const primaryNode =
    selectionSnap.primary && sceneSpec
      ? sceneSpec.nodes.find((n) => n.id === selectionSnap.primary)
      : undefined;
  const modeLabel = MODE_LABELS[modeSnap.mode];
  const deleteNames = selectionSnap.ids
    .map((id) => sceneSpec?.nodes.find((n) => n.id === id)?.name)
    .filter((n): n is string => typeof n === "string");
  // Hidden state (E-08): the mode label is DROPPED when hidden — the
  // badge reads "Hat · Hidden", not "Hat · Move · Hidden". Multi-select
  // shows "· Hidden" only when EVERY selected node is hidden.
  const allHidden =
    sceneSpec !== null &&
    selectionSnap.ids.length > 0 &&
    selectionSnap.ids.every(
      (id) =>
        sceneSpec.nodes.find((n) => n.id === id)?.visible === false,
    );
  const selectionBadge =
    sceneSpec === null || selectionSnap.ids.length === 0
      ? null
      : allHidden
        ? selectionSnap.ids.length === 1
          ? `${primaryNode?.name ?? selectionSnap.primary} · Hidden`
          : `${selectionSnap.ids.length} nodes · Hidden`
        : selectionSnap.ids.length === 1
          ? `${primaryNode?.name ?? selectionSnap.primary} · ${modeLabel}`
          : `${selectionSnap.ids.length} nodes · ${modeLabel}`;

  const MODE_ICONS: Record<GizmoMode, IconName> = {
    select: "select",
    translate: "move",
    rotate: "rotate",
    scale: "scale",
  };
  const modeButton = (mode: GizmoMode) => {
    const active = modeSnap.mode === mode;
    const disabled =
      multiSelected && (mode === "rotate" || mode === "scale");
    return (
      <button
        key={mode}
        type="button"
        className="p3d-iconbtn"
        aria-pressed={active}
        aria-label={`${MODE_LABELS[mode]} (${MODE_KEYS[mode]})`}
        title={`${MODE_LABELS[mode]} (${MODE_KEYS[mode]})`}
        disabled={disabled}
        onClick={() => gizmoMode.setMode(mode)}
      >
        <Icon name={MODE_ICONS[mode]} size={18} />
      </button>
    );
  };

  // The glass overlays over the stage (§6.2): a compact tool dock
  // (modes, Frame, Reset view) top-left, and a footer with the scene
  // stats, the selection badge, Grid / Wireframe and the View menu.
  const overlay = (
    <>
      <DockShell label="Sidebar 3D view tools" className="p3d-dock p3d-dock--compact p3d-glass" activeIcon={({ select: "select", translate: "move", rotate: "rotate", scale: "scale" } as const)[modeSnap.mode]}>
        {modeButton("select")}
        {modeButton("translate")}
        {modeButton("rotate")}
        {modeButton("scale")}
        <span className="p3d-sep-h" aria-hidden="true" />
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Frame (F)"
          title="Frame (F) — fit the selection in view"
          onClick={() => gizmoMode.requestFrame()}
        >
          <Icon name="frame" size={18} />
        </button>
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Reset view"
          title="Reset view"
          onClick={() => gizmoMode.requestResetView()}
        >
          <Icon name="home" size={18} />
        </button>
      </DockShell>
      <div className="p3d-pane-foot p3d-glass">
        <span className="p3d-grow p3d-num">
          {loading
            ? "Loading…"
            : `${sceneName} · rev ${scene.data?.scene.revision ?? "?"}${stats
              ? ` · ${String(stats.tris)} tris · ${String(stats.verts)} verts · ${stats.nodes} nodes`
              : ""}${scene.stale ? " · updating…" : ""}`}
        </span>
        {scene.storeNotAnswering && !loading && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <StatusDot tone="warn" />
            {COPY[scene.storeSentence]}
          </span>
        )}
        {committing && <GlyphSpinner ariaLabel="Saving" />}
        {selectionBadge && (
          <button
            type="button"
            className="p3d-badge"
            style={{ border: 0, cursor: "pointer", font: "inherit", fontSize: 11 }}
            title="Shift-click to add to selection"
            aria-label="Open in editor"
            onClick={() => host.navigate(`/plastis3d?scene=${activeId}`)}
          >
            {selectionBadge}
          </button>
        )}
        <button
          type="button"
          className="p3d-iconbtn p3d-iconbtn--sm"
          aria-pressed={modeSnap.grid}
          aria-label="Grid (G)"
          title="Grid (G)"
          onClick={() => gizmoMode.toggleGrid()}
        >
          <Icon name="grid" size={15} />
        </button>
        <button
          type="button"
          className="p3d-iconbtn p3d-iconbtn--sm"
          aria-pressed={modeSnap.wireframe}
          aria-label="Wireframe"
          title="Wireframe"
          onClick={() => gizmoMode.toggleWireframe()}
        >
          <Icon name="wireframe" size={15} />
        </button>
        <ViewMenu compact />
      </div>
    </>
  );

  return (
    <div
      ref={paneRootRef}
      data-plastis-root="pane"
      tabIndex={-1}
      className="p3d-root p3d-pane"
      {...modelDrop.handlers}
    >
      {modelDrop.overlay}
      <LiveRegion />
      <div className="p3d-pane-head">
        <select
          aria-label="Scene"
          className="p3d-select"
          value={activeId ?? ""}
          disabled={listLoading}
          onChange={(e) => setPaneSceneId(sourceKey, e.target.value)}
        >
          {(list.data ?? []).map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        {activeId !== null && (
          <button
            type="button"
            className="p3d-btn p3d-btn--sm"
            aria-label="Open editor"
            title="Open this scene in the full editor"
            onClick={() => host.navigate(`/plastis3d?scene=${activeId}`)}
          >
            <Icon name="expand" size={14} />
            Editor
          </button>
        )}
      </div>
      <div
        style={{ flex: "1 1 auto", minHeight: 160, position: "relative", display: "flex", flexDirection: "column" }}
        onClick={() => rootEl?.focus({ preventScroll: true })}
      >
        {loading || !sceneSpec ? (
          <div className="p3d-stage">
            <Skeleton
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5 }}
              aria-label="Loading scene"
            />
            {overlay}
          </div>
        ) : (
          <Viewport
            scene={sceneSpec}
            sourceKey={sourceKey}
            rest={rest}
            visible={visible}
            chrome="pane"
            selection={selection}
            gizmoMode={gizmoMode}
            onCommittingChange={setCommitting}
            overlay={overlay}
          />
        )}
      </div>
      {confirmDelete && deleteNames.length > 0 && (
        <ConfirmDialog
          title={
            deleteNames.length === 1
              ? `Delete “${deleteNames[0]}”?`
              : `Delete ${deleteNames.length} nodes?`
          }
          body={
            deleteNames.length === 1
              ? "This removes that node and anything parented under it."
              : "This removes those nodes and anything parented under them."
          }
          confirmLabel="Delete"
          onConfirm={() => void deleteSelection()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
