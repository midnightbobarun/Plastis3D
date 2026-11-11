// src/editor/sceneActions.ts — shared scene mutations for the editor
// chrome (Stage 5, PR5).
//
// One place for the PATCH shapes the outliner, inspector, keybindings,
// and scene picker all send, so a fix lands once. Every function takes
// the scene's id + revision and returns the post-mutation envelope (the
// shared query record refetches from the broadcast anyway; the envelope
// is for the caller to find new ids). Failures throw ApiError; callers
// toast with toastForCode (context "edit" unless the call is a gizmo
// drag, which this file never sends).

import { host } from "@hermes/plugin-sdk";
import { createScene, patchScene } from "../api";
import type { PatchOp, RestFn } from "../api";
import { ApiError } from "../api";
import { toastForCode } from "../copy";
import type { Toast } from "../copy";
import type { NodeSpec, SceneEnvelope } from "../types";
import { buildSample, type SampleName } from "../samples";
import { buildSnowman } from "./buildSnowman";
import { setEditorSceneId } from "../state/activeScene";
import { announce } from "../state/announcer";
import { invalidateSceneData } from "../state/sceneQuery";

/** The scene identity a mutation needs: id + the revision it is based on. */
export interface SceneRef {
  id: string;
  revision: number;
}

/** Toast through host.notify (the ui-design toast channel). */
export function notifyToast(toast: Toast): void {
  // G-06: the toast text announces through the live region too — the
  // region is the screen-reader channel, the toast the visual one;
  // both fire from this same call site, the text once.
  announce(toast.message);
  host.notify({ kind: toast.kind, message: toast.message });
}

/** Map a thrown error to its toast and notify. Returns the toast. */
export function toastApiError(
  err: unknown,
  context: "drag" | "edit" = "edit",
): Toast {
  const toast = toastForCode(apiCodeOf(err), {
    context,
    serverMessage: err instanceof Error ? err.message : undefined,
    reason:
      err instanceof ApiError && typeof err.reason === "string"
        ? err.reason
        : undefined,
  });
  notifyToast(toast);
  return toast;
}

/** The gateway code of a thrown error, or SPEC_INVALID when unknown. */
export function apiCodeOf(err: unknown): string {
  if (err instanceof ApiError) return err.code;
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "SPEC_INVALID";
}

/** One PATCH (one history entry). */
export async function commitPatch(
  rest: RestFn,
  scene: SceneRef,
  ops: PatchOp[],
): Promise<SceneEnvelope> {
  return patchScene(rest, scene.id, scene.revision, ops);
}

/** All ids in the subtree rooted at `rootId` (root first, then children). */
export function subtreeIds(nodes: NodeSpec[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parent !== null) {
      const list = children.get(node.parent) ?? [];
      list.push(node.id);
      children.set(node.parent, list);
    }
  }
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const child of children.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

/**
 * Delete nodes: one delete_node op per selected root, in a single PATCH
 * (one history entry). Ids that are descendants of another selected id
 * are dropped — deleting the ancestor already removes them.
 */
export async function deleteNodes(
  rest: RestFn,
  scene: SceneRef,
  nodes: NodeSpec[],
  ids: string[],
): Promise<SceneEnvelope> {
  const selected = new Set(ids);
  const roots = ids.filter((id) => {
    let parent = nodes.find((n) => n.id === id)?.parent ?? null;
    while (parent !== null) {
      if (selected.has(parent)) return false;
      parent = nodes.find((n) => n.id === parent)?.parent ?? null;
    }
    return true;
  });
  return commitPatch(
    rest,
    scene,
    roots.map((id) => ({ op: "delete_node", id })),
  );
}

/**
 * Duplicate nodes: one duplicate_node op per selected node, in a single
 * PATCH (one history entry). The server names copies "<name> copy" and
 * mints their ids; the caller diffs the envelope against the ids it had
 * to find them.
 */
export async function duplicateNodes(
  rest: RestFn,
  scene: SceneRef,
  ids: string[],
): Promise<SceneEnvelope> {
  return commitPatch(
    rest,
    scene,
    ids.map((id) => ({ op: "duplicate_node", id })),
  );
}

/** Hide nodes: one update_node visible:false per id, in a single PATCH. */
export async function hideNodes(
  rest: RestFn,
  scene: SceneRef,
  ids: string[],
): Promise<SceneEnvelope> {
  return commitPatch(
    rest,
    scene,
    ids.map((id) => ({ op: "update_node", id, visible: false })),
  );
}

