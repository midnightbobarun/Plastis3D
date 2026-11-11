// src/editor/Outliner.tsx — the scene tree (Stage 5, PR5).
//
// role=tree / role=treeitem with roving tabIndex: Up/Down move focus,
// Left collapses (or moves to the parent), Right expands, Enter
// selects. Plain click replaces the selection, Ctrl/Cmd-click toggles,
// Shift-click range-selects in visible order (selection store). Rows:
// disclosure triangle, kind Codicon, name, eye, lock Codicon on
// kind=model. Part rows carry a part mark and the file name (the
// asset's originalName). Drag a row onto another to reparent (drop on
// the background reparents to null); a cycle comes back SPEC_INVALID
// from the server and the row stays put (no optimistic move). Context
// menu (plain HTML, not the Radix ContextMenu): Frame, Duplicate,
// Delete (ConfirmDialog), Show/Hide. A SearchField mounts only when
// the node count is greater than 12.

import { useEffect, useMemo, useRef, useState } from "react";
import { SearchField } from "@hermes/plugin-sdk";
import { Icon, nodeIconName } from "../ui/icons";
import { AddMenu } from "./AddMenu";
import { kindWords } from "./Inspector";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import {
  deleteNodes,
  duplicateNodes,
  reparentNode,
  setNodeVisible,
  subtreeIds,
  toastApiError,
} from "./sceneActions";
import { reparentTransform } from "./reparentMath";
import { notifyToast } from "./sceneActions";
import { ConfirmDialog } from "./ConfirmDialog";
import { useSelection } from "../state/selection";
import type { SelectionStore } from "../state/selection";
import { isReparentDragging, setReparentDragging } from "../state/dragLock";
import { flushDeferredFocus } from "../state/editorFocus";
import { invalidateSceneData } from "../state/sceneQuery";
import type { GizmoModeStore } from "../gizmos/gizmoMode";
import type { NodeSpec, SceneSpec } from "../types";

export interface OutlinerProps {
  pulseIds?: string[];
  rest: RestFn;
  scene: SceneSpec;
  selection: SelectionStore;
  gizmoMode: GizmoModeStore;
  /** G-18 (D-REPLAN-07): the settlement refetch needs the sourceKey. */
  sourceKey: string;
}


interface Row {
  node: NodeSpec;
  depth: number;
  hasChildren: boolean;
}

/** Children of each parent id (dangling parents attach at the root). */
function childrenOf(nodes: NodeSpec[]): Map<string | null, NodeSpec[]> {
  const ids = new Set(nodes.map((n) => n.id));
  const map = new Map<string | null, NodeSpec[]>();
  for (const node of nodes) {
    const parent =
      node.parent !== null && ids.has(node.parent) ? node.parent : null;
    const list = map.get(parent) ?? [];
    list.push(node);
    map.set(parent, list);
  }
  return map;
}

/** Flatten the tree in display order, honouring collapsed ids. */
function flattenRows(
  children: Map<string | null, NodeSpec[]>,
  collapsed: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const node of children.get(parent) ?? []) {
      const kids = children.get(node.id) ?? [];
      rows.push({ node, depth, hasChildren: kids.length > 0 });
      if (kids.length > 0 && !collapsed.has(node.id)) {
        walk(node.id, depth + 1);
      }
    }
  };
  walk(null, 0);
  return rows;
}

