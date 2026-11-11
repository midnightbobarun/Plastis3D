import { capturePrimitiveKey } from "../scene/primitiveClips";
import { updateNodeFields } from "./sceneActions";
import { ClipTransport } from "./ClipTransport";
import { SettleControl } from "./SettleControl";
import { createSettleStore } from "../state/settle";
import { useSyncExternalStore } from "react";
import { subscribeDragLock } from "../state/dragLock";
import { SAMPLE_NAMES } from "../samples";
import { buildSampleSnowman } from "./sceneActions";
import { LEARNING_COPY } from "../copy";
import { offerTip } from "../state/learning";
import { collapseAllowed, markEditorOpen } from "../state/editorOpen";
import { publishEditorPanels, sharedGizmoMode, sharedSelection } from "../state/editorSession";
import { isGizmoDragging } from "../state/dragLock";
import { patchScene } from "../api";
import { SnapControls } from "../ui/SnapControls";
import { AskChips, Checklist, ShortcutSheet, CoachTip, markLearning } from "../ui/Learning";
import { sceneDiff, isLocalWrite, revisionOrigin } from "../state/sceneDiff";
// src/editor/Editor.tsx — the editor route (/plastis3d, Stage 5, PR5).
//
// PR32 (UI/UX redesign §6.1): header 48px (scene title menu, save
// state, undo/redo, spacer, + Add, Import, Export GLB); three columns
// (Scene 240px, 200–280 | the studio stage, min 360px | Properties
// 300px, 260–340). The tool dock, stats, grid/wireframe and the View
// menu float over the stage on glass. Below 800px (or with the host
// `narrow` flag, G-15) the stage keeps the top and the two panels share
// a bottom sheet with Scene / Properties tabs; Import and Export move
// into a "More actions" menu. One gizmoMode store +
// one selection store per Editor mount, passed to the toolbar row and
// the Viewport (chrome="editor").
//
// The active scene comes from the active-scene store (E-12 split:
// editor selection when this route is mounted, else pane selection,
// else first in list order, per sourceKey). ?scene= only initializes
// that selection (setEditorSceneIdFromQuery) or, when it names an unknown
// id that was never valid, shows an ErrorState with the cardBadId words.
// A pending dialog is taken on mount and on focus/visibility/popstate
// events, and discarded when its sourceKey or epoch no longer matches.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ErrorState,
  GlyphSpinner,
  Input,
  Skeleton,
  Tip,
  captureGatewayFileDownload,
  gatewayActivationEpoch,
  host,
  useValue,
} from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import { createScene, envelopeToScene, redoScene, undoScene } from "../api";
import type { RestFn } from "../api";
import { ApiError } from "../api";
import { COPY, cardBadIdMessage } from "../copy";
import { useGizmoMode } from "../gizmos/gizmoMode";
import { createEditModeStore, editingStatus, useEditMode } from "../state/editMode";
import { EditToolbar } from "./EditMode";
import { useThumbnailUploader } from "./useThumbnailUploader";
import type { GizmoMode } from "../gizmos/gizmoMode";
import { useSelection } from "../state/selection";
import {
  clearEditorSceneId,
  getEditorSceneId,
  getPaneSceneId,
  setAvailableScenes,
  setEditorSceneId,
  setEditorSceneIdFromQuery,
  useActiveSceneId,
} from "../state/activeScene";
import { announce, announceLoadingScene } from "../state/announcer";
import {
  invalidateSceneData,
  useScene,
  useSceneList,
} from "../state/sceneQuery";
import { AddMenu } from "./AddMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { ImportDialog } from "../io/ImportDialog";
import { useModelDrop } from "./useModelDrop";
import { DockShell } from "../ui/DockShell";
import {
  friendlyGlbName,
  runExportClick,
  runSaveClick,
} from "../io/exportFlow";
import type { ExportPending } from "../io/exportFlow";
import { createEditorKeyHandler, resolveModeForSelection } from "./keybindings";
import { LiveRegion } from "./LiveRegion";
import { Outliner } from "./Outliner";
import { Inspector } from "./Inspector";
import { ScenePicker } from "./ScenePicker";
import {
  setPendingDialog,
  subscribePendingDialog,
  takePendingDialog,
} from "./pendingDialog";
import { restoreFocusDeferred } from "./focusReturn";
import {
  createUntitledScene,
  deleteNodes,
  duplicateNodes,
  subtreeIds,
  toastApiError,
  toggleNodesVisibility,
} from "./sceneActions";
import { NoSceneEmptyState } from "./NoSceneEmptyState";
import { querySceneId } from "./querySceneId";
import { Viewport } from "../viewport/Viewport";
import type { NodeSpec, SceneSpec } from "../types";
import { Icon } from "../ui/icons";
import { formatCount } from "../ui/format";
import type { IconName } from "../ui/icons";
import { MenuItem, Popover, Segmented } from "../ui/controls";
import { setViewPrefs, useViewPrefs } from "../state/viewPrefs";
import type { QualityPref, StageBackground } from "../state/viewPrefs";

export interface EditorProps {
  ctx: PluginContext;
  sourceKey: string;
}

type DialogState =
  | { kind: "new" | "samples" }
  | { kind: "import"; sceneId: string; file?: File }
  | null;

// F-UI-FIX-07: the real host puts `?scene=` inside the hash route
// (host.navigate writes `#/plastis3d?scene=<id>`); querySceneId reads
// the hash first, then the search string.
function readQuerySceneId(): string | null {
  if (typeof window === "undefined") return null;
  return querySceneId(window.location.hash, window.location.search);
}

