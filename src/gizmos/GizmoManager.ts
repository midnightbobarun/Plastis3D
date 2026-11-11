import { getViewPrefs } from "../state/viewPrefs";
// src/gizmos/GizmoManager.ts — TransformControls integration (Stage 5, PR5).
//
// One manager per Viewport surface. It owns the TransformControls
// instance (its helper is added to the Three.js scene), the drag
// lifecycle, and the pointer-up commit:
//
//   - Modes come from the gizmoMode store (translate/rotate/scale;
//     select = no handles). With more than one node selected the gizmo
//     stays in translate mode — enforced here, not just in the toolbar
//     (PR5 decision 1): a translate drag applies the same world-space
//     translation delta to every selected node.
//   - On gizmo mouseDown: setGizmoDragging(true), disable OrbitControls,
//     capture baseRevision + the pointer-down local transform (and world
//     position) of every selected node. On mouseUp: re-enable
//     OrbitControls and emit exactly ONE patchScene with one update_node
//     op per selected node = one history entry. A drag that moved nothing
//     emits no PATCH at all.
//   - During a translate drag the other selected nodes preview-move with
//     the primary (objectChange applies the primary's world delta to
//     each); rotate/scale are single-node only.
//   - 409 REVISION_CONFLICT: discard the drag (restore pointer-down
//     transforms), invalidateSceneData (refetch), toast conflictDrag
//     via host.notify + toastForCode(context:"drag"). Any other PATCH
//     failure restores the drag the same way and toasts the mapped code.
//   - Escape during the drag (the manager attaches the Escape keydown
//     listener while a drag is down and removes it on drag end):
//     restore the pointer-down transform, write nothing, refetch if a
//     revision arrived during the drag.
//   - Slow PATCH (> 1 s in flight): the preview stays and the
//     "committing" flag flips (the ViewportPane shows the spinner on
//     its stats line while it is set).
//   - setGizmoDragging(false) + flushDeferredFocus() run on every exit
//     path (commit success, conflict, other failure, no-op, Escape).
//
// After a directional-light commit the light's target stays parented
// at local (0, 0, -1) — build.ts parents it there and the manager never
// calls lookAt; the stored Euler is what is committed (read back from
// the dragged object's quaternion). Part nodes attach exactly as mesh
// nodes: the manager only ever sees Object3Ds from the built map.
//
// This module does NOT import @hermes/plugin-sdk (the pure helpers are
// Vitest-testable in Node): notify/invalidate are constructor options
// the Viewport binds to host.notify / invalidateSceneData.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { ApiError, patchScene } from "../api";
import type { PatchOp, RestFn } from "../api";
import { toastForCode } from "../copy";
import { flushDeferredFocus } from "../state/editorFocus";
import { setGizmoDragging } from "../state/dragLock";
import type { SelectionSnapshot } from "../state/selection";
import type { GizmoMode } from "./gizmoMode";
import type { SceneSpec } from "../types";

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
/** A PATCH in flight longer than this shows the stats-line spinner. */
const SLOW_PATCH_MS = 1000;
/** Two transforms closer than this count as unmoved (no PATCH). */
const TRANSFORM_EPSILON = 1e-9;

// --- pure helpers (Vitest-tested; no DOM, no SDK) ---------------------------

/** A node's local transform as plain degree/vector triples. */
export interface LocalTransform {
  t: [number, number, number];
  r: [number, number, number];
  s: [number, number, number];
}

/** Read a node's current local transform (Euler XYZ degrees). */
export function captureLocal(obj: THREE.Object3D): LocalTransform {
  const euler = new THREE.Euler().setFromQuaternion(obj.quaternion, "XYZ");
  return {
    t: [obj.position.x, obj.position.y, obj.position.z],
    r: [euler.x * RAD_TO_DEG, euler.y * RAD_TO_DEG, euler.z * RAD_TO_DEG],
    s: [obj.scale.x, obj.scale.y, obj.scale.z],
  };
}