export function Outliner({
  pulseIds = [],
  rest,
  scene,
  selection,
  gizmoMode,
  sourceKey,
}: OutlinerProps) {
  const snapshot = useSelection(selection);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    nodeId: string;
    x: number;
    y: number;
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // 0-C: the tree container — the delete-confirm fallback when the
  // deleted node had no parent (a root node).
  const treeRef = useRef<HTMLDivElement | null>(null);
  // 0-C: the delete confirm's capture — the deleted node's id, its
  // parent at open time, and the outcome (written at close time).
  const lastConfirmRef = useRef<{
    id: string;
    parent: string | null;
    confirmed: boolean;
  } | null>(null);
  // G-18: the reparent drag session. dragRevisionRef holds the
  // pointer-down revision the POST is based on (a ref, not state —
  // the drop handler reads it synchronously after the drag ends).
  // reparentPromiseRef holds the in-flight POST; settledRef is the
  // exactly-once guard for endDrag; dragGenerationRef scopes each
  // settlement to its own drag.
  const dragRevisionRef = useRef<number | null>(null);
  const reparentPromiseRef = useRef<Promise<unknown> | null>(null);
  const settledRef = useRef(false);
  const dragGenerationRef = useRef(0);

  // G-18 unmount fail-safe: if the Outliner unmounts while a reparent
  // drag is down, no dragend fires and the guard would stay set
  // forever, dropping all broadcasts, polls, and editor.focus events
  // until reload. Clear it (and flush any deferred focus) on unmount.
  // No refetch here: the in-flight POST still settles through its own
  // .finally, and the next poll tick picks up any dropped payload once
  // the guard clears.
  useEffect(
    () => () => {
      if (isReparentDragging()) {
        setReparentDragging(false);
        flushDeferredFocus();
      }
    },
    [],
  );

  const assetsById = useMemo(
    () => new Map(scene.assets.map((a) => [a.id, a])),
    [scene.assets],
  );
  const children = useMemo(() => childrenOf(scene.nodes), [scene.nodes]);
  const nodesById = useMemo(
    () => new Map(scene.nodes.map((n) => [n.id, n])),
    [scene.nodes],
  );

  const trimmedQuery = query.trim().toLowerCase();
  const rows = useMemo(() => {
    if (trimmedQuery === "") return flattenRows(children, collapsed);
    // Filtered view: matching rows plus their ancestors, all expanded.
    const matches = scene.nodes.filter((n) =>
      n.name.toLowerCase().includes(trimmedQuery),
    );
    const keep = new Set<string>();
    for (const node of matches) {
      let current: NodeSpec | undefined = node;
      while (current) {
        keep.add(current.id);
        current =
          current.parent !== null
            ? nodesById.get(current.parent)
            : undefined;
      }
    }
    const filtered = new Map<string | null, NodeSpec[]>();
    for (const [parent, kids] of children) {
      const kept = kids.filter((k) => keep.has(k.id));
      if (kept.length > 0) filtered.set(parent, kept);
    }
    return flattenRows(filtered, new Set());
  }, [children, collapsed, scene.nodes, nodesById, trimmedQuery]);

  const visibleOrder = rows.map((r) => r.node.id);
  const focusId = focusedId ?? visibleOrder[0] ?? null;

  function focusRow(id: string): void {
    setFocusedId(id);
    rowRefs.current.get(id)?.focus();
  }

  function toggleCollapse(id: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clickRow(id: string, event: React.MouseEvent): void {
    setMenu(null);
    focusRow(id);
    if (event.shiftKey) {
      selection.selectRange(selection.anchor(), id, visibleOrder);
    } else if (event.metaKey || event.ctrlKey) {
      selection.toggle(id);
    } else {
      selection.select(id);
    }
  }

  async function toggleVisible(id: string, visible: boolean): Promise<void> {
    try {
      await setNodeVisible(rest, scene, id, visible);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function duplicate(id: string): Promise<void> {
    try {
      const before = new Set(scene.nodes.map((n) => n.id));
      const envelope = await duplicateNodes(rest, scene, [id]);
      const created = envelope.nodes
        .map((n) => n.id)
        .filter((newId) => !before.has(newId));
      if (created.length > 0) selection.set(created);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  // --- delete-node confirm close: focus return (0-C, D-REPLAN-08) --------
  // One effect is the choke point: it catches both the confirm and
  // the cancel paths. It captures the deleted node's parent on the
  // null→non-null transition (the menu Delete handler only sets the
  // id, so the effect is the single capture site). `confirmed` is
  // written at close time, before the id is cleared — the branch MUST
  // come from the recorded outcome, not from the row's presence:
  // confirmDelete clears the id BEFORE the await, so the effect fires
  // while the deleted row still exists, and focusing it would land on
  // a row about to unmount (focus falls to BODY, the exact G-07
  // failure). The effect reads nodesById; it is NOT in the deps.
  useEffect(() => {
    if (confirmDeleteId === null) {
      const last = lastConfirmRef.current;
      if (!last) return;
      lastConfirmRef.current = null;
      if (last.confirmed) {
        // The parent survives the delete (it is the deleted node's
        // parent, never a descendant); a root node has no parent, so
        // the tree container is the fallback.
        if (last.parent !== null && rowRefs.current.has(last.parent)) {
          focusRow(last.parent);
        } else {
          treeRef.current?.focus();
        }
      } else {
        // Cancelled: the row still exists — focus it.
        focusRow(last.id);
      }
      return;
    }
    const node = nodesById.get(confirmDeleteId);
    lastConfirmRef.current = {
      id: confirmDeleteId,
      parent: node?.parent ?? null,
      confirmed: false,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmDeleteId]);

  async function confirmDelete(id: string): Promise<void> {
    // 0-C: record the outcome BEFORE clearing the id — the close
    // effect fires on the clear, and must branch on the recorded
    // outcome, not on the row's presence.
    if (lastConfirmRef.current) lastConfirmRef.current.confirmed = true;
    setConfirmDeleteId(null);
    try {
      const removed = subtreeIds(scene.nodes, id);
      await deleteNodes(rest, scene, scene.nodes, [id]);
      for (const removedId of removed) selection.remove(removedId);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  /**
   * G-18 settlement — the single call site, from the row onDragEnd
   * (dragend fires exactly once per drag, covering drop-on-row,
   * drop-on-background, cancel, and drop-outside). The drop handlers
   * only start the POST and stash its promise; they never refetch and
   * never clear the guard.
   */
  function endReparentDrag(): void {
    const generation = dragGenerationRef.current;
    const p = reparentPromiseRef.current;
    reparentPromiseRef.current = null;
    if (p) {
      // The guard stays set until the POST settles, mirroring the
      // gizmo (which clears its guard in the finally after the PATCH).
      void p.finally(() => endDrag(generation));
    } else {
      // Cancel: no POST in flight, settle immediately.
      endDrag(generation);
    }
  }

  /** Per-drag scoped settlement: a stale POST's finally is discarded. */
  function endDrag(generation: number): void {
    if (generation !== dragGenerationRef.current) return;
    if (settledRef.current) return;
    settledRef.current = true;
    setDragId(null);
    setDropId(null);
    dragRevisionRef.current = null;
    setReparentDragging(false);
    // The guard is cleared BEFORE the flush and the refetch, so
    // neither is dropped by it.
    flushDeferredFocus();
    invalidateSceneData(sourceKey, scene.id);
  }

  function onTreeKeyDown(event: React.KeyboardEvent): void {
    if (menu) {
      if (event.key === "Escape") setMenu(null);
      return;
    }
    const at = focusId !== null ? visibleOrder.indexOf(focusId) : -1;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (at >= 0 && at + 1 < visibleOrder.length) {
          focusRow(visibleOrder[at + 1]);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (at > 0) focusRow(visibleOrder[at - 1]);
        break;
      case "ArrowRight": {
        if (focusId === null) break;
        const row = rows[at];
        if (row?.hasChildren && collapsed.has(focusId)) {
          event.preventDefault();
          toggleCollapse(focusId);
        }
        break;
      }
      case "ArrowLeft": {
        if (focusId === null) break;
        const row = rows[at];
        if (row?.hasChildren && !collapsed.has(focusId)) {
          event.preventDefault();
          toggleCollapse(focusId);
        } else {
          const parent = row?.node.parent ?? null;
          if (parent !== null) {
            event.preventDefault();
            focusRow(parent);
          }
        }
        break;
      }
      case "Enter":
        if (focusId !== null) {
          event.preventDefault();
          selection.select(focusId);
        }
        break;
      default:
        break;
    }
  }

  const confirmNode =
    confirmDeleteId !== null ? nodesById.get(confirmDeleteId) : undefined;
  const menuNode = menu !== null ? nodesById.get(menu.nodeId) : undefined;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="p3d-panel-title">
        <span style={{ flex: "1 1 auto" }}>Scene</span>
        <span className="p3d-faint p3d-num" style={{ fontWeight: 400, fontSize: 11 }}>
          {scene.nodes.length === 1 ? "1 item" : `${scene.nodes.length} items`}
        </span>
      </div>
      {scene.nodes.length > 12 && (
        <div style={{ flex: "0 0 auto", padding: "0 8px 6px" }}>
          <SearchField
            placeholder="Filter nodes"
            aria-label="Filter nodes"
            value={query}
            onChange={setQuery}
            onKeyDown={(e) => {
              // N-10: Escape clears the query. No second blur call —
              // the root key handler's Escape behaviour (blur) still
              // applies, so clearing + blurring is the combined outcome.
              if (e.key === "Escape") setQuery("");
            }}
          />
        </div>
      )}
      <div
        ref={treeRef}
        role="tree"
        aria-label="Scene outline"
        tabIndex={-1}
        onKeyDown={onTreeKeyDown}
        onDragOver={(e) => {
          // Background drop target: reparent to null.
          if (dragId !== null && e.target === e.currentTarget) {
            e.preventDefault();
            setDropId(null);
          }
        }}
        onDrop={(e) => {
          if (dragId === null || e.target !== e.currentTarget) return;
          e.preventDefault();
          // G-18: fail closed — see the row drop handler.
          if (dragRevisionRef.current === null) return;
          const id = dragId;
          setDragId(null);
          reparentPromiseRef.current = reparentNode(
            rest,
            { id: scene.id, revision: dragRevisionRef.current },
            id,
            null,
            reparentTransform(scene, id, null),
          ).then(() => { if (!reparentTransform(scene, id, null)) notifyToast({ id: "reparentKeptLocal", message: COPY.reparentKeptLocal.replace("{parent}", "the scene root"), kind: "info" }); }).catch((err) => toastApiError(err, "edit"));
        }}
        className="p3d-tree"
        style={{ flex: "1 1 auto", overflow: "auto", minHeight: 0 }}
      >
        {rows.length === 0 && (
          <div className="p3d-help" style={{ padding: "8px 10px" }}>
            {trimmedQuery === "" ? "No nodes yet." : "No matching nodes."}
          </div>
        )}
        {rows.map(({ node, depth, hasChildren }) => {
          const selected = snapshot.ids.includes(node.id);
          const isFocused = node.id === focusId;
          const asset =
            node.modelAssetId !== undefined
              ? assetsById.get(node.modelAssetId)
              : undefined;
          return (
            <div
              key={node.id}
              ref={(el) => {
                if (el) rowRefs.current.set(node.id, el);
                else rowRefs.current.delete(node.id);
              }}
              role="treeitem"
              aria-selected={selected}
              aria-expanded={hasChildren ? !collapsed.has(node.id) : undefined}
              aria-level={depth + 1}
              tabIndex={isFocused ? 0 : -1}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", node.id);
                e.dataTransfer.effectAllowed = "move";
                setDragId(node.id);
                // G-18: arm the reparent drag session, synchronously.
                // setReparentDragging(true) is the load-bearing call —
                // without it the guard stays false and the arrival
                // guards and settlement below are dead.
                setReparentDragging(true);
                dragGenerationRef.current += 1;
                settledRef.current = false;
                dragRevisionRef.current = scene.revision;
                reparentPromiseRef.current = null;
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropId(null);
                endReparentDrag();
              }}
              onDragOver={(e) => {
                if (dragId === null || dragId === node.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropId(node.id);
              }}
              onDrop={(e) => {
                if (dragId === null || dragId === node.id) return;
                e.preventDefault();
                e.stopPropagation();
                // G-18: fail closed — a POST whose base revision cannot
                // be proven must not go out. Unreachable in practice
                // (dragStart always sets the ref alongside dragId),
                // but the guard is what makes the types check.
                if (dragRevisionRef.current === null) return;
                const id = dragId;
                setDragId(null);
                setDropId(null);
                // Stash the POST; settlement (onDragEnd) waits for it
                // and refetches once. Never refetch or clear the guard
                // here.
                reparentPromiseRef.current = reparentNode(
                  rest,
                  { id: scene.id, revision: dragRevisionRef.current },
                  id,
                  node.id,
                  reparentTransform(scene, id, node.id),
                ).then(() => { if (!reparentTransform(scene, id, node.id)) notifyToast({ id: "reparentKeptLocal", message: COPY.reparentKeptLocal.replace("{parent}", node.name), kind: "info" }); }).catch((err) => toastApiError(err, "edit"));
              }}
              onClick={(e) => clickRow(node.id, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                focusRow(node.id);
                setMenu({ nodeId: node.id, x: e.clientX, y: e.clientY });
              }}
              onFocus={() => setFocusedId(node.id)}
              title={
                node.visible ? undefined : COPY.hiddenExport
              }
              className={`p3d-row${pulseIds.includes(node.id) ? " p3d-row--pulse" : ""}${node.visible ? "" : " p3d-row--hidden"}${dropId === node.id ? " p3d-row--drop-into" : ""}`}
              style={{ paddingLeft: 2 + depth * 14 }}
            >
              <button
                type="button"
                className="p3d-row-caret"
                aria-label={
                  hasChildren
                    ? collapsed.has(node.id)
                      ? `Expand ${node.name}`
                      : `Collapse ${node.name}`
                    : undefined
                }
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  if (hasChildren) toggleCollapse(node.id);
                }}
                style={{
                  cursor: hasChildren ? "pointer" : "default",
                  visibility: hasChildren ? "visible" : "hidden",
                }}
              >
                <Icon
                  name="caret"
                  size={14}
                  style={{
                    transform: collapsed.has(node.id) ? "rotate(-90deg)" : "none",
                    transition: "transform var(--p3d-fast) var(--p3d-ease)",
                  }}
                />
              </button>
              <span className="p3d-row-icon">
                <Icon name={nodeIconName(node)} size={16} />
              </span>
              <span className="p3d-row-name">
                {node.name}
                {node.kind === "part" && asset && (
                  <span className="p3d-faint" style={{ fontSize: 11 }}>
                    {" "}
                    · {asset.originalName}
                  </span>
                )}
              </span>
              <span className="p3d-row-meta" aria-hidden="true">{rowSummary(node, scene.nodes)}</span>
              {node.kind === "model" && (
                <span className="p3d-row-icon" title="Imported models are locked; edit their parts">
                  <Icon name="lock" size={13} />
                </span>
              )}
              <span className={`p3d-row-tools${node.visible ? "" : " p3d-row-tools--on"}`}>
                <button
                  type="button"
                  className="p3d-iconbtn p3d-iconbtn--sm"
                  aria-label={node.visible ? `Hide ${node.name}` : `Show ${node.name}`}
                  title={node.visible ? `Hide ${node.name} (H)` : COPY.hiddenExport}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleVisible(node.id, !node.visible);
                  }}
                >
                  <Icon name={node.visible ? "eye" : "eyeOff"} size={15} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      <div className="p3d-outliner-foot">
        <AddMenu rest={rest} scene={scene} selection={selection} variant="ghost" ariaLabel="Add an object" />
      </div>
      {menu !== null && menuNode && (
        <div
          role="menu"
          aria-label={`Actions for ${menuNode.name}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setMenu(null);
          }}
          className="p3d-pop"
          style={{
            position: "fixed",
            left: Math.min(menu.x, window.innerWidth - 200),
            top: Math.min(menu.y, window.innerHeight - 180),
            minWidth: 180,
          }}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              setMenu(null);
              selection.select(menuNode.id);
              gizmoMode.requestFrame();
            }}
            className="p3d-menu-item"
          >
            Frame
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void duplicate(menuNode.id);
            }}
            className="p3d-menu-item"
          >
            Duplicate
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              setConfirmDeleteId(menuNode.id);
            }}
            className="p3d-menu-item"
          >
            Delete
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void toggleVisible(menuNode.id, !menuNode.visible);
            }}
            className="p3d-menu-item"
          >
            {menuNode.visible ? "Hide" : "Show"}
          </button>
        </div>
      )}
      {confirmNode && (
        <ConfirmDialog
          title={`Delete “${confirmNode.name}”?`}
          body="This removes that node and anything parented under it."
          confirmLabel="Delete"
          onConfirm={() => void confirmDelete(confirmNode.id)}
          onCancel={() => {
            // 0-C: record the outcome BEFORE clearing the id.
            if (lastConfirmRef.current) {
              lastConfirmRef.current.confirmed = false;
            }
            setConfirmDeleteId(null);
          }}
        />
      )}
    </div>
  );
}


/** The muted right-hand summary of a row: "Cone", "Sun light", "3 items". */
function rowSummary(node: NodeSpec, nodes: NodeSpec[]): string {
  if (node.kind === "group" || node.kind === "model") {
    const n = nodes.filter((c) => c.parent === node.id).length;
    if (n > 0) return n === 1 ? "1 item" : `${n} items`;
  }
  return kindWords(node);
}
