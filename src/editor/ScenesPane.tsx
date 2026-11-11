// src/editor/ScenesPane.tsx — the Scenes pane (Stage 4, PR4 §4.2).
//
// Lists scenes via listScenes through the shared query cache (the same
// store the viewport reads from — one record per source, one fetch no
// matter how many surfaces subscribe). Clicking a scene sets the active
// scene for this source (shared with the viewport through
// src/state/activeScene.ts). List only: NO renderer here, so this pane
// stays fully usable when WebGL2 is unavailable.

import { useEffect, useState } from "react";
import {
  Button,
  ErrorState,
  gatewayActivationEpoch,
  host,
  Skeleton,
  useValue,
} from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import {
  getEditorSceneId,
  setAvailableScenes,
  setEditorSceneId,
  setPaneSceneId,
  useActiveSceneId,
} from "../state/activeScene";
import { Icon } from "../ui/icons";
import { SceneTile } from "../ui/SceneTile";
import { filterScenes } from "../state/thumbnails";
import { useSceneList } from "../state/sceneQuery";
import { createUntitledScene } from "./sceneActions";
import { NoSceneEmptyState } from "./NoSceneEmptyState";
import { setPendingDialog } from "./pendingDialog";

export interface ScenesPaneProps {
  ctx: PluginContext;
  sourceKey: string;
}

export function ScenesPane({ ctx, sourceKey }: ScenesPaneProps) {
  const rest = ctx.rest as unknown as RestFn;
  const visible = useValue(host.paneVisibility("plastis3d:scenes"));
  const list = useSceneList(sourceKey, { eligible: visible });
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (list.data) {
      setAvailableScenes(
        sourceKey,
        list.data.map((s) => s.id),
      );
    }
  }, [sourceKey, list.data]);

  // Row 14 (redesign §1.1, D-PR32-02): the highlight is the scene the
  // user is looking at — the editor's while the editor route is open,
  // else this pane's. A click while the editor is open opens that scene
  // in the editor (and the 3D pane follows), so the two never disagree.
  const activeId = useActiveSceneId(sourceKey);

  function pick(id: string): void {
    setPaneSceneId(sourceKey, id);
    if (getEditorSceneId(sourceKey) !== null) {
      setEditorSceneId(sourceKey, id);
      host.navigate(`/plastis3d?scene=${id}`);
    }
  }

  function openNew(e: React.MouseEvent<HTMLButtonElement>): void {
    setPendingDialog({
      kind: "new",
      sourceKey,
      epoch: gatewayActivationEpoch(),
      invoker: e.currentTarget,
    });
    host.navigate("/plastis3d");
  }

  // Import with no scene at all (D-PLAN-04): create the "Untitled"
  // scene Import needs, then open the Import dialog on it via the
  // pending dialog + navigate. It never toasts `createFirst`.
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

  // G-12: list loading keeps the list chrome (the "Scenes" header row
  // with New) and shows a skeleton row area — the pane does not pop
  // in. The error and empty branches still early-return (G-14 owns
  // the error branch).
  const listLoading = list.status === "loading" && !list.data;

  // G-14: a store failure is the host ErrorState (storeTitle /
  // storeBody), never plain text echoing the raw server message.
  // "Try again" refetches the scene list. The description is
  // storeRetry once a list GET previously succeeded in this session.
  // The branch also fires when the list record is exhausted (two
  // consecutive failed polls with last good data in hand).
  if ((list.status === "error" && !list.data) || list.storeExhausted) {
    return (
      <div className="p3d-root p3d-scenes" style={{ padding: 12 }}>
        <ErrorState title={COPY.storeTitle} description={COPY[list.storeSentence]}>
          <Button variant="outline" onClick={() => list.refetch()}>
            Try again
          </Button>
        </ErrorState>
      </div>
    );
  }

  if (!listLoading && (!list.data || list.data.length === 0)) {
    return (
      <div className="p3d-root p3d-scenes" style={{ overflow: "auto" }}>
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

  return (
    <div className="p3d-root p3d-scenes">
      <div className="p3d-scenes-head">
        <span className="p3d-scenes-title">Scenes</span>
        <button
          type="button"
          className="p3d-btn p3d-btn--sm"
          title="Start a new, empty scene"
          aria-label="New"
          onClick={openNew}
        >
          <Icon name="plus" size={15} />
          New
        </button>
      </div>
      {(list.data?.length ?? 0) > 5 && (
        <div style={{ padding: "0 12px 8px" }}>
          <input
            type="search"
            className="p3d-input"
            aria-label="Search scenes"
            placeholder="Search scenes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%" }}
          />
        </div>
      )}
      <ul className="p3d-scene-list">
        {listLoading ? (
          <>
            {[0, 1, 2].map((i) => (
              <li key={i} style={{ padding: "8px" }}>
                <Skeleton style={{ height: 40, borderRadius: 10 }} aria-label="Loading scenes" />
              </li>
            ))}
          </>
        ) : (
          filterScenes(list.data ?? [], query).map((scene) => {
            const active = scene.id === activeId;
            return (
              <li key={scene.id}>
                <button
                  type="button"
                  className="p3d-scene-row"
                  data-active={active ? "true" : "false"}
                  aria-current={active ? "true" : undefined}
                  title={`${scene.name} — revision ${scene.revision}`}
                  onClick={() => pick(scene.id)}
                >
                  <SceneTile rest={rest} sourceKey={sourceKey} sceneId={scene.id} name={scene.name} revision={scene.thumbnailRevision} size={34} radius={9} font={14} />
                  <span className="p3d-scene-text">
                    <span className="p3d-scene-name" style={{ display: "block" }}>{scene.name}</span>
                    <span className="p3d-scene-meta" style={{ display: "block" }}>
                      {relativeTime(scene.updatedAt)}
                      <span className="p3d-sr"> · rev {scene.revision}</span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>
      {query.trim() !== "" && filterScenes(list.data ?? [], query).length === 0 && (
        <div className="p3d-help" role="status" style={{ padding: "6px 12px" }}>No scene matches “{query.trim()}”.</div>
      )}
      {list.stale && (
        <div className="p3d-help" style={{ flex: "0 0 auto", padding: "6px 12px" }}>
          Updating…
        </div>
      )}
    </div>
  );
}

export { relativeTime, sceneHue } from "../ui/format";
import { relativeTime, sceneHue } from "../ui/format";
