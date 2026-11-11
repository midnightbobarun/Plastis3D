// src/viewport/editSession.ts — one mesh edit session (PR24, D-EXT-07).
//
// The session works on an in-memory COPY of the node's mesh. The real object is hidden, the
// copy is drawn in its place with the vertex, edge and face overlays, and everything the user
// does (pick, move, rotate, scale, extrude, delete faces, flip normals) changes only the copy.
// Mod+Z / Mod+Shift+Z undo local steps. Leaving the mode bakes ONCE (one asset, one history
// entry, "Edit mesh"). A crash-safe draft is written about every two minutes while there are
// unsaved changes, and when the window is hidden. A bake that conflicts discards the session.
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { ApiError, bakeMesh, deleteDraft, getDraft, putDraft } from "../api";
import type { MeshDraft, RestFn } from "../api";
import { COPY } from "../copy";
import { setGizmoDragging } from "../state/dragLock";
import type { BrushState, EditCommand, EditModeStore, EditTool } from "../state/editMode";
import { applyBrush, sculptContext } from "../scene/sculpt/brushes";
import type { BrushSettings, SculptContext } from "../scene/sculpt/brushes";
import { ensureColors, fillColor, hexToColor, paintDab } from "../scene/paint";
import type { GizmoMode } from "../gizmos/gizmoMode";
import { decodeMesh, encodeMesh } from "../scene/bake";
import {
  buildTopology, centroidOf, cloneMesh, deleteFaces, extrudeFaces, faceRegion, flipFaces, MAX_EDIT_TRIANGLES,
  recomputeNormals, splitEdges, triangleCount, verticesOf,
} from "../scene/meshEdit";
import type { EditMesh, PickMode, Topology } from "../scene/meshEdit";
import { accelerate, disposeAccelerated, FRAME_BUDGET_MS, geometryOf, marquee, nearestEdge, nearestWeld, pickFace, refit } from "../scene/picking";
import type { NodeSpec, SceneSpec } from "../types";

export const DRAFT_INTERVAL_MS = 2 * 60 * 1000;
const HISTORY_LIMIT = 30;
/** Sculpt and paint steps are strokes: up to 100, fewer on a big mesh so the snapshots stay under about 192 MB. */
const STROKE_HISTORY = 100;
const STROKE_MEMORY_BYTES = 192 * 1024 * 1024;
const DAB_BUDGET_MS = 8;
const CLICK_PX = 5;
const ACCENT = 0xff8a1f;
const WIRE = 0x4a90ff;
const EXTRUDE_DISTANCE = 0.25;

/** The first mesh under a built node, with its edit copy in the node's own space. */
export function extractEditMesh(object: THREE.Object3D): { source: THREE.Mesh; mesh: EditMesh } | null {
  let source: THREE.Mesh | null = null;
  object.traverse((child) => { if (!source && (child as THREE.Mesh).isMesh && !child.userData.pickProxy && (child as THREE.Mesh).geometry) source = child as THREE.Mesh; });
  if (!source) return null;
  const found = source as THREE.Mesh;
  const geometry = found.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute("position");
  if (!position) return null;
  object.updateWorldMatrix(true, true);
  const relative = new THREE.Matrix4().copy(object.matrixWorld).invert().multiply(found.matrixWorld);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(relative);
  const count = position.count;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = geometry.getAttribute("uv") ? new Float32Array(count * 2) : null;
  const colorAttr = geometry.getAttribute("color");
  const colors = colorAttr ? new Float32Array(count * 4) : null;
  const v = new THREE.Vector3();
  const normal = geometry.getAttribute("normal");
  for (let i = 0; i < count; i++) {
    v.fromBufferAttribute(position, i).applyMatrix4(relative);
    positions.set([v.x, v.y, v.z], i * 3);
    if (normal) { v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize(); normals.set([v.x, v.y, v.z], i * 3); }
    if (uvs) uvs.set([geometry.getAttribute("uv").getX(i), geometry.getAttribute("uv").getY(i)], i * 2);
    if (colors && colorAttr) colors.set([colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i), colorAttr.itemSize > 3 ? colorAttr.getW(i) : 1], i * 4);
  }
  const index = geometry.getIndex();
  const indices = index ? Uint32Array.from(index.array as ArrayLike<number>) : Uint32Array.from({ length: count }, (_, i) => i);
  const mesh: EditMesh = { positions, normals, uvs, indices, colors };
  if (!normal) recomputeNormals(mesh, Array.from({ length: count }, (_, i) => i));
  return { source: found, mesh };
}