export function Editor({ ctx, sourceKey }: EditorProps) {
  const draggingNow = useSyncExternalStore(subscribeDragLock, isGizmoDragging);
  const rest = ctx.rest as unknown as RestFn;
  const modelDrop = useModelDrop(rest, sourceKey);
  const gizmoMode = sharedGizmoMode();
  const editMode = useMemo(() => createEditModeStore(), []);
  const settleStore = useMemo(() => createSettleStore(), []);
  const editSnapshot = useEditMode(editMode);
  const thumbnailDraw = useRef<(() => Promise<Uint8Array>) | null>(null);
  const selection = sharedSelection();
  const gizmoSnapshot = useGizmoMode(gizmoMode);
  const selectionSnapshot = useSelection(selection);
  const [presence, setPresence] = useState<{ ids: string[]; count: number; tool: boolean; revisions: number } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  // Width-based stacking (the ResizeObserver effect below writes
  // `widthStacked`); the host `narrow` flag stacks too (G-15).
  // `stacked` is computed at render time from both — the flag must
  // NOT be read inside the []-deps effect (it would go stale).
  const [widthStacked, setWidthStacked] = useState(false);
  const hostNarrow = useValue(host.state.viewport).narrow;
  const stacked = hostNarrow || widthStacked;
  const [editorVisible, setEditorVisible] = useState(true);
  // Narrow layout (§6.1): the panels share a bottom sheet with two tabs.
  const [sheetTab, setSheetTab] = useState<"scene" | "properties">("properties");
  const [dialog, setDialog] = useState<DialogState>(null);
  const [newName, setNewName] = useState("Untitled");
  // 0-C (D-REPLAN-05): the dialog's invoking control, transferred
  // from the pending payload at take time (or set directly by a direct
  // open path). A ref, not state — it is not reactive and must survive
  // setDialog(null). Written ONLY by takePending() and the direct open
  // paths; read + cleared ONLY by the close effect below.
  const dialogInvokerRef = useRef<HTMLElement | null>(null);
  // 0-C: tracks whether a dialog/confirm was open, so the close
  // effect does not steal focus on mount (both start closed).
  useEffect(() => markEditorOpen(), []);
  const dialogWasOpenRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [exportPending, setExportPending] = useState<ExportPending | null>(null);
  const [exporting, setExporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // G-10: the Viewport reports a slow commit (PATCH > 1 s) through
  // onCommittingChange; the toolbar shows GlyphSpinner while it is true.
  const [committing, setCommitting] = useState(false);
  const [confirmDeleteSelection, setConfirmDeleteSelection] = useState(false);
  const [badQueryId, setBadQueryId] = useState<string | null>(null);
  const queryWasValid = useRef(false);

  const list = useSceneList(sourceKey, { eligible: editorVisible });
  const activeId = useActiveSceneId(sourceKey);
  const sceneQuery = useScene(sourceKey, activeId, {
    eligible: editorVisible && activeId !== null,
  });

  // The open scene for the key handlers + toolbar (ref so the once-bound
  // key handler always sees the current revision).
  const sceneRef = useRef<{
    id: string;
    revision: number;
    nodes: NodeSpec[];
  } | null>(null);
  sceneRef.current = sceneQuery.data
    ? {
        id: sceneQuery.data.scene.id,
        revision: sceneQuery.data.scene.revision,
        nodes: sceneQuery.data.nodes,
      }
    : null;

  // The undo/redo gates for the once-bound key handler (N-11): a ref
  // so the handler always reads the current envelope feedback. A
  // closure over sceneQuery.data?.feedback would go stale (the handler
  // is bound once via useMemo), and sceneRef.current.feedback does not
  // exist — sceneRef is {id, revision, nodes} only. The header buttons
  // read the same values (canUndo/canRedo below).
  const feedbackRef = useRef({ canUndo: false, canRedo: false });
  feedbackRef.current = {
    canUndo: sceneQuery.data?.feedback.canUndo ?? false,
    canRedo: sceneQuery.data?.feedback.canRedo ?? false,
  };

  const currentSceneId = sceneQuery.data?.scene.id;
  const currentSceneRevision = sceneQuery.data?.scene.revision;
  const currentSceneName = list.data?.find((entry) => entry.id === currentSceneId)?.name ?? currentSceneId;
  // A poll returns a fresh envelope even for the same revision. Retain the
  // view graph in that case so view-only playback is not reset every four seconds.
  const sceneSpec: SceneSpec | null = useMemo(() => {
    if (!sceneQuery.data) return null;
    return envelopeToScene(sceneQuery.data, currentSceneName ?? sceneQuery.data.scene.id);
    // The revision identifies the immutable scene contents for this source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey, currentSceneId, currentSceneRevision, currentSceneName]);
  useThumbnailUploader({ rest, sourceKey, scene: sceneSpec, list: list.data, draw: thumbnailDraw, editing: editSnapshot.active, paused: Boolean(sceneQuery.error) || sceneQuery.storeNotAnswering });

  useEffect(() => {
    if (list.data) {
      setAvailableScenes(
        sourceKey,
        list.data.map((s) => s.id),
      );
    }
  }, [sourceKey, list.data]);

  // --- mount-write (E-12, D-REPLAN-02) ----------------------------------------
  // Seed the editor selection on mount from the pane selection / first
  // in list. IDEMPOTENT — there is no boolean guard ref: the condition
  // IS the guard. Declared after setAvailableScenes (which populates
  // `available` from the same list.data, so getPaneSceneId reads a
  // populated map) and before the ?scene= sync (which owns the ?scene=
  // case). Re-runs whenever list.data changes (including every 4 s
  // list poll); once the editor selection is valid it is a cheap
  // no-op, and it self-heals a stale (deleted) selection.
  useEffect(() => {
    if (readQuerySceneId() !== null) return;
    if (!list.data) return;
    const ids = list.data.map((s) => s.id);
    const editor = getEditorSceneId(sourceKey);
    if (editor !== null && ids.includes(editor)) return;
    const value = getPaneSceneId(sourceKey);
    if (value !== null) setEditorSceneId(sourceKey, value);
  }, [sourceKey, list.data]);

  // --- unmount cleanup (E-12) --------------------------------------------------
  // Mount writes the editor selection; unmount clears it — that
  // lifecycle IS the foreground signal, so no separate foreground
  // detection is needed. A SEPARATE effect: the mount-write's cleanup
  // would run on every list poll and wipe the selection.
  useEffect(
    () => () => {
      clearEditorSceneId(sourceKey);
    },
    [sourceKey],
  );

  // --- ?scene= sync ----------------------------------------------------------
  // The store is the source of truth for what renders; the query only
  // initializes the explicit selection, or reports an unknown id.
  useEffect(() => {
    const syncQuery = () => {
      const id = readQuerySceneId();
      if (id === null) {
        setBadQueryId(null);
        return;
      }
      if (!list.data) return;
      const ids = list.data.map((s) => s.id);
      if (ids.includes(id)) {
        queryWasValid.current = true;
        setBadQueryId(null);
        setEditorSceneIdFromQuery(sourceKey, id, ids);
      } else if (queryWasValid.current) {
        // It was valid, then went away (deleted): fall back to the rule.
        setBadQueryId(null);
      } else {
        setBadQueryId(id);
      }
    };
    syncQuery();
    // hashchange: a same-route host.navigate (editor already mounted)
    // only changes the hash; listen for it explicitly (F-UI-FIX-07).
    window.addEventListener("hashchange", syncQuery);
    window.addEventListener("popstate", syncQuery);
    window.addEventListener("focus", syncQuery);
    document.addEventListener("visibilitychange", syncQuery);
    return () => {
      window.removeEventListener("hashchange", syncQuery);
      window.removeEventListener("popstate", syncQuery);
      window.removeEventListener("focus", syncQuery);
      document.removeEventListener("visibilitychange", syncQuery);
    };
  }, [sourceKey, list.data]);

  // --- pending dialog ----------------------------------------------------------
  function takePending(): void {
    const pending = takePendingDialog();
    if (!pending) return;
    if (
      pending.sourceKey !== sourceKey ||
      pending.epoch !== gatewayActivationEpoch()
    ) {
      return; // Stale: the source changed since the intent was set.
    }
    // 0-C (D-REPLAN-05): transfer the invoker into the ref — the
    // pending atom drops it at take, but the closer needs it after.
    dialogInvokerRef.current = pending.invoker;
    if (pending.kind === "samples") { setDialog({ kind: "samples" }); return; }
    if (pending.kind === "new") {
      setNewName("Untitled");
      setDialog({ kind: "new" });
    } else {
      setDialog({ kind: "import", sceneId: (pending as { sceneId: string }).sceneId, file: (pending as { file?: File }).file });
    }
  }

  useEffect(() => {
    takePending();
    // 0-A (E-01 fix): subscribe so a same-route navigate opens the
    // dialog while the editor is already mounted — navigate fires no
    // mount/focus/visibilitychange/popstate event. The listener reuses
    // takePending, so the staleness check and the invoker transfer run
    // on the notification path exactly as on the mount/focus paths.
    // One subscriber (the Editor) — no double-take race: the listener
    // takes the value, so a later focus event finds null.
    const unsubscribe = subscribePendingDialog(() => takePending());
    window.addEventListener("focus", takePending);
    document.addEventListener("visibilitychange", takePending);
    window.addEventListener("popstate", takePending);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", takePending);
      document.removeEventListener("visibilitychange", takePending);
      window.removeEventListener("popstate", takePending);
    };
    // takePending reads only stable setters + props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // --- dialog close: focus return (0-C, D-REPLAN-08) -------------------------
  // One effect per owner is the choke point: it catches every close
  // path (Create, Cancel, Escape) with no per-site change. When a
  // dialog or the delete-selection confirm closes, restore focus to
  // the invoking control (or the editor root fallback) one frame after
  // the unmount. Never focuses BODY.
  useEffect(() => {
    if (dialog !== null || confirmDeleteSelection) {
      dialogWasOpenRef.current = true;
      return;
    }
    if (!dialogWasOpenRef.current) return;
    dialogWasOpenRef.current = false;
    const invoker = dialogInvokerRef.current;
    dialogInvokerRef.current = null;
    restoreFocusDeferred(invoker, rootRef.current);
  }, [dialog, confirmDeleteSelection]);

  // --- stacking + visibility ---------------------------------------------------
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const update = () => {
      // §6.1: 200 + 360 + 240 = 800 px is the three-column minimum.
      setWidthStacked(root.clientWidth > 0 && root.clientWidth < 800);
      setEditorVisible(
        root.clientWidth > 0 &&
          root.clientHeight > 0 &&
          document.visibilityState === "visible",
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  // --- scene actions (stable closures over refs) -------------------------------
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
    setConfirmDeleteSelection(false);
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

  // --- keybindings (bound once to the root div) ----------------------------------
  // Mod+S reaches the current export click through a ref: the key handler is built once.
  const saveRef = useRef<() => void>(() => {});
  const renameRef = useRef<() => void>(() => {});
  const keyHandler = useMemo(
    () =>
      createEditorKeyHandler({
        editMode,
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
          if (selection.getSnapshot().ids.length > 0) {
            setConfirmDeleteSelection(true);
          }
        },
        onDuplicate: () => void duplicateSelection(),
        onUndo: () => void doUndo(),
        onSave: () => saveRef.current(),
        onRename: () => renameRef.current(),
        onRedo: () => void doRedo(),
      }),
    // The callbacks close over refs + stable stores only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gizmoMode, selection, editMode],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    return ctx.addEventListener(
      root,
      "keydown",
      keyHandler as unknown as EventListener,
    );
  }, [ctx, keyHandler]);

  // --- header actions ------------------------------------------------------------
  // Import with no scene at all (D-PLAN-04): create the "Untitled"
  // scene Import needs, then open the editor's local Import dialog on
  // it. It never toasts `createFirst`.
  async function openEmptyImport(
    e: React.MouseEvent<HTMLButtonElement>,
  ): Promise<void> {
    // 0-C: capture the invoker synchronously BEFORE the await — React
    // clears e.currentTarget once the handler's dispatch completes, so
    // reading it after the await would yield null.
    dialogInvokerRef.current = e.currentTarget;
    const id = await createUntitledScene(rest, sourceKey);
    if (!id) return;
    setDialog({ kind: "import", sceneId: id });
  }

  function openImport(e: React.MouseEvent<HTMLButtonElement>): void {
    if (!activeId) return;
    setPendingDialog({
      kind: "import",
      sceneId: activeId,
      sourceKey,
      epoch: gatewayActivationEpoch(),
      invoker: e.currentTarget,
    });
    // Note the ordering: the subscription listener fires synchronously
    // inside setPendingDialog and calls takePending() first,
    // transferring the invoker and opening the dialog; this explicit
    // takePending() after it is then a no-op. The transfer happens
    // exactly once.
    takePending();
  }

  const exportOpts = {
    suggestedName: friendlyGlbName(sceneSpec?.name),
    capture: () => captureGatewayFileDownload(),
    // G-06: export toasts announce through the live region too (the
    // toast text, once — the region is the screen-reader channel).
    notify: (kind: "info" | "warning", message: string) => {
      announce(message);
      host.notify({ kind, message });
    },
  };

  async function onExportClick(): Promise<void> {
    if (!activeId || exporting) return;
    if (exportPending) {
      const saved = await runSaveClick(exportPending, exportOpts);
      if (!saved) {
        const message = `Exported. Hermes saved it at ${exportPending.path}.`;
        announce(message);
        host.notify({
          kind: "info",
          message,
        });
      }
      setExportPending(null);
      return;
    }
    setExporting(true);
    try {
      const result = await runExportClick(rest, activeId, exportOpts);
      if (result.ok) markLearning("save");
      if (result.ok && !result.saved) setExportPending(result.pending);
    } finally {
      setExporting(false);
    }
  }

  saveRef.current = () => { void onExportClick(); };
  renameRef.current = () => { if (sceneSpec) setRenaming(true); };

  async function doCreateScene(): Promise<void> {
    const name = newName.trim();
    if (name === "" || creating) return;
    setCreating(true);
    try {
      const envelope = await createScene(rest, name);
      setDialog(null);
      setEditorSceneId(sourceKey, envelope.scene.id);
      invalidateSceneData(sourceKey);
      host.navigate(`/plastis3d?scene=${envelope.scene.id}`);
    } catch (err) {
      toastApiError(err, "edit");
    } finally {
      setCreating(false);
    }
  }

  // --- loading (G-12) ----------------------------------------------------------
  // The chrome (header / toolbar / columns) stays mounted through a
  // load — the canvas area shows the host Skeleton and the toolbar
  // shows "Loading…" (errata Issue 4: the editor has no stats line, so
  // "Loading…" goes in the toolbar). The side columns render empty
  // until the scene arrives (they need sceneSpec); the row itself does
  // not pop in.
  const listLoading = list.status === "loading" && !list.data;
  // G-12: "loading" means a scene is on its way — never "there is no
  // active scene". An empty list (last scene deleted) must reach the
  // empty-state branch, and a failed record must reach the error
  // branch, not sit on a skeleton forever.
  const listHasScenes = (list.data?.length ?? 0) > 0;
  const sceneLoading =
    !listLoading &&
    listHasScenes &&
    !(sceneQuery.status === "error" && !sceneQuery.data) &&
    (activeId === null || !sceneSpec);
  const editorLoading = listLoading || sceneLoading;

  // G-06/G-12: the scene GET in flight announces "Loading scene…"
  // (deduped per (source, scene) across surfaces).
  const editorSceneLoadingForAnnounce =
    activeId !== null && sceneQuery.status === "loading" && !sceneQuery.data;
  useEffect(() => {
    if (editorSceneLoadingForAnnounce && activeId !== null) {
      announceLoadingScene(sourceKey, activeId);
    }
  }, [editorSceneLoadingForAnnounce, activeId, sourceKey]);

  // --- tool dock (glass, over the stage) ------------------------------------------
  function setMode(mode: GizmoMode): void {
    gizmoMode.setMode(
      resolveModeForSelection(mode, selectionSnapshot.ids.length),
    );
  }

  const tools: Array<{ mode: GizmoMode; label: string; icon: IconName; tip: string }> = [
    { mode: "select", label: "Select (Q)", icon: "select", tip: "Select — click an object to pick it." },
    { mode: "translate", label: "Move (W)", icon: "move", tip: "Move — drag an arrow to slide along one direction." },
    { mode: "rotate", label: "Rotate (E)", icon: "rotate", tip: "Rotate — drag a ring to turn it." },
    { mode: "scale", label: "Scale (R)", icon: "scale", tip: "Scale — drag a handle to make it bigger or smaller." },
  ];

  const toolbar = (
    <DockShell label="Viewport tools" className="p3d-dock p3d-glass" activeIcon={tools.find((t) => t.mode === gizmoSnapshot.mode)?.icon ?? "select"}>
      {tools.map((t) => (
        <Tip key={t.mode} label={t.tip} side="right">
          <button
            type="button"
            className="p3d-iconbtn"
            aria-label={t.label}
            aria-pressed={gizmoSnapshot.mode === t.mode}
            onClick={() => setMode(t.mode)}
          >
            <Icon name={t.icon} size={19} />
          </button>
        </Tip>
      ))}
      <span className="p3d-sep-h" aria-hidden="true" />
      <Tip label="Edit mesh (M) — change the shape's faces, edges and corners" side="right">
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Edit mesh (M)"
          aria-pressed={editSnapshot.active}
          onClick={() => editMode.dispatch({ type: "toggle" })}
        >
          <Icon name="model" size={19} />
        </button>
      </Tip>
      <Tip label="Frame selection (F) — fit it in view" side="right">
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Frame selection (F)"
          onClick={() => gizmoMode.requestFrame()}
        >
          <Icon name="frame" size={19} />
        </button>
      </Tip>
      <Tip label="Reset view — back to the starting angle" side="right">
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Reset view"
          onClick={() => gizmoMode.requestResetView()}
        >
          <Icon name="home" size={19} />
        </button>
      </Tip>
      <SnapControls />
    </DockShell>
  );

  // --- render ------------------------------------------------------------------------
  const canUndo = sceneQuery.data?.feedback.canUndo ?? false;
  const canRedo = sceneQuery.data?.feedback.canRedo ?? false;
  const deleteNames = selectionSnapshot.ids
    .map((id) => sceneSpec?.nodes.find((n) => n.id === id)?.name)
    .filter((n): n is string => typeof n === "string");
  const stats = sceneQuery.data?.stats;
  // The pane docked beside the editor carries the Scene outline and the
  // Properties inspector; the editor keeps the view and its tools. If the pane
  // is hidden (or the host is too narrow for it) the editor shows them itself.
  const paneVisible = useValue(host.paneVisibility("plastis3d:viewport"));
  const panelsInPane = paneVisible && collapseAllowed();
  useEffect(() => {
    if (!panelsInPane || !sceneSpec) { publishEditorPanels(null); return; }
    publishEditorPanels({ scene: sceneSpec, stats: stats ?? null, pulseIds: presence?.ids, sourceKey, onKeyDown: keyHandler });
  }, [panelsInPane, sceneSpec, stats, presence, sourceKey, keyHandler]);
  useEffect(() => () => { publishEditorPanels(null); selection.set([]); }, [selection]);
  const objectCount = sceneSpec
    ? sceneSpec.nodes.filter((n) => n.kind !== "light" && n.kind !== "camera").length
    : 0;

  const stageOverlay = (
    <>
      {toolbar}
      <div className="p3d-stage-bl">
        <span className="p3d-stat-chip p3d-glass p3d-num" aria-label="Scene size">
          {editorLoading ? (
            <span>Loading…</span>
          ) : (
            <>
              {stats ? `${formatCount(stats.tris)} tris` : "—"}
              <span aria-hidden="true">·</span>
              {objectCount === 1 ? "1 object" : `${objectCount} objects`}
            </>
          )}
        </span>
        {committing && stacked && (
          <span className="p3d-stat-chip p3d-glass">
            <GlyphSpinner ariaLabel="Saving" />
            Saving…
          </span>
        )}
      </div>
      <div className="p3d-stage-br">
        <span className="p3d-glass" style={{ display: "inline-flex", padding: 3, gap: 2 }}>
          <Tip label="Grid (G) — the floor lines">
            <button
              type="button"
              className="p3d-iconbtn"
              aria-label="Grid (G)"
              aria-pressed={gizmoSnapshot.grid}
              onClick={() => gizmoMode.toggleGrid()}
            >
              <Icon name="grid" size={18} />
            </button>
          </Tip>
          <Tip label="Wireframe — see the triangles">
            <button
              type="button"
              className="p3d-iconbtn"
              aria-label="Wireframe"
              aria-pressed={gizmoSnapshot.wireframe}
              onClick={() => gizmoMode.toggleWireframe()}
            >
              <Icon name="wireframe" size={18} />
            </button>
          </Tip>
          <ViewMenu onFrameAll={() => {
            selection.clear();
            gizmoMode.requestFrame();
          }} />
        </span>
      </div>
    </>
  );

  // Presence is rendered below; data changes are observed by PresenceTracker.
  const editingText = editingStatus(editSnapshot);
  const saveState = editingText ? (
    <span className="p3d-save-state" role="status" title="Your edit is saved as one step when you press Done">
      <Icon name="model" size={14} />
      {editingText}
    </span>
  ) : committing ? (
    <span className="p3d-save-state" role="status">
      <GlyphSpinner ariaLabel="Saving" />
      Saving…
    </span>
  ) : sceneQuery.error ? (<span className="p3d-save-state" role="status">Not saved…</span>) : sceneSpec ? (
    <span className="p3d-save-state" role="status" title="Every change is saved as you make it">
      <Icon name="check" size={14} />
      Saved
    </span>
  ) : null;

  // The header is shared by the ready branch and the loading branch
  // (G-12: the chrome stays mounted through a load).
  const header = (
    <header className="p3d-header">
      <ScenePicker
        rest={rest}
        sourceKey={sourceKey}
        onNew={(invoker) => {
          dialogInvokerRef.current = invoker;
          setNewName("Untitled");
          setDialog({ kind: "new" });
        }}
        onRename={sceneSpec ? () => setRenaming(true) : undefined}
      />
      {!stacked && saveState}
      <Tip label="Undo (⌘Z)">
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Undo"
          disabled={!canUndo}
          onClick={() => void doUndo()}
        >
          <Icon name="undo" size={18} />
        </button>
      </Tip>
      <Tip label="Redo (⇧⌘Z)">
        <button
          type="button"
          className="p3d-iconbtn"
          aria-label="Redo"
          disabled={!canRedo}
          onClick={() => void doRedo()}
        >
          <Icon name="redo" size={18} />
        </button>
      </Tip>
      <span className="p3d-header-spacer" />
      {sceneSpec && (
        <AddMenu rest={rest} scene={sceneSpec} selection={selection} chrome="editor" />
      )}
      <Tip label="Open a model file (GLB, glTF, OBJ, STL or PLY)">
        <button
          type="button"
          className={stacked ? "p3d-iconbtn" : "p3d-btn"}
          aria-label="Open a model"
          disabled={!activeId}
          onClick={openImport}
        >
          <Icon name="import" size={stacked ? 18 : 16} />
          {!stacked && "Open…"}
        </button>
      </Tip>
      <Tip label="Save this scene as a .glb file">
        <button
          type="button"
          className={stacked ? "p3d-iconbtn" : "p3d-btn p3d-btn--outline"}
          aria-label={COPY.saveAsGlb}
          disabled={!activeId || exporting}
          onClick={() => void onExportClick()}
        >
          {exporting ? <GlyphSpinner ariaLabel="Exporting" /> : <Icon name="save" size={stacked ? 18 : 16} />}
          {!stacked && (exportPending ? COPY.saveAsGlb : exporting ? "Saving…" : "Save…")}
        </button>
      </Tip>
    </header>
  );

  const outlinerPanel = sceneSpec ? (
    <Outliner
      pulseIds={presence?.ids}
      rest={rest}
      scene={sceneSpec}
      selection={selection}
      gizmoMode={gizmoMode}
      sourceKey={sourceKey}
    />
  ) : null;
  const inspectorPanel = sceneSpec ? (
    <Inspector rest={rest} scene={sceneSpec} selection={selection} stats={stats ?? null} sourceKey={sourceKey} files={ctx.files ?? null} gizmoMode={gizmoMode} />
  ) : null;

  const stage = (
    <div
      className="p3d-col-center"
      onClick={() => rootRef.current?.focus()}
    >
      {sceneSpec && !editorLoading ? (
        <Viewport
          scene={sceneSpec}
          sourceKey={sourceKey}
          rest={rest}
          visible={editorVisible}
          chrome="editor"
          pulseIds={presence?.ids}
          selection={selection}
          gizmoMode={gizmoMode}
          editMode={editMode}
          settle={settleStore}
          thumbnailRef={thumbnailDraw}
          onCommittingChange={setCommitting}
          overlay={<>{stageOverlay}<EditToolbar store={editMode} />{!editSnapshot.active && <div className="p3d-stage-top"><AskChips edit sceneId={sceneSpec.id} selectedIds={selectionSnapshot.ids} /><SettleControl scene={sceneSpec} selectedIds={selectionSnapshot.ids} rest={rest} store={settleStore} /></div>}{selectionSnapshot.primary && <ClipTransport sourceKey={sourceKey} sceneId={sceneSpec.id} nodeId={selectionSnapshot.primary} onAddKey={(() => {
            const selected = sceneSpec.nodes.find((item) => item.id === selectionSnapshot.primary);
            if (selected?.kind !== "mesh" || !selected.clips?.length) return undefined;
            return (player) => { void updateNodeFields(rest, sceneSpec, selected.id, { clips: capturePrimitiveKey(selected.clips!, player.index, player.root, player.time) }).catch((err) => toastApiError(err, "edit")); };
          })()} />}<CoachTip id={gizmoSnapshot.mode === "translate" && selectionSnapshot.ids.length ? "move" : "multi"} active={!dialog && !committing && !draggingNow} text={gizmoSnapshot.mode === "translate" && selectionSnapshot.ids.length ? LEARNING_COPY.tips.move : sceneSpec.nodes.length > 3 ? LEARNING_COPY.tips.multi : ""} /><Checklist /><ShortcutSheet /><PresenceTracker scene={sceneSpec} onChange={setPresence} />{presence && <div className="p3d-agent-bar p3d-glass" role="status">{presence.tool ? "Hermes updated the scene" : "The scene was updated"} · {presence.count} changes <button className="p3d-btn p3d-btn--sm" onClick={() => { selection.set(presence.ids); gizmoMode.requestFrame(); }}>Show</button><button className="p3d-btn p3d-btn--sm" onClick={() => { void undoScene(rest, sceneSpec.id, sceneSpec.revision).catch(err => toastApiError(err, "edit")); }}>{presence.revisions > 1 ? "Undo last" : "Undo"}</button><button className="p3d-btn p3d-btn--sm" onClick={() => setPresence(null)}>Dismiss</button></div>}</>}
        />
      ) : (
        <div className="p3d-stage">
          <Skeleton
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.5 }}
            aria-label="Loading scene"
          />
          {stageOverlay}
        </div>
      )}
    </div>
  );

  const columns = panelsInPane ? (
    <div className="p3d-cols">{stage}</div>
  ) : stacked ? (
    <div className="p3d-cols">
      {stage}
      <div className="p3d-sheet">
        <div className="p3d-sheet-tabs" role="tablist" aria-label="Panels">
          {(["scene", "properties"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              className="p3d-tab"
              aria-selected={sheetTab === tab}
              onClick={() => setSheetTab(tab)}
            >
              {tab === "scene" ? "Scene" : "Properties"}
            </button>
          ))}
        </div>
        <div className="p3d-sheet-body" role="tabpanel">
          {sheetTab === "scene" ? outlinerPanel : inspectorPanel}
        </div>
      </div>
    </div>
  ) : (
    <div className="p3d-cols">
      <div className="p3d-col-left">{outlinerPanel}</div>
      {stage}
      <div className="p3d-col-right">{inspectorPanel}</div>
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-plastis-root="editor"
      tabIndex={-1}
      className={`p3d-root p3d-editor${stacked ? " p3d-editor--narrow" : ""}`}
      {...modelDrop.handlers}
    >
      {modelDrop.overlay}
      {sceneSpec && <SceneRename scene={sceneSpec} rest={rest} open={renaming} onClose={() => { setRenaming(false); restoreFocusDeferred(null, rootRef.current); }} />}
      <LiveRegion />
      {editorLoading ? (
        <>
          {header}
          {columns}
        </>
      ) : (list.status === "error" && !list.data) || list.storeExhausted ? (
        <div className="p3d-message">
          <ErrorState
            title={COPY.storeTitle}
            description={COPY[list.storeSentence]}
          >
            <Button variant="outline" onClick={() => list.refetch()}>
              Try again
            </Button>
          </ErrorState>
        </div>
      ) : badQueryId !== null ? (
        <div className="p3d-message">
          <ErrorState
            title={cardBadIdMessage(badQueryId)}
            description="Choose a scene from the list."
          >
            <Button
              variant="outline"
              onClick={() => {
                setBadQueryId(null);
                host.navigate("/plastis3d");
              }}
            >
              All scenes
            </Button>
          </ErrorState>
        </div>
      ) : !list.data || list.data.length === 0 ? (
        <div className="p3d-panel-scroll">
          <NoSceneEmptyState
            rest={rest}
            sourceKey={sourceKey}
            onNew={(e) => {
              dialogInvokerRef.current = e.currentTarget;
              setNewName("Untitled");
              setDialog({ kind: "new" });
            }}
            onImport={(e) => void openEmptyImport(e)}
          />
        </div>
      ) : !activeId || !sceneSpec || sceneQuery.storeExhausted ? (
        // Reachable only as the error case (editorLoading covers the
        // rest). SCENE_NOT_FOUND / SCHEMA_NEWER keep their titles (G-14).
        <div className="p3d-message">
          <ErrorState
            title={
              sceneQuery.error instanceof ApiError &&
              sceneQuery.error.code === "SCENE_NOT_FOUND"
                ? cardBadIdMessage(activeId ?? "")
                : sceneQuery.error instanceof ApiError &&
                    sceneQuery.error.code === "SCHEMA_NEWER"
                  ? COPY.newerSchema
                  : COPY.storeTitle
            }
            description={
              sceneQuery.error instanceof ApiError &&
              sceneQuery.error.code === "SCENE_NOT_FOUND"
                ? "Choose a scene from the list."
                : sceneQuery.error instanceof ApiError &&
                    sceneQuery.error.code === "SCHEMA_NEWER"
                  ? undefined
                  : COPY[sceneQuery.storeSentence]
            }
          >
            <Button variant="outline" onClick={() => sceneQuery.refetch()}>
              Try again
            </Button>
          </ErrorState>
        </div>
      ) : (
        <>
          {header}
          {columns}
        </>
      )}

      {dialog?.kind === "samples" && <><div className="p3d-scrim" onClick={() => setDialog(null)} /><div className="p3d-dialog" role="dialog" aria-modal="true" aria-label="Try a sample" onKeyDown={event => { if (event.key === "Escape") setDialog(null); }}><div className="p3d-dialog-title">Try a sample</div><p className="p3d-help" style={{ margin: "0 0 4px" }}>{creating ? "Building…" : "Pick one to start from. It opens as a new scene you can change."}</p><div className="p3d-sample-grid" role="group" aria-label="Samples">{SAMPLE_NAMES.map(sample => <button key={sample} className="p3d-btn p3d-btn--outline" style={{ height: 44 }} disabled={creating} onClick={() => { setCreating(true); void buildSampleSnowman(rest, sourceKey, sample).finally(() => { setCreating(false); setDialog(null); }); }}>{sample}</button>)}</div><div className="p3d-dialog-actions"><button className="p3d-btn" onClick={() => setDialog(null)}>Cancel</button></div></div></>}
      {dialog?.kind === "new" && (
        <>
          <div className="p3d-scrim" aria-hidden="true" onClick={() => setDialog(null)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="New scene"
            className="p3d-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                setDialog(null);
              }
            }}
          >
            <div className="p3d-dialog-title">New scene</div>
            <label style={{ display: "block" }}>
              <span className="p3d-label" style={{ display: "block", marginBottom: 6 }}>
                Name
              </span>
              <Input
                value={newName}
                autoFocus
                aria-label="Scene name"
                maxLength={80}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void doCreateScene();
                }}
              />
            </label>
            <div className="p3d-dialog-actions">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                disabled={newName.trim() === "" || creating}
                onClick={() => void doCreateScene()}
              >
                {creating ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </>
      )}

      {dialog?.kind === "import" && sceneSpec && (
        <ImportDialog
          rest={rest}
          scene={sceneSpec}
          sourceKey={sourceKey}
          files={ctx.files ?? null}
          selection={selection}
          gizmoMode={gizmoMode}
          droppedFile={dialog.file}
          onClose={() => setDialog(null)}
        />
      )}

      {confirmDeleteSelection && deleteNames.length > 0 && (
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
          onCancel={() => setConfirmDeleteSelection(false)}
        />
      )}
    </div>
  );
}

