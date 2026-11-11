// src/editor/ScenePicker.tsx — the editor header's scene menu (Stage 5, PR5).
//
// The scene list, then New…, Duplicate, Delete scene…. Duplicate builds
// a filtered copy (duplicateScene.ts); Delete uses ConfirmDialog with
// the exact ui-design title/body/confirm. New… calls the Editor's
// onNew prop directly: the picker only ever renders inside the Editor,
// so the pending-dialog detour is wrong here — takePending runs on
// mount/focus/popstate, and navigating to the same path fires none of
// those, so the dialog never opened (merge fix, PR5 report). The
// pending dialog stays for the callers that run while the Editor is
// NOT mounted (Scenes pane, palette commands).
// Plain HTML menu (button + div[role=menu]) — the SDK's Select /
// DropdownMenu are compound Radix components and stay plain HTML in
// 0.1.0 (audit exception, PR5 report).

import { useEffect, useRef, useState } from "react";
import { host } from "@hermes/plugin-sdk";
import { Icon } from "../ui/icons";
import { SceneTile } from "../ui/SceneTile";
import { filterScenes } from "../state/thumbnails";
import type { RestFn } from "../api";
import { deleteScene, duplicateScene } from "../api";
import { COPY } from "../copy";
import { duplicateSceneName } from "./duplicateScene";
import { ConfirmDialog } from "./ConfirmDialog";
import { restoreFocusDeferred } from "./focusReturn";
import { setEditorSceneId, useActiveSceneId } from "../state/activeScene";
import {
  invalidateSceneList,
  useScene,
  useSceneList,
} from "../state/sceneQuery";
import { toastApiError } from "./sceneActions";

export interface ScenePickerProps {
  rest: RestFn;
  sourceKey: string;
  /** Open the New-scene dialog (the Editor owns the dialog state). Takes the invoking element for the 0-C focus return. */
  onNew: (invoker: HTMLElement) => void;
  /** Open the rename field (the "Rename…" menu item). */
  onRename?: () => void;
}