export interface EditSessionOptions {
  threeScene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  domElement: HTMLElement;
  orbit: OrbitControls;
  /** The element the marquee rectangle is drawn in. */
  mount: HTMLElement;
  store: EditModeStore;
  rest: RestFn;
  getScene: () => SceneSpec;
  getGizmoMode: () => GizmoMode;
  /** The built object for the node being edited. */
  object: THREE.Object3D;
  node: NodeSpec;
  mesh: EditMesh;
  startRevision: number;
  /** The tool the session starts in (default "mesh"). */
  tool?: EditTool;
  notify: (kind: "info" | "warn" | "error" | "success", message: string) => void;
  invalidate: () => void;
  onEnded: () => void;
  markDirtyShadow: () => void;
}

export class EditSession {
  private readonly o: EditSessionOptions;
  private mesh: EditMesh;
  private topology: Topology;
  private pick: PickMode;
  private selection = new Set<number>();
  private undoStack: EditMesh[] = [];
  private redoStack: EditMesh[] = [];
  private dirty = false;
  private ended = false;
  private busy = false;

  private readonly editMesh: THREE.Mesh;
  private readonly overlay = new THREE.Group();
  private readonly pivot = new THREE.Object3D();
  private readonly transform: TransformControls;
  private readonly marqueeBox: HTMLDivElement;
  private wire: THREE.LineSegments | null = null;
  private points: THREE.Points | null = null;
  private highlight: THREE.Object3D | null = null;
  private pointerDown: { x: number; y: number; shift: boolean; onHandle: boolean; marquee: boolean } | null = null;
  private dragStart: { positions: Float32Array; vertices: number[]; pivotInverse: THREE.Matrix4; before: EditMesh } | null = null;
  private draftTimer: ReturnType<typeof setInterval> | null = null;
  private rebuildQueued = false;
  private tool: EditTool = "mesh";
  private sculpt: SculptContext | null = null;
  private stroke: { before: EditMesh; last: THREE.Vector3 | null; center: THREE.Vector3 | null } | null = null;
  private readonly ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 65 }, (_, i) => new THREE.Vector3(Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2), 0))), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.9 }));
  private skipNext = false;
  lastDabMs = 0;
  /** Dabs applied this session (telemetry for the harness). */
  dabCount = 0;
  moveEvents = 0; moveHits = 0; strokeCount = 0; skippedDabs = 0;
  private draft: MeshDraft | null = null;
  private readonly cleanups: Array<() => void> = [];
  private readonly nodeWorld = new THREE.Matrix4();
  private readonly raycaster = new THREE.Raycaster();

  constructor(options: EditSessionOptions) {
    this.o = options;
    this.mesh = cloneMesh(options.mesh);
    this.topology = buildTopology(this.mesh);
    this.pick = options.store.getSnapshot().pick;
    this.tool = options.tool ?? "mesh";
    this.ring.visible = false;
    this.ring.renderOrder = 9;
    options.threeScene.add(this.ring);

    options.object.updateWorldMatrix(true, true);
    this.nodeWorld.copy(options.object.matrixWorld);

    // The editable copy replaces the real object visually.
    const material = this.copyMaterial(options.object);
    if (this.mesh.colors) (material as THREE.MeshStandardMaterial).vertexColors = true;
    this.editMesh = new THREE.Mesh(geometryOf(this.mesh), material);
    this.editMesh.matrixAutoUpdate = false;
    this.editMesh.matrix.copy(this.nodeWorld);
    this.editMesh.matrixWorldNeedsUpdate = true;
    this.editMesh.userData.editCopy = true;
    accelerate(this.editMesh);
    this.o.threeScene.add(this.editMesh);
    this.overlay.matrixAutoUpdate = false;
    this.overlay.matrix.copy(this.nodeWorld);
    this.o.threeScene.add(this.overlay);
    options.object.visible = false;
    this.o.threeScene.add(this.pivot);

    this.transform = new TransformControls(options.camera, options.domElement);
    this.transform.addEventListener("dragging-changed", (event) => {
      const dragging = Boolean((event as unknown as { value: boolean }).value);
      this.o.orbit.enabled = !dragging;
      setGizmoDragging(dragging);
      if (dragging) this.beginDrag(); else this.endDrag();
    });
    this.transform.addEventListener("objectChange", () => this.dragMoved());
    this.o.threeScene.add(this.transform.getHelper());

    this.marqueeBox = document.createElement("div");
    this.marqueeBox.style.cssText = "position:absolute;pointer-events:none;border:1px dashed #ff8a1f;background:rgba(255,138,31,.12);display:none;z-index:4";
    this.o.mount.appendChild(this.marqueeBox);

    const el = options.domElement;
    const down = (event: PointerEvent) => this.onPointerDown(event);
    const up = (event: PointerEvent) => this.onPointerUp(event);
    const move = (event: PointerEvent) => this.onPointerMove(event);
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointermove", move);
    this.cleanups.push(() => { el.removeEventListener("pointerdown", down, true); el.removeEventListener("pointerup", up); el.removeEventListener("pointermove", move); });
    const hidden = () => { if (document.visibilityState === "hidden") void this.writeDraft(); };
    document.addEventListener("visibilitychange", hidden);
    this.cleanups.push(() => document.removeEventListener("visibilitychange", hidden));
    this.draftTimer = setInterval(() => { void this.writeDraft(); }, DRAFT_INTERVAL_MS);

    this.rebuild();
    this.syncGizmo();
    this.publish();
    void this.offerRestore();
    // Telemetry for the harness, like the viewport's own __plastis3dViewport* globals: a scripted
    // gizmo drag of the selection (the pixel path is the TransformControls handle itself).
    (window as unknown as Record<string, unknown>).__plastis3dEdit = {
      moveSelection: (dx: number, dy: number, dz: number) => this.simulateMove(dx, dy, dz),
      scaleSelection: (factor: number) => this.simulateScale(factor),
      lastDragMs: () => this.lastDragMs,
      dabs: () => this.dabCount,
      events: () => ({ moves: this.moveEvents, hits: this.moveHits, strokes: this.strokeCount, skipped: this.skippedDabs }),
      tool: () => this.tool,
      lastPickMs: () => this.lastPickMs,
    };
  }

  /** A scripted drag: the same begin / move / end path the gizmo takes, by world offset. */
  private simulateMove(dx: number, dy: number, dz: number): void {
    if (!this.selection.size) return;
    this.syncGizmo();
    this.beginDrag();
    this.pivot.position.add(new THREE.Vector3(dx, dy, dz));
    this.dragMoved();
    this.endDrag();
  }

  private simulateScale(factor: number): void {
    if (!this.selection.size) return;
    this.syncGizmo();
    this.beginDrag();
    this.pivot.scale.setScalar(factor);
    this.dragMoved();
    this.endDrag();
  }

  // ---- state shown to the toolbar ----------------------------------------------------------
  private publish(): void {
    this.o.store.patch({
      active: true,
      busy: this.busy,
      pick: this.pick,
      nodeId: this.o.node.id,
      nodeName: this.o.node.name,
      selected: this.selection.size,
      dirty: this.dirty,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      tool: this.tool,
    });
  }

  private copyMaterial(object: THREE.Object3D): THREE.Material {
    let found: THREE.Material | null = null;
    object.traverse((child) => { const m = (child as THREE.Mesh).material; if (!found && m && !Array.isArray(m) && (child as THREE.Mesh).isMesh) found = m; });
    return found ? (found as THREE.Material).clone() : new THREE.MeshStandardMaterial({ color: 0xcccccc });
  }

  // ---- commands ------------------------------------------------------------------------------
  /** Commands arrive from the Viewport's one dispatcher (the toolbar and the key map). */
  async handle(command: EditCommand): Promise<void> {
    if (this.ended || (this.busy && command.type !== "confirm")) return;
    switch (command.type) {
      case "toggle": return this.finish(true);
      case "cancel": return this.finish(false);
      case "pick": this.setPick(command.mode); return;
      case "extrude": return this.extrude();
      case "delete": return this.deleteSelected();
      case "flip": return this.flipSelected();
      case "seam": return this.markSeam();
      case "tool": return this.setTool(command.tool);
      case "brush": this.o.store.patch({ brush: { ...this.o.store.getSnapshot().brush, ...command.patch } }); return;
      case "fill": return this.fillPaint();
      case "undo": return this.stepHistory(-1);
      case "redo": return this.stepHistory(1);
      case "restore": return this.restoreDraft();
      case "discard": return this.discardDraft();
      case "confirm": this.confirmResolver?.(command.ok); return;
    }
  }

  private setPick(mode: PickMode): void {
    if (mode === this.pick) return;
    this.pick = mode;
    this.selection.clear();
    this.rebuild();
    this.syncGizmo();
    this.publish();
  }

  private facesOfSelection(): number[] {
    if (this.pick === "face") return [...this.selection];
    const verts = verticesOf(this.mesh, this.topology, this.pick, this.selection);
    const faces: number[] = [];
    for (let f = 0; f < triangleCount(this.mesh); f++) {
      if (verts.has(this.mesh.indices[f * 3]) && verts.has(this.mesh.indices[f * 3 + 1]) && verts.has(this.mesh.indices[f * 3 + 2])) faces.push(f);
    }
    return faces;
  }

  private commitStep(next: EditMesh, newSelection?: number[], mode?: PickMode): void {
    this.undoStack.push(cloneMesh(this.mesh));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.replaceMesh(next);
    if (mode) this.pick = mode;
    this.selection = new Set(newSelection ?? []);
    this.dirty = true;
    this.rebuild();
    this.syncGizmo();
    this.publish();
  }

  private extrude(): void {
    const faces = this.facesOfSelection();
    if (!faces.length) { this.o.notify("info", COPY.editSelectFaces); return; }
    try {
      const result = extrudeFaces(this.mesh, this.topology, faces, EXTRUDE_DISTANCE * this.scaleHint());
      this.commitStep(result.mesh, result.faces, "face");
    } catch {
      this.o.notify("warn", COPY.editSelectFaces);
    }
  }

  private deleteSelected(): void {
    const faces = this.facesOfSelection();
    if (!faces.length) { this.o.notify("info", COPY.editSelectFaces); return; }
    try {
      this.commitStep(deleteFaces(this.mesh, faces), []);
    } catch {
      this.o.notify("warn", COPY.editKeepOneFace);
    }
  }

  /** Mark seam (PR26): cut the surface along the selected edges (edge mode). */
  private markSeam(): void {
    if (this.pick !== "edge" || !this.selection.size) { this.o.notify("info", COPY.editSelectEdges); return; }
    const next = splitEdges(this.mesh, this.topology, this.selection);
    if (next.positions.length === this.mesh.positions.length) { this.o.notify("info", COPY.editSeamNothing); return; }
    this.commitStep(next, []);
    this.o.notify("success", COPY.editSeamMarked);
  }

  private flipSelected(): void {
    const faces = this.facesOfSelection();
    if (!faces.length) { this.o.notify("info", COPY.editSelectFaces); return; }
    this.commitStep(flipFaces(this.mesh, faces), []);
  }

  /** A size to scale the default extrusion by: a tenth of the mesh's longest edge of bounds. */
  private scaleHint(): number {
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(this.mesh.positions, 3));
    const size = box.getSize(new THREE.Vector3());
    return Math.max(size.x, size.y, size.z, 0.1) * 0.4;
  }

  private stepHistory(direction: -1 | 1): void {
    const from = direction < 0 ? this.undoStack : this.redoStack;
    const to = direction < 0 ? this.redoStack : this.undoStack;
    const previous = from.pop();
    if (!previous) return;
    to.push(cloneMesh(this.mesh));
    this.replaceMesh(previous);
    this.selection.clear();
    this.dirty = this.undoStack.length > 0 || this.dirty;
    this.rebuild();
    this.syncGizmo();
    this.publish();
  }

  /** Swap the working arrays: the geometry and its BVH are rebuilt for the new topology. */
  private replaceMesh(next: EditMesh): void {
    this.mesh = next;
    this.topology = buildTopology(next);
    const old = this.editMesh.geometry;
    this.editMesh.geometry = geometryOf(next);
    accelerate(this.editMesh);
    (this.editMesh.material as THREE.MeshStandardMaterial).vertexColors = Boolean(next.colors);
    (this.editMesh.material as THREE.Material).needsUpdate = true;
    this.sculpt = null;
    old.dispose();
  }

  // ---- overlays ------------------------------------------------------------------------------
  private queueRebuild(): void {
    if (this.rebuildQueued) return;
    this.rebuildQueued = true;
    requestAnimationFrame(() => { this.rebuildQueued = false; if (!this.ended) this.rebuild(); });
  }

  private clearOverlay(): void {
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
      const m = (child as THREE.Mesh).material as THREE.Material | undefined;
      m?.dispose();
    }
    this.wire = this.points = null;
    this.highlight = null;
  }

  private rebuild(): void {
    this.clearOverlay();
    if (this.tool !== "mesh") { this.o.markDirtyShadow(); return; }
    const t = this.topology, p = this.mesh.positions;
    // All edges, faint.
    const lines = new Float32Array(t.edges.length * 6);
    t.edges.forEach(([a, b], i) => {
      const va = t.members[a][0] * 3, vb = t.members[b][0] * 3;
      lines.set([p[va], p[va + 1], p[va + 2], p[vb], p[vb + 1], p[vb + 2]], i * 6);
    });
    const wireGeometry = new THREE.BufferGeometry();
    wireGeometry.setAttribute("position", new THREE.BufferAttribute(lines, 3));
    this.wire = new THREE.LineSegments(wireGeometry, new THREE.LineBasicMaterial({ color: WIRE, transparent: true, opacity: 0.55, depthTest: true }));
    this.wire.renderOrder = 2;
    this.overlay.add(this.wire);
    // Vertices (vertex mode only).
    if (this.pick === "vertex") {
      const pts = new Float32Array(t.members.length * 3);
      t.members.forEach((m, i) => pts.set([p[m[0] * 3], p[m[0] * 3 + 1], p[m[0] * 3 + 2]], i * 3));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      this.points = new THREE.Points(g, new THREE.PointsMaterial({ color: WIRE, size: 5, sizeAttenuation: false, depthTest: true }));
      this.points.renderOrder = 3;
      this.overlay.add(this.points);
    }
    // The selection, in the accent colour.
    if (this.selection.size) this.overlay.add((this.highlight = this.buildHighlight()));
    this.o.markDirtyShadow();
  }

  private buildHighlight(): THREE.Object3D {
    const t = this.topology, p = this.mesh.positions;
    if (this.pick === "vertex") {
      const pts = new Float32Array(this.selection.size * 3);
      let i = 0;
      for (const w of this.selection) { const v = t.members[w][0] * 3; pts.set([p[v], p[v + 1], p[v + 2]], i++ * 3); }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      const o = new THREE.Points(g, new THREE.PointsMaterial({ color: ACCENT, size: 9, sizeAttenuation: false, depthTest: false }));
      o.renderOrder = 5;
      return o;
    }
    if (this.pick === "edge") {
      const lines = new Float32Array(this.selection.size * 6);
      let i = 0;
      for (const e of this.selection) {
        const [a, b] = t.edges[e]; const va = t.members[a][0] * 3, vb = t.members[b][0] * 3;
        lines.set([p[va], p[va + 1], p[va + 2], p[vb], p[vb + 1], p[vb + 2]], i++ * 6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(lines, 3));
      const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false }));
      o.renderOrder = 5;
      return o;
    }
    const tris = new Float32Array(this.selection.size * 9);
    let i = 0;
    for (const f of this.selection) for (let k = 0; k < 3; k++) { const v = this.mesh.indices[f * 3 + k] * 3; tris.set([p[v], p[v + 1], p[v + 2]], i++ * 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(tris, 3));
    const mat = new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const o = new THREE.Mesh(g, mat);
    o.renderOrder = 4;
    return o;
  }

  // ---- the gizmo on the selection ------------------------------------------------------------
  private selectedVertices(): Set<number> {
    return verticesOf(this.mesh, this.topology, this.pick, this.selection);
  }

  private syncGizmo(): void {
    const mode = this.o.getGizmoMode();
    if (this.tool !== "mesh" || !this.selection.size || mode === "select") { this.transform.detach(); return; }
    const c = centroidOf(this.mesh, this.selectedVertices());
    const world = new THREE.Vector3(c[0], c[1], c[2]).applyMatrix4(this.nodeWorld);
    this.pivot.position.copy(world);
    this.pivot.quaternion.identity();
    this.pivot.scale.set(1, 1, 1);
    this.pivot.updateMatrixWorld(true);
    this.transform.setMode(mode);
    this.transform.attach(this.pivot);
  }

  /** Called when the tool (W/E/R/Q) changes while editing. */
  gizmoModeChanged(): void { this.syncGizmo(); }

  private beginDrag(): void {
    if (!this.selection.size) return;
    const vertices = [...this.selectedVertices()];
    const positions = new Float32Array(vertices.length * 3);
    vertices.forEach((v, i) => positions.set(this.mesh.positions.subarray(v * 3, v * 3 + 3), i * 3));
    this.pivot.updateMatrixWorld(true);
    this.dragStart = { positions, vertices, pivotInverse: this.pivot.matrixWorld.clone().invert(), before: cloneMesh(this.mesh) };
  }

  private dragMoved(): void {
    const start = this.dragStart;
    if (!start) return;
    const begun = performance.now();
    this.pivot.updateMatrixWorld(true);
    const delta = this.pivot.matrixWorld.clone().multiply(start.pivotInverse); // world space
    const local = this.nodeWorld.clone().invert().multiply(delta).multiply(this.nodeWorld);
    const v = new THREE.Vector3();
    start.vertices.forEach((index, i) => {
      v.set(start.positions[i * 3], start.positions[i * 3 + 1], start.positions[i * 3 + 2]).applyMatrix4(local);
      this.mesh.positions[index * 3] = v.x; this.mesh.positions[index * 3 + 1] = v.y; this.mesh.positions[index * 3 + 2] = v.z;
    });
    recomputeNormals(this.mesh, start.vertices);
    refit(this.editMesh);
    this.queueRebuild();
    this.lastDragMs = performance.now() - begun;
  }
  /** The last drag step's cost in ms, for the 8 ms frame budget (telemetry / tests). */
  lastDragMs = 0;

  private endDrag(): void {
    const start = this.dragStart;
    this.dragStart = null;
    if (!start) return;
    this.undoStack.push(start.before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.topology = buildTopology(this.mesh);
    this.dirty = true;
    this.rebuild();
    this.syncGizmo();
    this.publish();
  }

  // ---- pointer picking -------------------------------------------------------------------------
  private ndc(event: PointerEvent): THREE.Vector2 {
    const rect = this.o.domElement.getBoundingClientRect();
    return new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  }

  private onPointerDown(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || this.ended) return;
    if (this.tool !== "mesh" && !event.shiftKey && this.beginStroke(event)) return;
    const onHandle = this.transform.axis !== null && this.transform.axis !== undefined;
    const marqueeStart = event.shiftKey && !onHandle;
    this.pointerDown = { x: event.clientX, y: event.clientY, shift: event.shiftKey, onHandle, marquee: marqueeStart };
    if (marqueeStart) this.o.orbit.enabled = false;
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.tool !== "mesh") { this.moveBrush(event); return; }
    const down = this.pointerDown;
    if (!down || !down.marquee) return;
    const rect = this.o.mount.getBoundingClientRect();
    const x0 = Math.min(down.x, event.clientX) - rect.left, y0 = Math.min(down.y, event.clientY) - rect.top;
    const w = Math.abs(event.clientX - down.x), h = Math.abs(event.clientY - down.y);
    this.marqueeBox.style.cssText += `;display:${w > CLICK_PX || h > CLICK_PX ? "block" : "none"};left:${x0}px;top:${y0}px;width:${w}px;height:${h}px`;
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.stroke) { this.endStroke(); return; }
    const down = this.pointerDown;
    this.pointerDown = null;
    this.marqueeBox.style.display = "none";
    if (!down || this.ended || !event.isPrimary || event.button !== 0) return;
    if (down.marquee) this.o.orbit.enabled = true;
    if (down.onHandle || this.transform.dragging) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > CLICK_PX) {
      if (down.marquee) this.marqueeSelect(down, event);
      return;
    }
    this.clickSelect(event, down.shift || event.ctrlKey || event.metaKey, event.ctrlKey || event.metaKey);
  }

  // ---- sculpt and paint (PR29) -----------------------------------------------------------------
  private setTool(tool: EditTool): void {
    if (tool === this.tool) return;
    this.tool = tool;
    this.selection.clear();
    this.ring.visible = false;
    this.rebuild();
    this.syncGizmo();
    this.publish();
  }

  /** The brush settings in the mesh's own space: the screen-pixel radius projected to the world at the hit. */
  private brushAt(hit: THREE.Vector3): { sculpt: BrushSettings; radiusLocal: number } {
    const b: BrushState = this.o.store.getSnapshot().brush;
    const world = hit.clone().applyMatrix4(this.nodeWorld);
    const distance = world.distanceTo(this.o.camera.position);
    const height = this.o.domElement.clientHeight || 1;
    const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(this.o.camera.fov / 2)) * distance) / height;
    const scale = new THREE.Vector3().setFromMatrixScale(this.nodeWorld).x || 1;
    const radiusLocal = Math.max(0.005, (b.radius * perPixel) / scale);
    return { sculpt: { type: b.type, radius: radiusLocal, strength: b.strength, symmetryX: b.symmetryX }, radiusLocal };
  }

  private hitAt(event: PointerEvent): { local: THREE.Vector3; normal: [number, number, number] } | null {
    this.editMesh.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.ndc(event), this.o.camera);
    const hit = pickFace(this.editMesh, this.raycaster);
    if (!hit) return null;
    const local = this.editMesh.worldToLocal(hit.point.clone());
    const n = this.topology.faceNormals;
    return { local, normal: [n[hit.face * 3], n[hit.face * 3 + 1], n[hit.face * 3 + 2]] };
  }

  private moveBrush(event: PointerEvent): void {
    const hit = this.hitAt(event);
    this.moveEvents++;
    if (hit) this.moveHits++;
    if (this.stroke) {
      if (this.skipNext) { this.skipNext = false; this.skippedDabs++; return; } // the last dab overran its 8 ms: sample less often
      if (hit) this.dab(hit.local, hit.normal);
    }
    // The brush ring follows the cursor.
    if (!hit) { this.ring.visible = false; return; }
    const { radiusLocal } = this.brushAt(hit.local);
    const world = hit.local.clone().applyMatrix4(this.nodeWorld);
    this.ring.position.copy(world);
    this.ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...hit.normal).transformDirection(this.nodeWorld));
    this.ring.scale.setScalar(radiusLocal * (new THREE.Vector3().setFromMatrixScale(this.nodeWorld).x || 1));
    this.ring.visible = true;
  }

  private beginStroke(event: PointerEvent): boolean {
    const hit = this.hitAt(event);
    if (!hit) return false; // off the mesh: let the camera orbit
    this.o.orbit.enabled = false;
    this.strokeCount++;
    this.stroke = { before: cloneMesh(this.mesh), last: null, center: null };
    if (this.tool === "sculpt" && !this.sculpt) this.sculpt = sculptContext(this.mesh);
    this.dab(hit.local, hit.normal);
    return true;
  }

  /** One dab of the current brush, kept inside the per-event budget. */
  private dab(local: THREE.Vector3, normal: [number, number, number]): void {
    const stroke = this.stroke;
    if (!stroke) return;
    const started = performance.now();
    this.dabCount++;
    const b = this.o.store.getSnapshot().brush;
    const { sculpt, radiusLocal } = this.brushAt(local);
    if (this.tool === "paint") {
      paintDab(this.mesh, [local.x, local.y, local.z], { color: hexToColor(b.color), radius: radiusLocal, strength: b.strength, hardness: b.hardness, symmetryX: b.symmetryX });
      this.syncColors();
    } else if (this.sculpt) {
      if (b.type === "grab") {
        if (!stroke.center) { stroke.center = local.clone(); stroke.last = local.clone(); return; }
        const delta: [number, number, number] = [local.x - (stroke.last as THREE.Vector3).x, local.y - (stroke.last as THREE.Vector3).y, local.z - (stroke.last as THREE.Vector3).z];
        applyBrush(this.mesh, this.sculpt, { point: [stroke.center.x, stroke.center.y, stroke.center.z], normal }, sculpt, delta);
        stroke.center.add(new THREE.Vector3(...delta)); stroke.last = local.clone();
      } else {
        applyBrush(this.mesh, this.sculpt, { point: [local.x, local.y, local.z], normal }, sculpt);
      }
      refit(this.editMesh);
    }
    this.lastDabMs = performance.now() - started;
    if (this.lastDabMs > DAB_BUDGET_MS) this.skipNext = true;
  }

  /** Paint wrote colours: make sure the copy shows them. */
  private syncColors(): void {
    const geometry = this.editMesh.geometry;
    const colors = this.mesh.colors as Float32Array;
    if (!geometry.getAttribute("color")) {
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
      (this.editMesh.material as THREE.MeshStandardMaterial).vertexColors = true;
      (this.editMesh.material as THREE.Material).needsUpdate = true;
    }
    geometry.getAttribute("color").needsUpdate = true;
  }

  private endStroke(): void {
    const stroke = this.stroke;
    this.stroke = null;
    this.o.orbit.enabled = true;
    if (!stroke) return;
    this.undoStack.push(stroke.before);
    const bytes = this.mesh.positions.byteLength * 3 + (this.mesh.colors?.byteLength ?? 0);
    const limit = Math.max(5, Math.min(STROKE_HISTORY, Math.floor(STROKE_MEMORY_BYTES / Math.max(1, bytes))));
    while (this.undoStack.length > limit) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.topology = buildTopology(this.mesh);
    this.sculpt = null;
    this.publish();
  }

  private fillPaint(): void {
    if (this.tool !== "paint") return;
    this.undoStack.push(cloneMesh(this.mesh));
    this.redoStack = [];
    fillColor(this.mesh, hexToColor(this.o.store.getSnapshot().brush.color));
    ensureColors(this.mesh);
    this.syncColors();
    this.dirty = true;
    this.publish();
  }

  private clickSelect(event: PointerEvent, additive: boolean, toggle: boolean): void {
    const started = performance.now();
    this.editMesh.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.ndc(event), this.o.camera);
    const hit = pickFace(this.editMesh, this.raycaster);
    if (!hit) { if (!additive) { this.selection.clear(); this.afterSelection(); } return; }
    const local = this.editMesh.worldToLocal(hit.point.clone());
    let ids: number[];
    if (this.pick === "face") ids = faceRegion(this.mesh, this.topology, hit.face);
    else if (this.pick === "vertex") ids = [nearestWeld(this.mesh, this.topology, hit.face, local)];
    else ids = [nearestEdge(this.mesh, this.topology, hit.face, local)];
    if (!additive) this.selection.clear();
    const present = ids.every((id) => this.selection.has(id));
    for (const id of ids) { if (toggle && present) this.selection.delete(id); else this.selection.add(id); }
    this.afterSelection();
    this.lastPickMs = performance.now() - started;
  }
  /** The last click pick's cost in ms (the 8 ms frame budget). */
  lastPickMs = 0;

  private marqueeSelect(down: { x: number; y: number }, event: PointerEvent): void {
    const rect = this.o.domElement.getBoundingClientRect();
    const toNdc = (x: number, y: number) => ({ x: ((x - rect.left) / rect.width) * 2 - 1, y: -((y - rect.top) / rect.height) * 2 + 1 });
    const a = toNdc(down.x, down.y), b = toNdc(event.clientX, event.clientY);
    this.editMesh.updateMatrixWorld(true);
    const result = marquee(this.editMesh, this.mesh, this.topology, this.o.camera, this.pick, { x0: a.x, y0: a.y, x1: b.x, y1: b.y }, FRAME_BUDGET_MS * 4);
    for (const id of result.ids) this.selection.add(id);
    if (result.truncated) this.o.notify("info", COPY.editMarqueeTruncated);
    this.afterSelection();
  }

  private afterSelection(): void {
    this.rebuild();
    this.syncGizmo();
    this.publish();
  }

  // ---- drafts ----------------------------------------------------------------------------------
  private fromDescriptor(): Record<string, unknown> {
    const n = this.o.node;
    return n.kind === "part" ? { modelAssetId: n.modelAssetId, meshIndex: n.meshIndex, primitiveIndex: n.primitiveIndex } : { primitive: n.primitive };
  }

  async writeDraft(): Promise<void> {
    if (!this.dirty || this.ended) return;
    try {
      const result = await putDraft(this.o.rest, this.o.getScene().id, this.o.node.id, { baseRevision: this.o.startRevision, from: this.fromDescriptor(), mesh: encodeMesh(this.mesh) });
      if (result.dropped) this.o.notify("warn", COPY.editDraftDropped);
    } catch (err) {
      if (err instanceof ApiError && err.code === "DRAFT_TOO_LARGE") this.o.notify("info", COPY.editDraftTooLarge);
      // Any other failure: the draft is a convenience, the session carries on.
    }
  }

  private async offerRestore(): Promise<void> {
    try {
      const draft = await getDraft(this.o.rest, this.o.getScene().id, this.o.node.id);
      if (!draft || this.ended) return;
      this.draft = draft;
      const same = JSON.stringify(draft.from) === JSON.stringify(this.fromDescriptor()) && draft.baseRevision === this.o.startRevision;
      this.o.store.patch({ restoreOffer: { savedAt: draft.savedAt, changed: !same } });
    } catch {
      // No draft offer when the gateway cannot answer.
    }
  }

  private restoreDraft(): void {
    const restored = decodeMesh(this.draft?.mesh);
    if (!restored) { this.o.notify("error", COPY.editDraftBroken); this.discardDraft(); return; }
    this.commitStep(restored, []);
    this.draft = null;
    this.o.store.patch({ restoreOffer: null });
  }

  private discardDraft(): void {
    this.draft = null;
    this.o.store.patch({ restoreOffer: null });
    void deleteDraft(this.o.rest, this.o.getScene().id, this.o.node.id).catch(() => {});
  }

  // ---- ending the session ----------------------------------------------------------------------
  /** Leave the mode. `commit` bakes once when there are changes; otherwise the copy is dropped. */
  async finish(commit: boolean): Promise<void> {
    if (this.ended) return;
    if (!commit || !this.dirty) {
      if (!commit && this.dirty) void deleteDraft(this.o.rest, this.o.getScene().id, this.o.node.id).catch(() => {});
      this.end();
      return;
    }
    const generator = this.o.node.generator;
    if (generator && !(await this.confirmGenerator(generator.type))) return;
    this.busy = true;
    this.publish();
    const wasPrimitive = this.o.node.kind === "mesh";
    try {
      await bakeMesh(this.o.rest, this.o.getScene().id, { baseRevision: this.o.startRevision, nodeId: this.o.node.id, mesh: encodeMesh(this.mesh) });
      if (wasPrimitive) this.o.notify("info", COPY.editBecamePart);
      this.o.invalidate();
      this.end();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      this.busy = false;
      if (code === "REVISION_CONFLICT") {
        this.o.notify("warn", COPY.editConflict);
        this.o.invalidate();
        this.end();
        return;
      }
      this.o.notify("error", code === "BAKE_TOO_LARGE" ? COPY.editTooLargeToSave : code === "LIMIT_ASSETS" ? COPY.editAssetCap : code === "NODE_LOCKED" ? COPY.editLocked : COPY.editSaveFailed);
      this.publish(); // the session stays open so nothing is lost; the draft is the safety net
      void this.writeDraft();
    }
  }

  private confirmResolver: ((ok: boolean) => void) | null = null;

  private confirmGenerator(type: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.o.store.patch({ confirmGenerator: type });
      this.confirmResolver = (ok) => {
        this.confirmResolver = null;
        this.o.store.patch({ confirmGenerator: null });
        resolve(ok);
      };
    });
  }

  /** The real object comes back, the copy goes, the store goes idle. */
  private end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.draftTimer) clearInterval(this.draftTimer);
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.transform.detach();
    this.o.threeScene.remove(this.transform.getHelper());
    this.transform.dispose();
    this.o.threeScene.remove(this.pivot);
    this.o.threeScene.remove(this.ring);
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    setGizmoDragging(false);
    this.o.orbit.enabled = true;
    this.clearOverlay();
    this.o.threeScene.remove(this.overlay);
    this.o.threeScene.remove(this.editMesh);
    disposeAccelerated(this.editMesh);
    (this.editMesh.material as THREE.Material).dispose();
    this.marqueeBox.remove();
    delete (window as unknown as Record<string, unknown>).__plastis3dEdit;
    this.o.object.visible = true;
    this.o.store.patch({ active: false, busy: false, nodeId: null, nodeName: "", selected: 0, dirty: false, canUndo: false, canRedo: false, restoreOffer: null, confirmGenerator: null });
    this.o.markDirtyShadow();
    this.o.onEnded();
  }

  /** The scene rebuilt under the session: hide the new object for this node again. */
  onRebuilt(object: THREE.Object3D | null): void {
    if (this.ended || !object) return;
    (this.o as { object: THREE.Object3D }).object = object;
    object.visible = false;
  }

  /** The Viewport is unmounting mid-session: drop everything, keep the draft safety net. */
  dispose(): void {
    if (this.ended) return;
    void this.writeDraft();
    this.end();
  }

  get isDirty(): boolean { return this.dirty; }
}

export { MAX_EDIT_TRIANGLES };