/** The ⚙ View popover: background, quality, frame all (§6.1). */
export function ViewMenu({ onFrameAll, compact = false }: { onFrameAll?: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const prefs = useViewPrefs();
  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      side="top"
      label="View options"
      anchor={
        <Tip label="View options">
          <button
            type="button"
            className="p3d-iconbtn"
            aria-label="View options"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon name="view" size={18} />
          </button>
        </Tip>
      }
    >
      <div style={{ width: compact ? 240 : 260 }}>
        <div className="p3d-menu-label">Background</div>
        <div className="p3d-menu-row">
          <Segmented<StageBackground>
            ariaLabel="Background"
            value={prefs.background}
            options={[
              { value: "gradient", label: "Studio" },
              { value: "studio", label: "Room" },
              { value: "plain", label: "Plain" },
            ]}
            onChange={(v) => setViewPrefs({ background: v })}
          />
        </div>
        <div className="p3d-menu-label">Quality</div>
        <div className="p3d-menu-row">
          <Segmented<QualityPref>
            ariaLabel="Quality"
            value={prefs.quality}
            options={[
              { value: "auto", label: "Auto" },
              { value: "high", label: "High" },
              { value: "low", label: "Fast" },
            ]}
            onChange={(v) => setViewPrefs({ quality: v })}
          />
        </div>
        <div className="p3d-sep-h" />
        <MenuItem
          label="Fill light when the scene has none"
          checked={prefs.fillLight}
          onClick={() => setViewPrefs({ fillLight: !prefs.fillLight })}
        />
        {onFrameAll && (
          <MenuItem
            icon="frame"
            label="Frame everything"
            onClick={() => {
              setOpen(false);
              onFrameAll();
            }}
          />
        )}
        <div className="p3d-help" style={{ padding: "6px 8px 2px" }}>
          View settings only change how you see the scene. They are never saved into it.
        </div>
      </div>
    </Popover>
  );
}