/** Write a local transform back onto a node (Euler XYZ degrees). */
export function applyLocal(obj: THREE.Object3D, transform: LocalTransform): void {
  obj.position.set(transform.t[0], transform.t[1], transform.t[2]);
  obj.rotation.set(
    transform.r[0] * DEG_TO_RAD,
    transform.r[1] * DEG_TO_RAD,
    transform.r[2] * DEG_TO_RAD,
    "XYZ",
  );
  obj.scale.set(transform.s[0], transform.s[1], transform.s[2]);
}

/** A quaternion as Euler XYZ degrees. */
export function quaternionToEulerDegrees(
  quaternion: THREE.Quaternion,
): [number, number, number] {
  const euler = new THREE.Euler().setFromQuaternion(quaternion, "XYZ");
  return [euler.x * RAD_TO_DEG, euler.y * RAD_TO_DEG, euler.z * RAD_TO_DEG];
}

/**
 * Convert a world-space position to `obj`'s local position (via the
 * parent's world matrix; the world position itself when unparented).
 * The caller must have updated the scene's matrixWorld first.
 */
export function worldPositionToLocal(
  obj: THREE.Object3D,
  worldPos: THREE.Vector3,
): THREE.Vector3 {
  const parent = obj.parent;
  if (!parent) return worldPos.clone();
  return parent.worldToLocal(worldPos.clone());
}

/** True when two local transforms agree on all nine components. */
export function transformsEqual(
  a: LocalTransform,
  b: LocalTransform,
  epsilon = TRANSFORM_EPSILON,
): boolean {
  for (let i = 0; i < 3; i++) {
    if (
      Math.abs(a.t[i] - b.t[i]) > epsilon ||
      Math.abs(a.r[i] - b.r[i]) > epsilon ||
      Math.abs(a.s[i] - b.s[i]) > epsilon
    ) {
      return false;
    }
  }
  return true;
}

// --- manager -----------------------------------------------------------------

export interface GizmoManagerOptions {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  orbit: OrbitControls;
  rest: RestFn;
  /** The current scene spec (revision is captured at drag start). */
  getScene: () => SceneSpec;
  getSelection: () => SelectionSnapshot;
  getBuiltNodes: () => Map<string, THREE.Object3D> | null;
  getMode: () => GizmoMode;
  /** Bound to host.notify by the Viewport. */
  notify: (kind: "info" | "warning", message: string) => void;
  /** Bound to invalidateSceneData(sourceKey, sceneId) by the Viewport. */
  invalidate: () => void;
  /** The ViewportPane's committing flag (stats-line spinner). */
  onCommittingChange: (committing: boolean) => void;
  /** The Viewport refetches if a revision arrived during the drag. */
  onDragEnd: () => void;
}

export class GizmoManager {
  private readonly controls: TransformControls;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly orbit: OrbitControls;
  private readonly opts: GizmoManagerOptions;

  private target: THREE.Object3D | null = null;
  private primaryId: string | null = null;
  private selectedIds: string[] = [];
  private storeMode: GizmoMode = "select";

  private dragActive = false;
  private baseRevision = 0;
  private sceneId = "";
  private startTransforms = new Map<string, LocalTransform>();
  private startWorldPositions = new Map<string, THREE.Vector3>();
  private primaryStartWorld: THREE.Vector3 | null = null;
  private pendingTarget: {
    obj: THREE.Object3D | null;
    ids: string[];
  } | null = null;