export function ScenePicker({ rest, sourceKey, onNew, onRename }: ScenePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteTarget = useRef<{ id: string; revision: number } | null>(null);
  // 0-C: the scene-name trigger button — the delete-scene confirm's
  // focus fallback (the "Delete scene…" menuitem is gone at close).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // 0-C: tracks whether the confirm was open, so the close effect
  // does not steal focus on mount (confirmDelete starts false).
  const confirmWasOpenRef = useRef(false);

  const list = useSceneList(sourceKey, { eligible: true });
  const activeId = useActiveSceneId(sourceKey);
  const activeScene = useScene(sourceKey, activeId, {
    eligible: activeId !== null,
  });

  const activeName =
    list.data?.find((s) => s.id === activeId)?.name ?? activeId ?? "Scenes";

  function openNew(e: React.MouseEvent<HTMLButtonElement>): void {
    setOpen(false);
    onNew(e.currentTarget);
  }

  async function doDuplicate(): Promise<void> {
    setOpen(false);
    if (!activeId || !activeScene.data) return;
    try {
      const envelope = await duplicateScene(rest, activeId, duplicateSceneName(activeName));
      invalidateSceneList(sourceKey);
      setEditorSceneId(sourceKey, envelope.scene.id);
      host.navigate(`/plastis3d?scene=${envelope.scene.id}`);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function doDeleteScene(): Promise<void> {
    setConfirmDelete(false);
    setOpen(false);
    const target = deleteTarget.current;
    if (!target) return;
    try {
      await deleteScene(rest, target.id, target.revision);
      // The active-scene rule falls back to the first scene in list
      // order once the list refetches; drop the query so the editor
      // does not keep showing the deleted id. Refetch now (F-UI-FIX-09)
      // rather than waiting up to one 4 s poll with the deleted scene
      // still on every surface.
      invalidateSceneList(sourceKey);
      host.navigate("/plastis3d");
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  // --- delete-scene confirm close: focus return (0-C, D-REPLAN-08) ------
  // One effect is the choke point: it catches both the confirm and the
  // cancel paths. On close, focus the trigger button — it still exists
  // after the delete, showing the next scene's name, so one fallback
  // covers both paths. The invoker (the "Delete scene…" menuitem) is
  // gone at close (the menu closed at open), so it is not the fallback.
  useEffect(() => {
    if (confirmDelete) {
      confirmWasOpenRef.current = true;
      return;
    }
    if (!confirmWasOpenRef.current) return;
    confirmWasOpenRef.current = false;
    restoreFocusDeferred(null, triggerRef.current);
  }, [confirmDelete]);

  return (
    <div className="p3d-header-title" style={{ position: "relative" }}>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="p3d-btn"
        style={{ maxWidth: "100%", height: 36, padding: "0 8px", fontSize: 15, fontWeight: 600, gap: 8 }}
        title="Switch scene, or make a new one"
      >
        <SceneTile rest={rest} sourceKey={sourceKey} sceneId={activeId ?? ""} name={activeName} revision={list.data?.find((s) => s.id === activeId)?.thumbnailRevision} size={24} radius={6} font={12} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {activeName}
        </span>
        <Icon name="chevron" size={15} style={{ color: "var(--p3d-text-3)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--p3d-fast) var(--p3d-ease)" }} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Scenes"
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              setOpen(false);
            }
          }}
          className="p3d-pop"
          style={{ top: "calc(100% + 6px)", left: 0, minWidth: 260, maxHeight: 420, overflow: "auto" }}
        >
          {(list.data?.length ?? 0) > 5 && (
            <input
              type="search"
              className="p3d-input"
              aria-label="Search scenes"
              placeholder="Search scenes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}
              style={{ margin: "4px 8px", width: "calc(100% - 16px)" }}
            />
          )}
          {filterScenes(list.data ?? [], query).map((scene) => (
            <button
              key={scene.id}
              type="button"
              role="menuitem"
              aria-current={scene.id === activeId ? "true" : undefined}
              onClick={() => {
                setOpen(false);
                setEditorSceneId(sourceKey, scene.id);
                host.navigate(`/plastis3d?scene=${scene.id}`);
              }}
              className="p3d-menu-item"
              style={{ height: 40, fontWeight: scene.id === activeId ? 600 : 400, background: scene.id === activeId ? "var(--p3d-accent-soft)" : undefined }}
            >
              <SceneTile rest={rest} sourceKey={sourceKey} sceneId={scene.id} name={scene.name} revision={scene.thumbnailRevision} size={26} radius={7} font={12} />
              <span className="p3d-grow" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{scene.name}</span>
              {scene.id === activeId && <Icon name="check" size={15} style={{ color: "var(--p3d-accent)" }} />}
            </button>
          ))}
          <div role="separator" className="p3d-sep-h" />
          <button
            type="button"
            role="menuitem"
            onClick={openNew}
            className="p3d-menu-item"
          >
            <Icon name="plus" size={16} />
            <span className="p3d-grow">New…</span>
          </button>
          {onRename && (
            <button
              type="button"
              role="menuitem"
              aria-label="Rename scene"
              disabled={!activeId || !activeScene.data}
              onClick={() => {
                setOpen(false);
                onRename();
              }}
              className="p3d-menu-item"
            >
              <Icon name="check" size={16} style={{ opacity: 0 }} />
              <span className="p3d-grow">Rename…</span>
              <kbd style={{ font: "inherit", fontSize: 11, opacity: 0.55 }}>F2</kbd>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={!activeId || !activeScene.data}
            onClick={() => void doDuplicate()}
            className="p3d-menu-item"
          >
            <Icon name="duplicate" size={16} />
            <span className="p3d-grow">Duplicate</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!activeId}
            onClick={() => {
              setOpen(false);
              if (!activeId || !activeScene.data) return;
              deleteTarget.current = { id: activeId, revision: activeScene.data.scene.revision };
              setConfirmDelete(true);
            }}
            className="p3d-menu-item"
          >
            <Icon name="trash" size={16} />
            <span className="p3d-grow">Delete scene…</span>
          </button>
        </div>
      )}
      {confirmDelete && activeId && (
        <ConfirmDialog
          title={`Delete scene “${activeName}”?`}
          body="This removes the scene. Copies of imported models already stored by Plastis3D stay on disk."
          confirmLabel="Delete scene"
          onConfirm={() => void doDeleteScene()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