function PresenceTracker({ scene, onChange }: { scene: import("../types").SceneSpec; onChange: React.Dispatch<React.SetStateAction<{ ids: string[]; count: number; tool: boolean; revisions: number } | null>> }) {
 const before = useRef(scene);
 const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
 useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
 useEffect(() => {
  const old = before.current; before.current = scene;
  if (old.id !== scene.id) { if (timer.current) clearTimeout(timer.current); onChange(null); return; }
  if (old.revision === scene.revision) return;
  const diff = sceneDiff(old.nodes, scene.nodes, old.materials, scene.materials);
  if (isLocalWrite(scene.id, scene.revision)) {
    offerTip("undo");
    if (diff.added.length) offerTip("add");
    if (diff.changed.some(id => JSON.stringify(old.nodes.find(n=>n.id===id)?.transform) !== JSON.stringify(scene.nodes.find(n=>n.id===id)?.transform))) markLearning("move");
    if (JSON.stringify(old.materials) !== JSON.stringify(scene.materials) || diff.changed.some(id=>old.nodes.find(n=>n.id===id)?.materialId !== scene.nodes.find(n=>n.id===id)?.materialId)) markLearning("color");
    return;
  }
  const tool = revisionOrigin(scene.id, scene.revision) === "tool";
  if (tool) markLearning("save");
  announce(`Scene updated: ${diff.count} changes.`);
  onChange(value => ({ ids: [...diff.added,...diff.changed], count: diff.count, tool, revisions: (value?.revisions ?? 0) + 1 }));
  if (timer.current) clearTimeout(timer.current);
  timer.current = setTimeout(() => onChange(null), 8000);
 }, [scene, onChange]);
 return null;
}

function SceneRename({ scene, rest, open, onClose }: { scene: import("../types").SceneSpec; rest: RestFn; open: boolean; onClose: () => void }) {
  const [name, setName] = useState(scene.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setName(scene.name);
    const id = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
    return () => cancelAnimationFrame(id);
    // Re-seed only when the field opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  return (
    <form
      className="p3d-rename-pop p3d-glass"
      aria-label="Rename scene"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
      onSubmit={(event) => {
        event.preventDefault();
        const next = name.trim();
        if (next && next !== scene.name) void patchScene(rest, scene.id, scene.revision, [{ op: "set_scene_name", name: next }]).catch((error) => toastApiError(error, "edit"));
        onClose();
      }}
    >
      <input ref={inputRef} className="p3d-input" aria-label="Scene name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
      <button className="p3d-btn p3d-btn--sm p3d-btn--primary" type="submit">Rename</button>
      <button className="p3d-btn p3d-btn--sm" type="button" onClick={onClose}>Cancel</button>
    </form>
  );
}