  private committing = false;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: GizmoManagerOptions) {
    this.opts = opts;
    this.scene = opts.scene;
    this.camera = opts.camera;
    this.domElement = opts.domElement;
    this.orbit = opts.orbit;
    this.storeMode = opts.getMode();

    this.controls = new TransformControls(this.camera, this.domElement);
    // Snap stays off in 0.1.0 (ui-design-first-draft §Gizmo).
    this.controls.translationSnap = null;
    this.controls.rotationSnap = null;
    this.controls.scaleSnap = null;
    this.scene.add(this.controls.getHelper());

    this.controls.addEventListener("mouseDown", this.handleMouseDown);
    this.controls.addEventListener("mouseUp", this.handleMouseUp);
    this.controls.addEventListener("objectChange", this.handleObjectChange);
    window.addEventListener("pointerup", this.handleWindowPointerUp);
  }

  /** True while a gizmo handle is held down. */
  isDragging(): boolean {
    return this.dragActive;
  }

  /** The effective mode (multi-select forces translate; no target means select). */
  getEffectiveMode(): GizmoMode {
    return this.effectiveMode;
  }

  /** The effective mode: multi-select forces translate (PR5 decision 1). */
  private get effectiveMode(): GizmoMode {
    if (!this.target || this.selectedIds.length === 0) return "select";
    if (this.selectedIds.length > 1) return "translate";
    return this.storeMode;
  }

  /** Attach the gizmo to `obj` (or detach) for the given selection. */
  setTarget(obj: THREE.Object3D | null, ids: string[]): void {
    if (this.dragActive) {
      // A selection change mid-drag applies after the drag ends, so the
      // commit still uses the pointer-down selection.
      this.pendingTarget = { obj, ids };
      return;
    }
    this.target = obj;
    this.primaryId = ids.length > 0 ? ids[ids.length - 1] : null;
    this.selectedIds = [...ids];
    this.applyMode();
  }

  /** The gizmo mode from the store (effective mode is enforced here). */
  setMode(mode: GizmoMode): void {
    this.storeMode = mode;
    if (!this.dragActive) this.applyMode();
  }

  private applyMode(): void {
    const mode = this.effectiveMode;
    if (mode === "select" || !this.target) {
      this.controls.detach();
      return;
    }
    this.controls.attach(this.target);
    this.controls.setMode(mode);
  }

  /**
   * The screen position (client coordinates) of one translate handle,
   * for the harness drag test: the picker mesh for `axis` in the
   * current mode, projected through the camera. Null when no gizmo is
   * attached or the handle cannot be found.
   */
  getHandleScreenPosition(axis: "X" | "Y" | "Z"): { x: number; y: number } | null {
    if (!this.target) return null;
    this.scene.updateMatrixWorld(true);
    const helper = this.controls.getHelper();
    let pickerGroup: THREE.Object3D | null = null;
    for (const child of helper.children) {
      const maybe = child as unknown as {
        picker?: Record<string, THREE.Object3D>;
      };
      if (maybe.picker && maybe.picker[this.controls.mode]) {
        pickerGroup = maybe.picker[this.controls.mode];
        break;
      }
    }
    if (!pickerGroup) return null;
    const found: THREE.Object3D[] = [];
    pickerGroup.traverse((obj) => {
      if (obj.name === axis) found.push(obj);
    });
    // The handle's screen position is the centre of its picker's
    // baked geometry, NOT the mesh position: TransformControls'
    // setupGizmo bakes each handle's position/rotation into its
    // geometry and resets the mesh position to (0, 0, 0), so
    // getWorldPosition() on the mesh returns the gizmo origin (the
    // XYZ centre handle) for every axis. The X picker has two meshes
    // (+0.3 and -0.3); take the one furthest along the axis so the
    // point is the arrow tip end, clear of the centre handle.
    let best: THREE.Vector3 | null = null;
    let bestAlong = -Infinity;
    const axisIndex = axis === "X" ? 0 : axis === "Y" ? 1 : 2;
    for (const obj of found) {
      const mesh = obj as THREE.Mesh;
      const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
      if (!geometry) continue;
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      if (!bounds) continue;
      const center = bounds.getCenter(new THREE.Vector3());
      const along = center.getComponent(axisIndex);
      if (along > bestAlong) {
        bestAlong = along;
        best = center.applyMatrix4(mesh.matrixWorld);
      }
    }
    if (!best) return null;
    const projected = best.clone().project(this.camera);
    const rect = this.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
    };
  }

  /** The TransformControls helper (view-only objects the stage hides
   *  from its contact-shadow pass, PR32). */
  forEachHelper(fn: (helper: THREE.Object3D) => void): void {
    fn(this.controls.getHelper());
  }

  dispose(): void {
    this.controls.removeEventListener("mouseDown", this.handleMouseDown);
    this.controls.removeEventListener("mouseUp", this.handleMouseUp);
    this.controls.removeEventListener("objectChange", this.handleObjectChange);
    window.removeEventListener("pointerup", this.handleWindowPointerUp);
    window.removeEventListener("keydown", this.handleKeyDown);
    this.clearCommitTimer();
    this.controls.detach();
    this.controls.dispose();
    this.scene.remove(this.controls.getHelper());
  }

  // --- drag lifecycle ----------------------------------------------------------

  private handleMouseDown = (): void => {
    if (this.dragActive) return;
    const target = this.target;
    if (!target) return;
    const scene = this.opts.getScene();
    this.scene.updateMatrixWorld(true);
    this.dragActive = true;
    this.baseRevision = scene.revision;
    this.sceneId = scene.id;
    this.startTransforms = new Map();
    this.startWorldPositions = new Map();
    const nodes = this.opts.getBuiltNodes();
    for (const id of this.selectedIds) {
      const obj = nodes?.get(id);
      if (!obj) continue;
      this.startTransforms.set(id, captureLocal(obj));
      this.startWorldPositions.set(id, obj.getWorldPosition(new THREE.Vector3()));
    }
    this.primaryStartWorld =
      this.primaryId !== null
        ? (this.startWorldPositions.get(this.primaryId) ?? null)
        : null;
    const snap = getViewPrefs();
    this.controls.translationSnap = snap.snap ? snap.snapMove : null;
    this.controls.rotationSnap = snap.snap ? snap.snapRotate * Math.PI / 180 : null;
    this.controls.scaleSnap = snap.snap ? snap.snapScale : null;
    setGizmoDragging(true);
    this.orbit.enabled = false;
    window.addEventListener("keydown", this.handleKeyDown);
  };

  private handleMouseUp = (): void => {
    if (!this.dragActive) return;
    void this.finishDrag();
  };

  /**
   * Safety net for a pointer release TransformControls missed (release
   * outside the canvas): finish the drag. The control's own pointerUp
   * runs first (target/document phase, before this window bubble
   * listener), so in the normal case dragActive is already false and
   * this is a no-op — finishDrag is guarded by dragActive.
   */
  private handleWindowPointerUp = (): void => {
    if (!this.dragActive) return;
    void this.finishDrag();
  };

  private handleObjectChange = (): void => {
    if (!this.dragActive) return;
    if (this.selectedIds.length < 2) return;
    if (this.effectiveMode !== "translate") return;
    const primary = this.target;
    const startWorld = this.primaryStartWorld;
    if (!primary || !startWorld) return;
    const delta = primary
      .getWorldPosition(new THREE.Vector3())
      .sub(startWorld);
    if (delta.lengthSq() < 1e-18) return;
    const nodes = this.opts.getBuiltNodes();
    for (const id of this.selectedIds) {
      if (id === this.primaryId) continue;
      const obj = nodes?.get(id);
      const start = this.startWorldPositions.get(id);
      if (!obj || !start) continue;
      const local = worldPositionToLocal(obj, start.clone().add(delta));
      obj.position.copy(local);
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (!this.dragActive) return;
    this.cancelDrag();
  };

  /** Escape: restore the pointer-down transform, write nothing. */
  private cancelDrag(): void {
    if (!this.dragActive) return;
    this.dragActive = false;
    window.removeEventListener("keydown", this.handleKeyDown);
    this.orbit.enabled = true;
    this.restoreStartTransforms();
    setGizmoDragging(false);
    flushDeferredFocus();
    this.applyPendingTarget();
    this.opts.onDragEnd();
  }

  private restoreStartTransforms(): void {
    const nodes = this.opts.getBuiltNodes();
    for (const [id, transform] of this.startTransforms) {
      const obj = nodes?.get(id);
      if (obj) applyLocal(obj, transform);
    }
  }

  private applyPendingTarget(): void {
    if (!this.pendingTarget) return;
    const pending = this.pendingTarget;
    this.pendingTarget = null;
    this.target = pending.obj;
    this.primaryId =
      pending.ids.length > 0 ? pending.ids[pending.ids.length - 1] : null;
    this.selectedIds = [...pending.ids];
    this.applyMode();
  }

  /** Pointer-up commit: exactly one PATCH, one history entry. */
  private async finishDrag(): Promise<void> {
    if (!this.dragActive) return;
    this.dragActive = false;
    window.removeEventListener("keydown", this.handleKeyDown);
    this.orbit.enabled = true;

    const ops: PatchOp[] = [];
    try {
      this.scene.updateMatrixWorld(true);
      if (this.effectiveMode === "translate") {
        const primary = this.target;
        const startWorld = this.primaryStartWorld;
        if (primary && startWorld) {
          const delta = primary
            .getWorldPosition(new THREE.Vector3())
            .sub(startWorld);
          const nodes = this.opts.getBuiltNodes();
          for (const id of this.selectedIds) {
            const obj = nodes?.get(id);
            const start = this.startTransforms.get(id);
            const startW = this.startWorldPositions.get(id);
            if (!obj || !start || !startW) continue;
            const local = worldPositionToLocal(
              obj,
              startW.clone().add(delta),
            );
            const transform: LocalTransform = {
              t: [local.x, local.y, local.z],
              r: [start.r[0], start.r[1], start.r[2]],
              s: [start.s[0], start.s[1], start.s[2]],
            };
            if (!transformsEqual(transform, start)) {
              ops.push({ op: "update_node", id, transform });
            }
          }
        }
      } else if (
        this.effectiveMode === "rotate" ||
        this.effectiveMode === "scale"
      ) {
        // Single-node only (multi-select forces translate above).
        const obj = this.target;
        const start =
          this.primaryId !== null
            ? this.startTransforms.get(this.primaryId)
            : undefined;
        if (obj && start && this.primaryId !== null) {
          const transform = captureLocal(obj);
          if (!transformsEqual(transform, start)) {
            ops.push({ op: "update_node", id: this.primaryId, transform });
          }
        }
      }
    } catch {
      // A math failure must not leave a drag half-finished: restore and
      // end the drag without writing.
      this.restoreStartTransforms();
      setGizmoDragging(false);
      flushDeferredFocus();
      this.applyPendingTarget();
      this.opts.onDragEnd();
      return;
    }

    if (ops.length === 0) {
      // Nothing moved: no PATCH, no history entry.
      setGizmoDragging(false);
      flushDeferredFocus();
      this.applyPendingTarget();
      this.opts.onDragEnd();
      return;
    }

    this.armSlowPatchTimer();
    try {
      await patchScene(this.opts.rest, this.sceneId, this.baseRevision, ops);
      // Success: adopt the response (refetch) and leave the gizmo put.
      this.opts.invalidate();
    } catch (err) {
      const code =
        err instanceof ApiError
          ? err.code
          : "REST_FAILED";
      const serverMessage = err instanceof Error ? err.message : undefined;
      if (code === "REVISION_CONFLICT") {
        // Discard the drag, refetch, toast conflictDrag.
        this.restoreStartTransforms();
        this.opts.invalidate();
        const toast = toastForCode(code, { context: "drag" });
        this.opts.notify(toast.kind, toast.message);
      } else {
        this.restoreStartTransforms();
        const toast = toastForCode(code, {
          context: "drag",
          serverMessage,
        });
        this.opts.notify(toast.kind, toast.message);
      }
    } finally {
      this.clearCommitTimer();
      if (this.committing) {
        this.committing = false;
        this.opts.onCommittingChange(false);
      }
      setGizmoDragging(false);
      flushDeferredFocus();
      this.applyPendingTarget();
      this.opts.onDragEnd();
    }
  }

  private armSlowPatchTimer(): void {
    this.clearCommitTimer();
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.committing = true;
      this.opts.onCommittingChange(true);
    }, SLOW_PATCH_MS);
  }

  private clearCommitTimer(): void {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer);
      this.commitTimer = null;
    }
  }
}