/** Set one node's visibility. */
export async function setNodeVisible(
  rest: RestFn,
  scene: SceneRef,
  id: string,
  visible: boolean,
): Promise<SceneEnvelope> {
  return commitPatch(rest, scene, [{ op: "update_node", id, visible }]);
}

/**
 * Toggle visibility per selected node (E-06, D-PLAN-05): one
 * `update_node` op per id with `visible` flipped per node, in a single
 * PATCH (one history entry). H twice restores the exact prior state,
 * including mixed selections. An id missing from `visibleById` is
 * treated as visible (flipped to hidden).
 */
export async function toggleNodesVisibility(
  rest: RestFn,
  scene: SceneRef,
  ids: string[],
  visibleById: Map<string, boolean>,
): Promise<SceneEnvelope> {
  return commitPatch(
    rest,
    scene,
    ids.map((id) => ({
      op: "update_node",
      id,
      visible: !(visibleById.get(id) ?? true),
    })),
  );
}

/**
 * Reparent one node (drop on a row -> that row's id; drop on the panel
 * background -> null). A cycle comes back as SPEC_INVALID from the
 * server; the caller toasts it and the row stays where it was (no
 * optimistic move is ever applied).
 */
export async function reparentNode(
  rest: RestFn,
  scene: SceneRef,
  id: string,
  parent: string | null,
  transform?: import("../types").Transform | null,
): Promise<SceneEnvelope> {
  return commitPatch(rest, scene, [{ op: "update_node", id, parent, ...(transform ? { transform } : {}) }]);
}

/** Rename one node. */
export async function renameNode(
  rest: RestFn,
  scene: SceneRef,
  id: string,
  name: string,
): Promise<SceneEnvelope> {
  return commitPatch(rest, scene, [{ op: "update_node", id, name }]);
}

/**
 * Create-then-import, first half (D-PLAN-04): create an "Untitled"
 * scene and select it, so the caller can open the Import dialog on
 * it. Returns the new scene id, or null when the create failed (the
 * failure is toasted; there is no scene to import into). The caller
 * opens the Import dialog its own way — the Scenes / viewport panes
 * via the pending dialog + navigate, the editor via its local dialog
 * state — because only the surface knows how it opens dialogs.
 */
export async function createUntitledScene(
  rest: RestFn,
  sourceKey: string,
): Promise<string | null> {
  let created: SceneEnvelope;
  try {
    created = await createScene(rest, "Untitled");
  } catch (err) {
    toastApiError(err, "edit");
    return null;
  }
  setEditorSceneId(sourceKey, created.scene.id);
  invalidateSceneData(sourceKey);
  return created.scene.id;
}

/**
 * Build a sample snowman in one click (0-D / E-02): POST /scenes
 * `{ name: "Snowman" }`, then PATCH `build` with the canned snowman
 * spec + the new scene's revision, then select the new scene. On build
 * failure after a successful create, select the new scene anyway and
 * toast the mapped code (same rule as the scene-picker Duplicate
 * flow). Returns the post-build envelope, or null when anything failed
 * (the create failure toasts and returns null; there is no scene to
 * select then).
 */
export async function buildSampleSnowman(
  rest: RestFn,
  sourceKey: string,
  sample: SampleName = "Snowman",
): Promise<SceneEnvelope | null> {
  let created: SceneEnvelope;
  try {
    created = await createScene(rest, sample);
  } catch (err) {
    toastApiError(err, "edit");
    return null;
  }
  setEditorSceneId(sourceKey, created.scene.id);
  invalidateSceneData(sourceKey);
  const spec = sample === "Snowman" ? buildSnowman() : buildSample(sample);
  try {
    return await patchScene(rest, created.scene.id, created.scene.revision, [
      { op: "build", nodes: spec.nodes, materials: spec.materials },
    ]);
  } catch (err) {
    // The scene exists (empty rig): it is already selected above, so
    // just toast the mapped code.
    toastApiError(err, "edit");
    return null;
  }
}

/**
 * Update one node's fields (transform / light / camera / primitive
 * partials merge server-side). `fields` is spread into the update_node
 * op alongside the id.
 */
export async function updateNodeFields(
  rest: RestFn,
  scene: SceneRef,
  id: string,
  fields: Record<string, unknown>,
): Promise<SceneEnvelope> {
  return commitPatch(rest, scene, [{ op: "update_node", id, ...fields }]);
}
