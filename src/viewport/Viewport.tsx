import { captureGatewayFileDownload } from "@hermes/plugin-sdk";
import { saveRender } from "../api";
import { RENDER_COPY } from "../copy";
import { probeGpu, ProgressiveRender } from "./renderMode";
import type { GpuSupport } from "./renderMode";
import { splatMesh } from "../scene/splats";
import { primitiveClips, validPrimitiveClips } from "../scene/primitiveClips";
import { ClipPlayer, clipsForClone, registerClipPlayer } from "../scene/clipPlayback";
import { markLearning, offerTip } from "../state/learning";
import { newSurfaceId, registerCaptureSurface } from "./capture";
import { EditSession, extractEditMesh } from "./editSession";
import { createEditModeStore, useEditMode } from "../state/editMode";
import type { EditCommand, EditModeStore } from "../state/editMode";
import type { SettleStore } from "../state/settle";
import { MAX_EDIT_TRIANGLES, triangleCount } from "../scene/meshEdit";
import { COPY } from "../copy";
// src/viewport/Viewport.tsx — the 3D surface (Stage 4, PR4 §4.2–§4.3;
// gizmos + click selection + frame, Stage 5, PR5; the studio stage,
// PR32 — UI/UX redesign §5 and §17).
//
// PR32 supersedes three points below: the GridHelper is now the Low-tier
// grid only (High draws stage.ts InfiniteGrid plus a ContactShadow and
// a screen-space SelectionOutline); the canvas is transparent over the
// CSS gradient stage with Neutral tone mapping (D-PR32-01); and the
// BoxHelper selection cage is gone (a light/camera marker, or Low-tier
// corner brackets). Every theme colour goes through resolveCssColor
// (redesign §1.1 row 11).
//
// One WebGLRenderer per mounted Viewport, held behind the renderer lease
// manager (src/scene/leases.ts; the pane takes the "viewport" lease, the
// editor route the "editor" lease — no preemption in PR5). The surface owns:
//   - renderer creation, guarded: no WebGL2 context -> an ErrorState
//     saying this browser cannot draw 3D (never a blank canvas, never a
//     throw). The Scenes pane and scene edits keep working.
//   - OrbitControls: left-drag orbits, middle-drag dollies/zooms,
//     right-drag pans, wheel zoom toward the orbit target
//     (zoomToCursor stays false, ui-design-first-draft §Pointer).
//   - GridHelper, RoomEnvironment via PMREMGenerator (scene.environment,
//     so materials are lit with no ambient light in the file).
//   - ResizeObserver on the wrapper: renderer.setSize + camera aspect.
//   - Visibility-gated requestAnimationFrame: frames run only while the
//     `visible` prop is true (the pane reads
//     host.paneVisibility("plastis3d:viewport"), a function returning a
//     reactive atom, not a boolean). Hidden panes pause the loop and
//     dispose on unmount, not on Hide.
//   - Scene rebuild on scene-data change, disposing the previous build
//     (disposeBuiltScene) and any stats placeholders this surface made.
//     Shared template geometry is never disposed here. A rebuild that
//     arrives WHILE a gizmo drag is down is HELD (the gizmo is attached
//     to the current build): the new scene is not applied and the
//     manager's drag-end callback refetches after the drag settles.
//   - Model slots: after the primitive build, templates are fetched
//     through the shared TemplateCache and resolved with
//     resolveModelSlot. A null template (over the 100,000-tri cap,
//     not drawable, tris null) or a typed failure (a 413
//     ASSET_TOO_LARGE from GET /assets, or any other fetch/parse
//     failure — including the gateway's 501 NOT_IMPLEMENTED for GET
//     /assets until PR7) shows the stats + bounds placeholder
//     (src/scene/bounds.ts) with the centred draw-cap overlay
//     (src/viewport/drawCapOverlay.ts): the four not-drawn cases get
//     four distinct sentences, and the wire box uses the theme stroke
//     colour (G-13). The overlay is pointer-events none, so orbit
//     still works on the box.
//   - Theming via readTheme(): pane background as scene.background,
//     --ui-stroke-secondary for the grid, --ui-text-secondary read
//     but not yet applied (no light/camera helper lines exist in the
//     view — N-01). Re-read on mount, when the surface becomes visible,
//     when useTheme().themeName changes, and every 4 s while visible.
//   - preserveDrawingBuffer: true, so the canvas can be read back (the
//     Tier 4 pixel check, and the PR22 agent-screenshot surface).
//   - Click selection (PR5): a primary-pointer sequence that moved is
//     orbit, not a click (5 px threshold). TransformControls receives
//     the pointer before scene picking (its listeners were registered
//     first), so a pointerdown on a gizmo handle never picks. Raycast
//     pick on click: Shift-click adds, Ctrl/Cmd-click toggles, plain
//     click replaces, click on empty clears and detaches the gizmo.
//     Lights and cameras pick via invisible pick-proxy spheres (their
//     objects have no geometry); hidden nodes are not pickable. The
//     selection is outlined with a BoxHelper in --ui-accent.
//   - Frame (PR5): the F key / Frame button fits the camera + target to
//     the selection bounds, or the whole scene when nothing is selected.
//     Double-click frames the selection on an object, the whole scene on
//     empty space even with a selection active (N-14). Near stays 0.05
//     and far stays 500.
//   - Grid + wireframe toggles from the gizmoMode store (wireframe sets
//     material.wireframe on build-owned materials only — shared template
//     materials are never touched).
//
// Live telemetry for the harness (not faked data — it reports the
// running renderer's own counters): window.__plastis3dViewport
// { frames, triangles, calls, geometries, textures, hasLease, visible,
//   error, orbitEnabled, gizmoDragging, gizmoMode, selectedPrimary,
//   selectedPosition, gizmoHandleX, sourceKey }. One global PER SURFACE:
// the pane viewport writes __plastis3dViewport, the editor route writes
// __plastis3dViewportEditor — a single shared global raced between the
// two viewports once the route mounted alongside the panes (merge fix,
// PR5 report: the gizmo/conflict specs read racy telemetry and timed
// out). The PR4/PR5 helpers keep reading the pane's global unchanged.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { host, useTheme } from "@hermes/plugin-sdk";
import {
  buildSceneGraph,
  disposeBuiltScene,
  resolveModelSlot,
  setBuiltWireframe,
} from "../scene/build";
import type { BuiltScene, ModelSlot } from "../scene/build";
import { createStatsPlaceholder, disposeStatsPlaceholder } from "../scene/bounds";
import type { StatsPlaceholder } from "../scene/bounds";
import {
  isTemplateFailure,
  sharedTemplateCache,
  templateGate,
} from "../scene/cache";
import { applyMaterialMaps, sharedTextureCache } from "../scene/textures";
import type { DrawCapReason } from "./drawCapOverlay";
import { drawCapOverlayText } from "./drawCapOverlay";
import { acquireLease, onLeaseFreed, releaseLease } from "../scene/leases";
import { getAssetBytes } from "../api";
import type { RestFn } from "../api";
import { GizmoManager } from "../gizmos/GizmoManager";
import type { GizmoModeStore } from "../gizmos/gizmoMode";
import { useGizmoMode } from "../gizmos/gizmoMode";
import { isGizmoDragging } from "../state/dragLock";
import { announce } from "../state/announcer";
import {
  getCameraPose,
  isPoseTouched,
  markPoseTouched,
  setCameraPose,
  setLivePosition,
  setLiveTarget,
} from "../state/cameraPose";
import { getViewPrefs, setViewPrefs, useViewPrefs } from "../state/viewPrefs";
import {
  ContactShadow,
  FrameTimeGuard,
  InfiniteGrid,
  SelectionOutline,
  createNodeMarker,
  detectSoftwareRenderer,
  stepGlide,
} from "./stage";
import type { Glide, OutlineGroup, QualityTier, Rgb } from "./stage";
import { Icon } from "../ui/icons";
import { invalidateSceneData, POLL_INTERVAL_MS } from "../state/sceneQuery";
import type { SelectionStore } from "../state/selection";
import { useSelection } from "../state/selection";
import { compositeOver, luminance, readTheme, resolveCssColor, rgbaToHex } from "../theme";
import type { Rgba } from "../theme";
import type { SceneSpec } from "../types";

export interface ViewportProps {
  /** The scene to draw (built from the envelope by the pane). */
  scene: SceneSpec;
  /** The backend source this scene belongs to (connectionId:profile). */
  sourceKey: string;
  /** ctx.rest, bound by the pane. */
  rest: RestFn;
  /** Whether host.paneVisibility("plastis3d:viewport") reports visible. */
  visible: boolean;
  /** "editor" for the route, "pane" for the viewport pane (lease id). */
  chrome: "editor" | "pane" | "card";
  onYield?: () => void;
  /** The per-surface selection store (created by the pane/route). */
  selection: SelectionStore;
  /** The per-surface gizmo-mode store (created by the pane/route). */
  gizmoMode: GizmoModeStore;
  /** The pane/route shows its committing spinner while this is true. */
  onCommittingChange?: (committing: boolean) => void;
  /** Glass overlays (tool dock, stats, view menu) drawn over the stage. */
  overlay?: ReactNode;
  pulseIds?: string[];
  /** The editor route's mesh-edit store (PR24). The pane passes none and never edits meshes. */
  editMode?: EditModeStore;
  /** PR27: poses to show on the built objects while a Settle preview runs (editor only). */
  settle?: SettleStore;
  /** PR14: the editor fills this with a function that draws a small PNG of the clean view. */
  thumbnailRef?: { current: (() => Promise<Uint8Array>) | null };
}

/** One parsed model the view will not draw, shown as stats + bounds. */
export interface ModelPlaceholderInfo {
  nodeName: string;
  assetName: string;
  tris: number | null;
  hasBounds: boolean;
  /** Spec asset.bytes (the overlay's MB figure comes from here). */
  bytes: number | null;
  /** Spec stats.ignored (the not-triangles second line reads it). */
  ignored: string[];
  /** Which of the four not-drawn cases this is (G-13). */
  reason: DrawCapReason;
}

export interface ViewportTelemetry {
  frames: number;
  triangles: number;
  calls: number;
  geometries: number;
  textures: number;
  hasLease: boolean;
  visible: boolean;
  error: string | null;
  /** OrbitControls.enabled (false while a gizmo handle is down). */
  orbitEnabled: boolean;
  /** A gizmo drag is in progress. */
  gizmoDragging: boolean;
  /** The gizmo manager's effective mode. */
  gizmoMode: string;
  /** The primary selected node id, or null. */
  selectedPrimary: string | null;
  /** The primary node's world position, or null. */
  selectedPosition: [number, number, number] | null;
  /** Screen position of the translate X handle, or null. */
  gizmoHandleX: { x: number; y: number } | null;
  /** The scene.background colour the last applyTheme set, as a CSS
   *  string, or null when no theme background was applied yet. */
  background: string | null;
  /** How many times applyTheme has run (N-01: proves the themeName
   *  re-read trigger fires, distinct from the 4 s poll). */
  themeReads: number;
  /** The source this surface is drawing. */
  sourceKey: string;
  /** The revision of the scene currently drawn, or null. */
  sceneRev: number | null;
  /** The orbit camera's world position (for the F-frame test). */
  cameraPosition: [number, number, number];
  /** The orbit controls' target (for the F-frame test). */
  controlsTarget: [number, number, number];
  /** OrbitControls.enableDamping (G-03: false under prefers-reduced-motion). */
  dampingEnabled: boolean;
  /** PR32: the stage quality tier in use. */
  quality?: QualityTier;
  /** PR32: the node under the pointer (hover outline), or null. */
  hovered?: string | null;
  /** PR32: the resolved grid line colour (#rrggbb), "" before a theme read. */
  gridColor?: string;
  /** PR32: tone mapping in use. */
  toneMapping?: string;
}

declare global {
  interface Window {
    __plastis3dViewport?: ViewportTelemetry;
    __plastis3dViewportEditor?: ViewportTelemetry;
    __plastis3dViewportCard?: ViewportTelemetry;
  }
}

/** The one template cache for this surface (keyed by sourceKey + sha256). */
const templateCache = sharedTemplateCache;
const textureCache = sharedTextureCache;

/** A primary-pointer sequence that moved more than this is orbit, not a click. */
const CLICK_MOVE_THRESHOLD_PX = 5;

/** Shared pick-proxy geometry/material for lights and cameras (never disposed). */
const PICK_PROXY_GEOMETRY = new THREE.SphereGeometry(0.2, 8, 6);
const PICK_PROXY_MATERIAL = new THREE.MeshBasicMaterial();

/**
 * A THREE.Color from a CSS colour, or null when it is empty or not a
 * colour. Goes through resolveCssColor (redesign §1.1 row 11): Hermes
 * computes colours as `color(srgb …)` and `color-mix(…)`, which
 * THREE.Color cannot parse (it warns and keeps white). A translucent
 * colour is composited over `under` (the opaque stage background), so
 * a hairline token draws as the faint line the host shows.
 */
function themeColor(
  css: string,
  within: Element | null,
  under?: Rgba | null,
): { color: THREE.Color; rgba: Rgba } | null {
  const resolved = resolveCssColor(css, within);
  if (!resolved) return null;
  const solid =
    resolved.a < 1 && under ? compositeOver(resolved, under) : resolved;
  if (solid.a === 0) return null;
  return {
    color: new THREE.Color().setRGB(solid.r, solid.g, solid.b, THREE.SRGBColorSpace),
    rgba: solid,
  };
}

/**
 * Frame distance for a bounding sphere (ui-design-first-draft §Frame):
 * the orbit camera's vertical fov is 40 degrees; `half` is the smaller
 * of the vertical and horizontal half-angles, in radians.
 */
function frameDistance(radius: number, vFovDeg: number, aspect: number): number {
  const vFovRad = (vFovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect);
  const half = Math.min(vFovRad / 2, hFov / 2);
  const safe = radius > 0 ? radius : 0.05;
  return (safe / Math.sin(half)) * 1.15;
}

/** sRGB triple of a resolved colour (for shader uniforms). */
function rgbOf(rgba: Rgba): Rgb {
  return [rgba.r, rgba.g, rgba.b];
}

/** Mix two opaque colours: `t` of `a` over `b`. */
function mixRgba(a: Rgba, b: Rgba, t: number): Rgba {
  return compositeOver({ ...a, a: t }, { ...b, a: 1 });
}

const GLIDE_MS = 360;
const POP_MS = 180;
const HINT_MS = 12000;
const TURNTABLE_MS = 6000;

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Corner brackets around a box (the Low-tier selection mark, §5.4). */
function bracketGeometry(box: THREE.Box3): THREE.BufferGeometry {
  const size = box.getSize(new THREE.Vector3());
  const len = Math.max(Math.min(size.x, size.y, size.z) * 0.25, 0.04);
  const pts: number[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const sx = x === box.min.x ? 1 : -1;
        const sy = y === box.min.y ? 1 : -1;
        const sz = z === box.min.z ? 1 : -1;
        pts.push(x, y, z, x + sx * len, y, z);
        pts.push(x, y, z, x, y + sy * len, z);
        pts.push(x, y, z, x, y, z + sz * len);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** The six directions of the view gizmo (view along -axis). */
const GIZMO_AXES: Array<{ key: string; dir: THREE.Vector3; label: string; cls: "x" | "y" | "z"; positive: boolean }> = [
  { key: "+x", dir: new THREE.Vector3(1, 0, 0), label: "X", cls: "x", positive: true },
  { key: "+y", dir: new THREE.Vector3(0, 1, 0), label: "Y", cls: "y", positive: true },
  { key: "+z", dir: new THREE.Vector3(0, 0, 1), label: "Z", cls: "z", positive: true },
  { key: "-x", dir: new THREE.Vector3(-1, 0, 0), label: "", cls: "x", positive: false },
  { key: "-y", dir: new THREE.Vector3(0, -1, 0), label: "", cls: "y", positive: false },
  { key: "-z", dir: new THREE.Vector3(0, 0, -1), label: "", cls: "z", positive: false },
];
const GIZMO_NAMES: Record<string, string> = {
  "+x": "View from the right",
  "-x": "View from the left",
  "+y": "View from above",
  "-y": "View from below",
  "+z": "View from the front",
  "-z": "View from the back",
};

export function Viewport({
  scene,
  sourceKey,
  rest,
  visible,
  chrome,
  pulseIds,
  onYield,
  selection,
  gizmoMode,
  onCommittingChange,
  overlay,
  editMode,
  settle,
  thumbnailRef,
}: ViewportProps) {
  const [rendererReady, setRendererReady] = useState(false);
  const [gpu, setGpu] = useState<GpuSupport | null>(null);
  const [renderMode, setRenderMode] = useState(false);
  const [renderSamples, setRenderSamples] = useState(0);
  const [renderMessage, setRenderMessage] = useState("");
  const [showWhy, setShowWhy] = useState(false);
  const renderActive = useRef(false);
  const progressive = useRef<ProgressiveRender | null>(null);
  const renderBuild = useRef<BuiltScene | null>(null);
  const renderContent = useRef("");
  renderActive.current = renderMode;
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!rendererReady || !renderer || chrome !== "editor") return;
    let cancelled = false;
    void probeGpu(renderer).then(support => { if (!cancelled) setGpu(support); });
    return () => { cancelled = true; progressive.current?.dispose(); progressive.current = null; };
  }, [rendererReady, chrome]);
  useEffect(() => { if (!renderMode) { progressive.current?.dispose(); progressive.current = null; setRenderSamples(0); } }, [renderMode]);
  async function saveRenderImage() {
    if (!renderActive.current || !progressive.current?.samples) return;
    const save = captureGatewayFileDownload();
    try {
      setRenderMessage(RENDER_COPY.saving);
      const renderer = rendererRef.current; if (!renderer) return;
      const canvas = document.createElement("canvas");
      const source = renderer.domElement, scale = Math.min(1, 2048 / Math.max(source.width, source.height));
      canvas.width = Math.floor(source.width * scale); canvas.height = Math.floor(source.height * scale);
      canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL("image/png").split(",")[1];
      const result = await saveRender(rest, scene.id, scene.revision, png);
      if (save) await save(result.path, result.filename);
      setRenderMessage("");
    } catch { setRenderMessage(RENDER_COPY.failed); }
  }
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const gizmoSvgRef = useRef<SVGSVGElement | null>(null);
  const [webglError, setWebglError] = useState(false);
  const [noLease, setNoLease] = useState(false);
  /** Bumps to re-run the renderer mount after a refused lease (PR32). */
  const [leaseAttempt, setLeaseAttempt] = useState(0);

  const [placeholders, setPlaceholders] = useState<ModelPlaceholderInfo[]>([]);
  const [tier, setTier] = useState<QualityTier>("high");
  const [guardTripped, setGuardTripped] = useState(false);
  const [stageWidth, setStageWidth] = useState(0);
  const prefs = useViewPrefs();
  const poseKey: "editor" | "pane" = chrome === "editor" ? "editor" : "pane";
  const interactive = chrome !== "card";
  const [hintShown, setHintShown] = useState(
    () => interactive && !getViewPrefs().navHintSeen,
  );
  const [hintGone, setHintGone] = useState(false);

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const threeSceneRef = useRef<THREE.Scene | null>(null);
  const builtRef = useRef<BuiltScene | null>(null);
  const clipPlayersRef = useRef(new Map<BuiltScene, Array<{ player: ClipPlayer; unregister: () => void }>>());
  const templateRefs = useRef(new Map<BuiltScene, import("../scene/cache").ParsedTemplate[]>());
  // Textures a build holds (PR15): released when the build is disposed.
  const textureRefs = useRef(new Map<BuiltScene, import("three").Texture[]>());
  const placeholderRef = useRef<StatsPlaceholder[]>([]);
  /** The Low-tier grid (GridHelper) — null in High. */
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const infiniteGridRef = useRef<InfiniteGrid | null>(null);
  const shadowRef = useRef<ContactShadow | null>(null);
  const outlineRef = useRef<SelectionOutline | null>(null);
  const fillLightRef = useRef<THREE.DirectionalLight | null>(null);
  const pmremRef = useRef<THREE.PMREMGenerator | null>(null);
  const envRTRef = useRef<THREE.WebGLRenderTarget | null>(null);
  const gizmoManagerRef = useRef<GizmoManager | null>(null);
  /** The selection mark that is not an outline: a light/camera marker or
   *  Low-tier corner brackets. */
  const markRef = useRef<THREE.Object3D | null>(null);
  const markTargetRef = useRef<THREE.Object3D | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const pointerDownRef = useRef<{
    x: number;
    y: number;
    gizmoDrag: boolean;
  } | null>(null);
  const appliedThemeRef = useRef<{ background: string; stroke: string; key: string }>({
    background: "",
    stroke: "",
    key: "",
  });
  const themeReadsRef = useRef(0);
  /** The resolved, opaque stage background (compositing base). */
  const backgroundRgbaRef = useRef<Rgba | null>(null);
  /** The resolved grid line colour as #rrggbb (the placeholder box uses it). */
  const strokeHexRef = useRef("");
  const accentRef = useRef<THREE.Color>(new THREE.Color(0x0053fd));
  const tierRef = useRef<QualityTier>("high");
  const softwareRef = useRef(false);
  const guardRef = useRef(new FrameTimeGuard());
  const glideRef = useRef<Glide | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const hoverPendingRef = useRef<{ x: number; y: number } | null>(null);
  const popsRef = useRef(new Map<THREE.Object3D, { start: number; base: THREE.Vector3 }>());
  const lastBuiltSceneIdRef = useRef<string | null>(null);
  const turntableRef = useRef<{ start: number } | null>(null);
  const gridColorHexRef = useRef("");
  /** A frame was requested while the surface had no size (hidden). */
  const pendingFrameRef = useRef(false);
  // The host theme name (N-01): a theme change re-reads the theme.
  const { themeName } = useTheme();
  const gridVisibleRef = useRef(true);
  const framesRef = useRef(0);
  const prevSourceKeyRef = useRef(sourceKey);
  /** A scene revision arrived while a gizmo drag was down (rebuild held). */
  const revisionArrivedRef = useRef(false);

  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const gizmoModeRef = useRef(gizmoMode);
  gizmoModeRef.current = gizmoMode;
  const onCommittingChangeRef = useRef(onCommittingChange);
  onCommittingChangeRef.current = onCommittingChange;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const cleanupRenderer = useRef<(() => void) | null>(null);
  const mountId = useId();
  const leaseId = `${chrome}:${mountId}`;
  const pulseIdsRef = useRef(pulseIds);
  pulseIdsRef.current = pulseIds;
  const selectionSnap = useSelection(selection);
  const modeSnap = useGizmoMode(gizmoMode);
  const selectionKey = selectionSnap.ids.join(",");
  // --- mesh edit (PR24): one session at a time, editor route only -------------------------
  const fallbackEditStore = useMemo(() => createEditModeStore(), []);
  const editStore = editMode ?? fallbackEditStore;
  const editSnap = useEditMode(editStore);
  // Settle preview (PR27): poses are written straight onto the built objects; a rebuild restores the scene's own.
  useEffect(() => {
    if (!settle) return undefined;
    const show = () => {
      const poses = settle.getPoses();
      const built = builtRef.current;
      if (!poses || !built) return;
      for (const [id, pose] of poses) {
        const obj = built.nodes.get(id);
        if (!obj) continue;
        obj.position.set(pose.t[0], pose.t[1], pose.t[2]);
        obj.rotation.set(pose.r[0] * Math.PI / 180, pose.r[1] * Math.PI / 180, pose.r[2] * Math.PI / 180, "XYZ");
      }
    };
    return settle.subscribe(show);
  }, [settle]);
  const editSessionRef = useRef<EditSession | null>(null);
  const editActiveRef = useRef(false);
  editActiveRef.current = editSnap.active;

  // --- source switch: purge the old source's templates immediately -------
  useEffect(() => {
    if (prevSourceKeyRef.current !== sourceKey) {
      templateCache.clear(prevSourceKeyRef.current);
      textureCache.clear(prevSourceKeyRef.current);
      prevSourceKeyRef.current = sourceKey;
    }
  }, [sourceKey]);

  // --- quality tier -------------------------------------------------------------
  function effectiveTier(): QualityTier {
    const pref = prefsRef.current.quality;
    if (pref === "high") return "high";
    if (pref === "low") return "low";
    return softwareRef.current || guardTripped ? "low" : "high";
  }

  // --- theme + stage look -----------------------------------------------------
  /** Apply the background mode (gradient / studio / plain). */
  function applyBackground(): void {
    const threeScene = threeSceneRef.current;
    const renderer = rendererRef.current;
    if (!threeScene || !renderer) return;
    const mode = prefsRef.current.background;
    if (mode === "studio" && envRTRef.current) {
      threeScene.background = envRTRef.current.texture;
      threeScene.backgroundBlurriness = 0.55;
      threeScene.backgroundIntensity = 0.9;
    } else if (mode === "plain" && backgroundRgbaRef.current) {
      const bg = backgroundRgbaRef.current;
      threeScene.background = new THREE.Color().setRGB(bg.r, bg.g, bg.b, THREE.SRGBColorSpace);
    } else {
      // Gradient: the canvas is transparent over the CSS stage.
      threeScene.background = null;
    }
    renderer.setClearColor(0x000000, 0);
  }

  /** (Re)build the Low-tier GridHelper in the resolved line colour. */
  function rebuildLowGrid(): void {
    const threeScene = threeSceneRef.current;
    if (!threeScene) return;
    const old = gridRef.current;
    if (old) {
      threeScene.remove(old);
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
      gridRef.current = null;
    }
    if (tierRef.current !== "low") return;
    const hex = gridColorHexRef.current;
    const grid = hex ? new THREE.GridHelper(10, 10, hex, hex) : new THREE.GridHelper(10, 10);
    grid.visible = gridVisibleRef.current;
    grid.userData.viewOnly = true;
    threeScene.add(grid);
    gridRef.current = grid;
  }

  const applyTheme = () => {
    const threeScene = threeSceneRef.current;
    if (!threeScene) return;
    themeReadsRef.current += 1;
    const mount = mountRef.current;
    // N-01: read from the mount element with a walk-up.
    const theme = readTheme(mount);
    const key = [theme.background, theme.stroke, theme.textSecondary, theme.accent, theme.red, theme.blue].join("|");
    if (key === appliedThemeRef.current.key) return;
    appliedThemeRef.current = { background: theme.background, stroke: theme.stroke, key };

    const bg = themeColor(theme.background, mount);
    if (bg) backgroundRgbaRef.current = bg.rgba;
    const base = backgroundRgbaRef.current ?? { r: 1, g: 1, b: 1, a: 1 };
    const dark = luminance(base) < 0.35;

    // Grid lines: the secondary text colour reads in every theme; the
    // shader applies its own low alpha. Fallback: mid grey.
    const line = themeColor(theme.textSecondary, mount, base)?.rgba ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    const red = themeColor(theme.red, mount, base)?.rgba ?? { r: 0.9, g: 0.29, b: 0.3, a: 1 };
    const blue = themeColor(theme.blue, mount, base)?.rgba ?? { r: 0.24, g: 0.48, b: 0.98, a: 1 };
    infiniteGridRef.current?.setColors(rgbOf(line), rgbOf(red), rgbOf(blue));
    const lowLine = mixRgba(line, base, 0.35);
    gridColorHexRef.current = rgbaToHex(lowLine);
    rebuildLowGrid();
    // The placeholder wire box keeps the host stroke token, resolved.
    const stroke = themeColor(theme.stroke, mount, base);
    strokeHexRef.current = stroke ? rgbaToHex(stroke.rgba) : rgbaToHex(lowLine);

    const accent = themeColor(theme.accent, mount, base);
    if (accent) {
      accentRef.current.copy(accent.color);
      outlineRef.current?.setColor(rgbOf(accent.rgba));
    }
    if (shadowRef.current) {
      shadowRef.current.darkness = dark ? 0.85 : 0.5;
      shadowRef.current.markDirty();
    }
    applyBackground();
  };

  // Re-read the theme every 4 s while visible (ui-design-first-draft §11).
  useEffect(() => {
    if (!visible) return;
    applyTheme();
    const timer = setInterval(applyTheme, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // N-01: re-read when the host theme name changes.
  useEffect(() => {
    applyTheme();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeName]);

  // Background mode and quality follow the shared view prefs.
  useEffect(() => {
    applyBackground();
    if (rendererRef.current) rendererRef.current.toneMapping = prefs.toneMapping === "aces" ? THREE.ACESFilmicToneMapping : prefs.toneMapping === "none" ? THREE.NoToneMapping : THREE.NeutralToneMapping;
    if (infiniteGridRef.current) infiniteGridRef.current.mesh.material.uniforms.uSpacing.value = prefs.gridSize;
    if (gridRef.current) gridRef.current.scale.setScalar(prefs.gridSize);
    for (const [id, object] of builtRef.current?.nodes ?? []) {
      const node = sceneRef.current.nodes.find(node => node.id === id);
      if (node?.kind === "camera" || node?.kind === "light") object.traverse(child => { if ((child as THREE.Mesh).isMesh) child.visible = prefs.showHelpers; });
    }
    const next = effectiveTier();
    if (next !== tierRef.current) {
      tierRef.current = next;
      setTier(next);
      rebuildLowGrid();
      refreshSelectionMark();
      shadowRef.current?.markDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.background, prefs.quality, prefs.gridSize, prefs.toneMapping, prefs.showHelpers, guardTripped, rendererReady, scene]);

  // --- click picking ---------------------------------------------------------
  function findNodeObject(obj: THREE.Object3D): THREE.Object3D | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
      if (typeof current.userData.nodeId === "string") return current;
      current = current.parent;
    }
    return null;
  }

  function handlePick(nodeId: string, event: PointerEvent): void {
    const store = selectionRef.current;
    if (event.shiftKey) {
      // Shift-click toggles the selection, like Ctrl/Cmd-click (E-07).
      store.toggle(nodeId);
    } else if (event.ctrlKey || event.metaKey) {
      store.toggle(nodeId);
    } else {
      store.select(nodeId);
    }
  }

  /** The first visible picked node id at a client point, or null. */
  function hitNodeAtPoint(clientX: number, clientY: number): string | null {
    const built = builtRef.current;
    const camera = cameraRef.current;
    const renderer = rendererRef.current;
    if (!built || !camera || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycasterRef.current.setFromCamera(ndc, camera);
    const hits = raycasterRef.current.intersectObjects(built.root.children, true);
    for (const hit of hits) {
      const nodeObj = findNodeObject(hit.object);
      if (!nodeObj) continue;
      // Hidden nodes are not pickable (the node or any ancestor hidden).
      let current: THREE.Object3D | null = nodeObj;
      let hidden = false;
      while (current) {
        if (current.visible === false) {
          hidden = true;
          break;
        }
        current = current.parent;
      }
      if (hidden) continue;
      return nodeObj.userData.nodeId as string;
    }
    return null;
  }

  function hitNodeAt(event: PointerEvent | MouseEvent): string | null {
    return hitNodeAtPoint(event.clientX, event.clientY);
  }

  function pickAt(event: PointerEvent): void {
    const nodeId = hitNodeAt(event);
    if (nodeId) {
      handlePick(nodeId, event);
      return;
    }
    selectionRef.current.clear();
  }

  // --- framing ---------------------------------------------------------------
  /** Glide (or cut, with reduced motion) to a camera position + target. */
  function moveCamera(toPos: THREE.Vector3, toTarget: THREE.Vector3, glide: boolean): void {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    if (!glide || reducedMotion()) {
      glideRef.current = null;
      camera.position.copy(toPos);
      controls.target.copy(toTarget);
      controls.update();
      return;
    }
    glideRef.current = {
      fromPos: camera.position.clone(),
      toPos: toPos.clone(),
      fromTarget: controls.target.clone(),
      toTarget: toTarget.clone(),
      start: performance.now(),
      duration: GLIDE_MS,
    };
  }

  /** Move the camera to fit `box` (empty boxes are ignored). */
  function frameBox(box: THREE.Box3, glide = true): void {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    if (box.isEmpty()) return;
    // A hidden surface (width 0) has aspect 0, which would put the
    // camera at infinity (NaN after normalising): defer until it has a
    // size; the resize handler runs the pending frame.
    if (!(camera.aspect > 0) || !Number.isFinite(camera.aspect)) {
      pendingFrameRef.current = true;
      return;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = frameDistance(sphere.radius, 40, camera.aspect);
    if (!Number.isFinite(distance)) return;
    const center = sphere.center;
    const direction = camera.position.clone().sub(controls.target).normalize();
    if (direction.lengthSq() < 1e-12) direction.set(0.4, 0.3, 0.6).normalize();
    moveCamera(center.clone().addScaledVector(direction, distance), center, glide);
  }

  /** Bounds of what is drawn — meshes and models, not lights/cameras. */
  function contentBox(root: THREE.Object3D): THREE.Box3 {
    const box = new THREE.Box3();
    root.updateMatrixWorld(true);
    root.traverseVisible((o) => {
      if (o.userData.viewOnly || o.name.startsWith("pick-proxy:")) return;
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh || (o as THREE.LineSegments).isLineSegments) {
        if (!mesh.geometry) return;
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        const b = mesh.geometry.boundingBox;
        if (b) box.union(b.clone().applyMatrix4(o.matrixWorld));
      }
    });
    return box;
  }

  /** Every corner of `box` is inside the view (with a margin) and the
   *  content is not a speck. Needs a sized camera. */
  function comfortablyInView(box: THREE.Box3): boolean {
    const camera = cameraRef.current;
    if (!camera || !(camera.aspect > 0)) return false;
    camera.updateMatrixWorld();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const v = new THREE.Vector3();
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          v.set(x, y, z).project(camera);
          if (v.z > 1 || v.z < -1) return false;
          minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
          minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
        }
      }
    }
    const inside = minX > -0.92 && maxX < 0.92 && minY > -0.92 && maxY < 0.92;
    const big = Math.max(maxX - minX, maxY - minY) > 0.3;
    return inside && big;
  }

  function frameSelection(): void {
    const built = builtRef.current;
    if (!built) return;
    const box = new THREE.Box3();
    const ids = selectionRef.current.getSnapshot().ids;
    if (ids.length > 0) {
      for (const id of ids) {
        const obj = built.nodes.get(id);
        if (obj) box.expandByObject(obj);
      }
    } else {
      box.union(contentBox(built.root));
      if (box.isEmpty()) box.expandByObject(built.root);
    }
    frameBox(box);
  }

  /** N-14: frame the whole scene even when a selection is active. */
  function frameAll(glide = true, contentOnly = false): void {
    const built = builtRef.current;
    if (!built) return;
    let box = contentBox(built.root);
    if (box.isEmpty()) {
      // Opening a scene with nothing drawn yet keeps the default view
      // of the floor rather than framing a light or a camera.
      if (contentOnly) return;
      box = new THREE.Box3().expandByObject(built.root);
    }
    // On open, leave a view that already shows everything comfortably:
    // only reframe when the content is cut off or tiny (row 12).
    if (contentOnly && comfortablyInView(box)) return;
    frameBox(box, glide);
  }

  // --- selection marks ---------------------------------------------------------
  function clearMark(): void {
    const threeScene = threeSceneRef.current;
    const mark = markRef.current;
    if (mark) {
      threeScene?.remove(mark);
      const m = mark as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
      markRef.current = null;
    }
    markTargetRef.current = null;
  }

  /**
   * A light or camera gets a small marker (it has no geometry to
   * outline). In the Low tier a mesh gets corner brackets instead of the
   * outline post pass. The old BoxHelper cage is gone (row 13).
   */
  function updateSelectionMark(obj: THREE.Object3D | null): void {
    const threeScene = threeSceneRef.current;
    clearMark();
    if (!threeScene || !obj) return;
    const kind = obj.userData.kind as string | undefined;
    if (kind === "light" || kind === "camera") {
      const marker = createNodeMarker(accentRef.current);
      threeScene.add(marker);
      markRef.current = marker;
      markTargetRef.current = obj;
      return;
    }
    if (tierRef.current === "low") {
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      const lines = new THREE.LineSegments(
        bracketGeometry(box),
        new THREE.LineBasicMaterial({ color: accentRef.current, depthTest: false, transparent: true, toneMapped: false }),
      );
      lines.renderOrder = 10;
      lines.userData.viewOnly = true;
      lines.raycast = () => {};
      threeScene.add(lines);
      markRef.current = lines;
      markTargetRef.current = obj;
    }
  }

  function refreshSelectionMark(): void {
    const built = builtRef.current;
    const primary = selectionRef.current.getSnapshot().primary;
    const primaryNode = primary ? sceneRef.current.nodes.find((n) => n.id === primary) : undefined;
    const obj = primary && primaryNode?.visible !== false ? (built?.nodes.get(primary) ?? null) : null;
    updateSelectionMark(obj);
  }

  /** The outline groups for this frame (primary 1, others .6, hover .35). */
  function outlineGroups(): OutlineGroup[] {
    const built = builtRef.current;
    if (!built) return [];
    const snap = selectionRef.current.getSnapshot();
    const hidden = new Set(sceneRef.current.nodes.filter((n) => n.visible === false).map((n) => n.id));
    const pick = (id: string | null) => (id && !hidden.has(id) ? (built.nodes.get(id) ?? null) : null);
    const groups: OutlineGroup[] = [];
    const primary = pick(snap.primary);
    if (primary) groups.push({ objects: [primary], strength: 1 });
    const others = snap.ids.filter((id) => id !== snap.primary).map(pick).filter((o): o is THREE.Object3D => o !== null);
    if (others.length) groups.push({ objects: others, strength: 0.6 });
    const hov = hoveredRef.current;
    if (hov && !snap.ids.includes(hov)) {
      const h = pick(hov);
      if (h) groups.push({ objects: [h], strength: 0.35 });
    }
    return groups;
  }

  function dismissHint(): void {
    if (!hintShown || hintGone) return;
    setHintGone(true);
    if (!getViewPrefs().navHintSeen) setViewPrefs({ navHintSeen: true });
  }
  const dismissHintRef = useRef(dismissHint);
  dismissHintRef.current = dismissHint;

  useEffect(() => {
    if (!hintShown || hintGone) return undefined;
    const t = setTimeout(() => dismissHintRef.current(), HINT_MS);
    return () => clearTimeout(t);
  }, [hintShown, hintGone]);

  // --- renderer lifecycle (mount once) -------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return undefined;

    const lease = acquireLease(leaseId, chrome === "card" ? "card" : chrome === "editor" ? "editor" : "viewport", chrome === "card" ? () => { cleanupRenderer.current?.(); onYield?.(); } : undefined);
    if (!lease) {
      setNoLease(true);
      onYield?.();
      return undefined;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      if (!renderer.getContext()) throw new Error("no WebGL2 context");
    } catch {
      releaseLease(leaseId);
      setWebglError(true);
      return undefined;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, Math.max(mount.clientHeight, 1));
    renderer.setClearColor(0x000000, 0);
    // §5.2 (amended in PR32): Khronos PBR Neutral tone mapping. AgX was
    // specified, but live it desaturated base colours noticeably (a
    // Tomato swatch rendered salmon); Neutral keeps a picked colour
    // looking like its swatch while still rolling off highlights.
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    mount.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    softwareRef.current = detectSoftwareRenderer(renderer);
    tierRef.current = effectiveTier();
    setTier(tierRef.current);

    const threeScene = new THREE.Scene();
    threeSceneRef.current = threeScene;

    const camera = new THREE.PerspectiveCamera(
      40,
      mount.clientWidth / Math.max(mount.clientHeight, 1),
      0.05,
      500,
    );
    // E-09: restore the persisted pose (per surface, not per scene).
    const savedPose = getCameraPose(poseKey);
    camera.position.set(...savedPose.position);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(...savedPose.target);
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    controls.zoomToCursor = false;
    // prefers-reduced-motion (G-03): no damped orbiting.
    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const applyReducedMotion = () => {
      controls.enableDamping = !reducedMotionQuery.matches;
    };
    applyReducedMotion();
    reducedMotionQuery.addEventListener("change", applyReducedMotion);
    controls.dampingFactor = 0.1;
    controls.update();
    controlsRef.current = controls;
    // The user moved the view: the pinned pose wins from now on, the
    // first-visit hint fades, and any glide or turntable stops.
    let userOrbit = false;
    const onControlsEnd = () => { userOrbit = false; };
    const onControlsStart = () => {
      userOrbit = true;
      glideRef.current = null;
      turntableRef.current = null;
      controls.autoRotate = false;
      if (chrome !== "card") markPoseTouched(poseKey);
      dismissHintRef.current();
    };
    const onControlsChange = () => {
      if (userOrbit && chrome === "editor") markLearning("look");
      if (chrome !== "card") {
        setLiveTarget(poseKey, [controls.target.x, controls.target.y, controls.target.z]);
        setLivePosition(poseKey, [camera.position.x, camera.position.y, camera.position.z]);
      }
    };
    controls.addEventListener("end", onControlsEnd);
    controls.addEventListener("start", onControlsStart);
    controls.addEventListener("change", onControlsChange);

    // --- the stage (view-only) ---
    const infiniteGrid = new InfiniteGrid();
    infiniteGrid.mesh.visible = gridVisibleRef.current && tierRef.current === "high";
    threeScene.add(infiniteGrid.mesh);
    infiniteGridRef.current = infiniteGrid;
    const shadow = new ContactShadow();
    threeScene.add(shadow.group);
    shadowRef.current = shadow;
    const outline = new SelectionOutline();
    outlineRef.current = outline;
    const fill = new THREE.DirectionalLight(0xffffff, 1.6);
    fill.position.set(3, 6, 4);
    fill.userData.viewOnly = true;
    fill.visible = false;
    threeScene.add(fill);
    threeScene.add(fill.target);
    fillLightRef.current = fill;

    // RoomEnvironment via PMREM: materials are lit with no ambient
    // light in the file.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmremRef.current = pmrem;
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    envRTRef.current = envRT;
    threeScene.environment = envRT.texture;

    const gizmoManager = chrome === "card" ? null : new GizmoManager({
      scene: threeScene,
      camera,
      domElement: renderer.domElement,
      orbit: controls,
      rest,
      getScene: () => sceneRef.current,
      getSelection: () => selectionRef.current.getSnapshot(),
      getBuiltNodes: () => builtRef.current?.nodes ?? null,
      getMode: () => gizmoModeRef.current.getSnapshot().mode,
      notify: (kind, message) => {
        host.notify({ kind, message });
        announce(message);
      },
      invalidate: () =>
        invalidateSceneData(sourceKeyRef.current, sceneRef.current.id),
      onCommittingChange: (value) => onCommittingChangeRef.current?.(value),
      onDragEnd: () => {
        shadowRef.current?.markDirty();
        if (revisionArrivedRef.current) {
          revisionArrivedRef.current = false;
          invalidateSceneData(sourceKeyRef.current, sceneRef.current.id);
        }
      },
    });
    gizmoManagerRef.current = gizmoManager;

    // Click selection: a primary-pointer sequence that moved is orbit.
    const onPointerDown = (event: PointerEvent): void => {
      if (chrome === "card") {
        turntableRef.current = null;
        controls.autoRotate = false;
        return;
      }
      if (!event.isPrimary || event.button !== 0) return;
      pointerDownRef.current = {
        x: event.clientX,
        y: event.clientY,
        gizmoDrag: gizmoManagerRef.current?.isDragging() ?? false,
      };
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (chrome === "card" || !event.isPrimary || event.button !== 0) return;
      const down = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!down) return;
      if (editActiveRef.current) return; // the edit session picks sub-objects itself
      if (down.gizmoDrag) return;
      if (gizmoManagerRef.current?.isDragging()) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      if (moved > CLICK_MOVE_THRESHOLD_PX) return;
      pickAt(event);
    };
    const onDoubleClick = (event: MouseEvent): void => {
      if (chrome === "card" || event.button !== 0 || editActiveRef.current) return;
      markPoseTouched(poseKey);
      if (hitNodeAt(event)) frameSelection();
      else frameAll();
    };
    // Hover (§5.4): one raycast per frame at most, never mid-drag.
    const onPointerMove = (event: PointerEvent): void => {
      if (chrome === "card" || editActiveRef.current) return;
      if (event.buttons !== 0) {
        hoverPendingRef.current = null;
        return;
      }
      hoverPendingRef.current = { x: event.clientX, y: event.clientY };
    };
    const onPointerLeave = (): void => {
      hoverPendingRef.current = null;
      hoveredRef.current = null;
      renderer.domElement.style.cursor = "";
    };
    const onWheel = (): void => {
      dismissHintRef.current();
      if (chrome !== "card") markPoseTouched(poseKey);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("dblclick", onDoubleClick);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerleave", onPointerLeave);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: true });

    applyTheme();

    const onResize = () => {
      const width = mount.clientWidth;
      const height = Math.max(mount.clientHeight, 1);
      if (width === 0) return;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
      setStageWidth(width);
      if (pendingFrameRef.current) {
        pendingFrameRef.current = false;
        frameAll(false, true);
      }
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(mount);
    onResize();

    // The card makes one slow turntable revolution, then stops (§6.4).
    if (chrome === "card" && !reducedMotion()) {
      turntableRef.current = { start: performance.now() };
      controls.autoRotate = true;
      controls.autoRotateSpeed = 10; // 2π per 6 s (r180 time-based).
    }

    setRendererReady(true);

    const cleanup = () => {
      if (!rendererRef.current) return;
      observer.disconnect();
      reducedMotionQuery.removeEventListener("change", applyReducedMotion);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("dblclick", onDoubleClick);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerleave", onPointerLeave);
      renderer.domElement.removeEventListener("wheel", onWheel);
      controls.removeEventListener("end", onControlsEnd);
      controls.removeEventListener("start", onControlsStart);
      controls.removeEventListener("change", onControlsChange);
      editSessionRef.current?.dispose();
      editSessionRef.current = null;
      gizmoManager?.dispose();
      gizmoManagerRef.current = null;
      disposeCurrentBuild();
      clearMark();
      // E-09: persist the pose BEFORE disposing the controls. The card
      // never writes the pane's pose (it frames itself).
      if (chrome !== "card") {
        setCameraPose(poseKey, {
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [controls.target.x, controls.target.y, controls.target.z],
        });
      }
      controls.dispose();
      controlsRef.current = null;
      if (gridRef.current) {
        threeScene.remove(gridRef.current);
        gridRef.current.geometry.dispose();
        (gridRef.current.material as THREE.Material).dispose();
        gridRef.current = null;
      }
      threeScene.remove(infiniteGrid.mesh);
      infiniteGrid.dispose();
      infiniteGridRef.current = null;
      threeScene.remove(shadow.group);
      shadow.dispose();
      shadowRef.current = null;
      outline.dispose();
      outlineRef.current = null;
      threeScene.remove(fill);
      threeScene.remove(fill.target);
      fill.dispose();
      fillLightRef.current = null;
      threeScene.background = null;
      threeScene.environment = null;
      if (envRTRef.current) {
        envRTRef.current.dispose();
        envRTRef.current = null;
      }
      if (pmremRef.current) {
        pmremRef.current.dispose();
        pmremRef.current = null;
      }
      renderer.dispose();
      if (chrome === "card") renderer.forceContextLoss();
      renderer.domElement.remove();
      rendererRef.current = null;
      threeSceneRef.current = null;
      cameraRef.current = null;
      releaseLease(leaseId);
      setRendererReady(false);
    };
    cleanupRenderer.current = cleanup;
    return cleanup;
    // Mount once (and again only after a refused lease frees up):
    // `scene` changes are handled by the rebuild effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaseAttempt]);

  // A surface that was refused a renderer retries when any lease frees
  // (PR32 bug fix): before, it showed "unavailable" until remounted, and
  // a card could stick there when its yield and a release were batched.
  useEffect(() => {
    if (!noLease) return undefined;
    return onLeaseFreed(() => {
      setNoLease(false);
      setLeaseAttempt((n) => n + 1);
    });
  }, [noLease]);

  // --- frame loop: only while visible ---------------------------------------
  useEffect(() => {
    const renderer = rendererRef.current;
    const threeScene = threeSceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!renderer || !threeScene || !camera || !controls) return undefined;
    if (!visible || webglError || noLease) return undefined;
    let raf = 0;
    let cancelled = false;
    let previousFrame: number | undefined;
    const axisVec = new THREE.Vector3();
    const invQuat = new THREE.Quaternion();
    guardRef.current.reset();
    const tick = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);

      const delta = previousFrame === undefined ? 0 : Math.min((now - previousFrame) / 1000, 0.1);
      previousFrame = now;
      const currentBuild = builtRef.current;
      if (currentBuild) for (const entry of clipPlayersRef.current.get(currentBuild) ?? []) entry.player.update(delta);

      // Camera glide (Frame / Reset / view gizmo).
      const glide = glideRef.current;
      if (glide && !stepGlide(glide, now, camera, controls.target)) glideRef.current = null;
      // Card turntable: one revolution, then stop.
      const tt = turntableRef.current;
      if (tt && now - tt.start > TURNTABLE_MS) {
        turntableRef.current = null;
        controls.autoRotate = false;
      }
      controls.update();

      // New objects scale in (view-only).
      if (popsRef.current.size > 0) {
        for (const [obj, pop] of popsRef.current) {
          const t = Math.min(1, (now - pop.start) / POP_MS);
          const e = 1 - Math.pow(1 - t, 3);
          obj.scale.copy(pop.base).multiplyScalar(0.85 + 0.15 * e);
          if (t >= 1) popsRef.current.delete(obj);
        }
        shadowRef.current?.markDirty();
      }

      // Hover pick (at most one raycast per frame).
      const pending = hoverPendingRef.current;
      if (pending && chrome !== "card") {
        hoverPendingRef.current = null;
        const dragging = gizmoManagerRef.current?.isDragging() ?? false;
        const id = dragging ? null : hitNodeAtPoint(pending.x, pending.y);
        hoveredRef.current = id;
        renderer.domElement.style.cursor = id ? "pointer" : "";
      }

      // The marker follows its light/camera.
      const markTarget = markTargetRef.current;
      const mark = markRef.current;
      if (mark && markTarget && (markTarget.userData.kind === "light" || markTarget.userData.kind === "camera")) {
        mark.visible = prefsRef.current.showHelpers;
        markTarget.getWorldPosition(mark.position);
        const d = camera.position.distanceTo(mark.position);
        mark.scale.setScalar(Math.max(0.6, d * 0.12));
        mark.rotation.y = now * 0.0012;
      }

      const high = tierRef.current === "high";
      const grid = infiniteGridRef.current;
      if (grid) {
        grid.mesh.visible = high && gridVisibleRef.current;
        if (grid.mesh.visible) grid.update(camera, controls.target);
      }
      const built = builtRef.current;
      const shadow = shadowRef.current;
      if (shadow) {
        shadow.group.visible = high && !!built;
        if (gizmoManagerRef.current?.isDragging()) shadow.markDirty();
        if (high && built) {
          const hide: THREE.Object3D[] = [];
          if (grid) hide.push(grid.mesh);
          if (gridRef.current) hide.push(gridRef.current);
          if (markRef.current) hide.push(markRef.current);
          for (const p of placeholderRef.current) hide.push(p.group);
          gizmoManagerRef.current?.forEachHelper((h) => hide.push(h));
          shadow.render(renderer, threeScene, built.root, hide);
        }
      }

      if (renderActive.current && builtRef.current) {
        try {
          builtRef.current.root.updateMatrixWorld(true);
          let fingerprint = "";
          builtRef.current.root.traverse(object => { fingerprint += object.uuid + object.matrixWorld.elements.join(","); });
          if (!progressive.current || renderBuild.current !== builtRef.current || fingerprint !== renderContent.current) {
            renderContent.current = fingerprint;
            progressive.current?.dispose();
            const clean = new THREE.Scene(); clean.background = threeScene.background; clean.environment = threeScene.environment;
            const clone = builtRef.current.root.clone(true);
            const splatObjects: THREE.Object3D[] = [];
            clone.traverse(object => { if (object.userData.kind === "splat") splatObjects.push(object); });
            for (const object of splatObjects) object.removeFromParent();
            clean.add(clone);
            progressive.current = new ProgressiveRender(renderer, clean, camera); renderBuild.current = builtRef.current;
          }
          progressive.current.draw(camera, sceneRef.current.revision);
          const samples = Math.floor(progressive.current.samples);
          setRenderSamples(previous => previous === samples ? previous : samples);
        } catch (error) { console.warn("Plastis3D render failed", error); setRenderMessage(error instanceof Error && error.message === RENDER_COPY.cap ? RENDER_COPY.cap : RENDER_COPY.renderFailed); setRenderMode(false); }
      } else renderer.render(threeScene, camera);
      // Read the counters before the outline pass overwrites them.
      const drawnTris = renderer.info.render.triangles;
      const drawnCalls = renderer.info.render.calls;
      if (!renderActive.current && high && outlineRef.current) {
        const groups = outlineGroups();
        if (Math.floor(now / 350) % 2 === 0) for (const id of pulseIdsRef.current ?? []) { const object = builtRef.current?.nodes.get(id); if (object) groups.push({ objects: [object], strength: .8 }); }
        if (groups.length > 0) outlineRef.current.render(renderer, threeScene, camera, groups);
      }
      framesRef.current += 1;

      // View gizmo: project the axes through the inverse camera rotation.
      const svg = gizmoSvgRef.current;
      if (svg) {
        invQuat.copy(camera.quaternion).invert();
        for (const axis of GIZMO_AXES) {
          const node = svg.querySelector<SVGGElement>(`[data-axis="${axis.key}"]`);
          if (!node) continue;
          axisVec.copy(axis.dir).applyQuaternion(invQuat);
          const x = 36 + axisVec.x * 24;
          const y = 36 - axisVec.y * 24;
          node.setAttribute("transform", `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
          node.style.opacity = axisVec.z < -0.05 ? "0.55" : "1";
          const line = svg.querySelector<SVGLineElement>(`[data-line="${axis.key}"]`);
          if (line) {
            line.setAttribute("x2", x.toFixed(2));
            line.setAttribute("y2", y.toFixed(2));
          }
        }
      }

      // Frame-time guard (High only, Auto only): a functional fallback.
      if (high && prefsRef.current.quality === "auto" && guardRef.current.tick(now)) {
        setGuardTripped(true);
      }

      if (typeof window !== "undefined") {
        const manager = gizmoManagerRef.current;
        const primary = selectionRef.current.getSnapshot().primary;
        const primaryObj = primary
          ? (builtRef.current?.nodes.get(primary) ?? null)
          : null;
        const primaryWorld = primaryObj
          ? primaryObj.getWorldPosition(new THREE.Vector3())
          : null;
        const effectiveMode = manager ? manager.getEffectiveMode() : "select";
        const telemetryKey =
          chrome === "editor"
            ? "__plastis3dViewportEditor"
            : chrome === "card" ? "__plastis3dViewportCard" : "__plastis3dViewport";
        const bg = backgroundRgbaRef.current;
        window[telemetryKey] = {
          frames: framesRef.current,
          triangles: drawnTris,
          calls: drawnCalls,
          geometries: renderer.info.memory.geometries,
          textures: renderer.info.memory.textures,
          hasLease: true,
          visible: true,
          error: null,
          orbitEnabled: controls.enabled,
          gizmoDragging: manager?.isDragging() ?? false,
          gizmoMode: effectiveMode,
          selectedPrimary: primary,
          selectedPosition: primaryWorld
            ? [primaryWorld.x, primaryWorld.y, primaryWorld.z]
            : null,
          gizmoHandleX:
            manager && primary && effectiveMode === "translate"
              ? manager.getHandleScreenPosition("X")
              : null,
          sourceKey: sourceKeyRef.current,
          sceneRev: sceneRef.current?.revision ?? null,
          cameraPosition: [camera.position.x, camera.position.y, camera.position.z],
          controlsTarget: [controls.target.x, controls.target.y, controls.target.z],
          dampingEnabled: controls.enableDamping,
          // The resolved theme background this surface follows (N-01).
          background: bg ? rgbaToHex(bg) : null,
          themeReads: themeReadsRef.current,
          quality: tierRef.current,
          hovered: hoveredRef.current,
          gridColor: gridColorHexRef.current,
          toneMapping: renderer.toneMapping === THREE.NeutralToneMapping ? "neutral" : String(renderer.toneMapping),
        };
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, rendererReady, webglError, noLease]);

  // --- mesh edit dispatcher (PR24) ----------------------------------------------------------
  // The toolbar and the key map send commands through the store. With no session, M starts
  // one for the selected shape or part; with one, every command goes to it.
  useEffect(() => {
    if (chrome !== "editor" || !rendererReady) return undefined;
    const notify = (kind: "info" | "warn" | "error" | "success", message: string) => { host.notify({ kind: kind === "warn" ? "warning" : kind, message }); announce(message); };
    const start = (tool: "mesh" | "sculpt" | "paint" = "mesh"): void => {
      const threeScene = threeSceneRef.current;
      const camera = cameraRef.current;
      const controls = controlsRef.current;
      const renderer = rendererRef.current;
      const built = builtRef.current;
      const mount = mountRef.current;
      if (!threeScene || !camera || !controls || !renderer || !built || !mount) return;
      const ids = selectionRef.current.getSnapshot().ids;
      if (ids.length !== 1) { notify("info", COPY.editSelectFirst); return; }
      const node = sceneRef.current.nodes.find((n) => n.id === ids[0]);
      if (!node) return;
      if (node.kind === "model") { notify("warn", COPY.editLocked); return; }
      if (node.kind !== "mesh" && node.kind !== "part") { notify("info", COPY.editNotMesh); return; }
      if (node.clips?.length) { notify("warn", COPY.editHasClips); return; }
      const object = built.nodes.get(node.id);
      const extracted = object ? extractEditMesh(object) : null;
      if (!object || !extracted) { notify("warn", COPY.editNoMesh); return; }
      // Over the cap: refused before the BVH is built (EDIT_TOO_LARGE).
      if (triangleCount(extracted.mesh) > MAX_EDIT_TRIANGLES) { notify("warn", COPY.editTooLarge); return; }
      editSessionRef.current = new EditSession({
        threeScene, camera, domElement: renderer.domElement, orbit: controls, mount, store: editStore, rest,
        getScene: () => sceneRef.current,
        getGizmoMode: () => gizmoModeRef.current.getSnapshot().mode,
        object, node, mesh: extracted.mesh, startRevision: sceneRef.current.revision, tool,
        notify, invalidate: () => invalidateSceneData(sourceKeyRef.current, sceneRef.current.id),
        onEnded: () => { editSessionRef.current = null; },
        markDirtyShadow: () => shadowRef.current?.markDirty(),
      });
    };
    const unregister = editStore.setHandler((command: EditCommand) => {
      const session = editSessionRef.current;
      if (session) { void session.handle(command); return; }
      if (command.type === "toggle") start();
      else if (command.type === "tool") start(command.tool);
    });
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chrome, rendererReady, editStore]);

  // --- agent screenshot surface (PR22, C-10) -----------------------------------
  // Editor and pane surfaces answer screenshot requests while they are
  // visible and drawing; inline cards never do. The capture hides the
  // grid, markers and gizmo handles, draws one opaque frame of the
  // plugin's own canvas, and reads it back (the renderer keeps its
  // drawing buffer). Nothing outside this canvas is read.
  useEffect(() => {
    if (chrome === "card" || !visible || !rendererReady || webglError || noLease) return undefined;
    const draw = async (maxEdge: number) => {
        const renderer = rendererRef.current;
        const threeScene = threeSceneRef.current;
        const camera = cameraRef.current;
        if (!renderer || !threeScene || !camera) throw new Error("not drawing");
        const hidden: THREE.Object3D[] = [];
        const hide = (object: THREE.Object3D | null | undefined) => {
          if (object && object.visible) {
            hidden.push(object);
            object.visible = false;
          }
        };
        hide(infiniteGridRef.current?.mesh);
        hide(gridRef.current);
        hide(markRef.current);
        gizmoManagerRef.current?.forEachHelper((helper) => hide(helper));
        const previousColor = renderer.getClearColor(new THREE.Color());
        const previousAlpha = renderer.getClearAlpha();
        renderer.setClearColor(0x23262d, 1);
        renderer.render(threeScene, camera);
        const source = renderer.domElement;
        const longest = Math.max(source.width, source.height);
        const scale = longest > maxEdge ? maxEdge / longest : 1;
        let target: HTMLCanvasElement = source;
        if (scale < 1) {
          target = document.createElement("canvas");
          target.width = Math.max(1, Math.round(source.width * scale));
          target.height = Math.max(1, Math.round(source.height * scale));
          target.getContext("2d")?.drawImage(source, 0, 0, target.width, target.height);
        }
        // toBlob snapshots the bitmap when called, so the state can be restored now.
        const blob = new Promise<Blob | null>((resolve) => target.toBlob(resolve, "image/png"));
        for (const object of hidden) object.visible = true;
        renderer.setClearColor(previousColor, previousAlpha);
        const result = await blob;
        if (!result) throw new Error("the canvas could not be read");
        return { png: new Uint8Array(await result.arrayBuffer()) };
    };
    // The editor's thumbnail uploader (PR14) asks for a small frame of the same clean view.
    if (thumbnailRef) thumbnailRef.current = async () => (await draw(192)).png;
    const unregister = registerCaptureSurface({
      id: newSurfaceId(),
      sourceKey: sourceKeyRef.current,
      sceneId: () => sceneRef.current.id,
      revision: () => sceneRef.current.revision,
      capture: () => draw(1600),
    });
    return () => { unregister(); if (thumbnailRef) thumbnailRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chrome, visible, rendererReady, webglError, noLease]);

  // --- scene rebuild ---------------------------------------------------------
  useEffect(() => {
    const threeScene = threeSceneRef.current;
    if (!threeScene || !rendererReady) return undefined;
    if (isGizmoDragging()) {
      // Hold the current build mid-drag; refetch after the drag ends.
      revisionArrivedRef.current = true;
      return undefined;
    }
    // Ids in the previous build: the prune below only drops those (PR7).
    const prevNodeIds = new Set(builtRef.current?.nodes.keys() ?? []);
    const sameScene = lastBuiltSceneIdRef.current === scene.id;
    disposeCurrentBuild();
    const materialsById = new Map(scene.materials.map((m) => [m.id, m]));
    const built = buildSceneGraph(scene, materialsById);
    threeScene.add(built.root);
    builtRef.current = built;
    for (const spec of scene.nodes) if (spec.kind === "splat" && spec.splatAssetId) {
      const group = built.nodes.get(spec.id);
      getAssetBytes(rest, spec.splatAssetId).then(bytes => {
        if (builtRef.current !== built || !group) return;
        const renderer = rendererRef.current;
        if (renderer) void probeGpu(renderer).then(support => { if (builtRef.current !== built) return; setGpu(support); if (support.splats) group.add(splatMesh(bytes)); });
      }).catch(() => undefined);
    }

    if (chrome === "editor") {
      for (const spec of scene.nodes) {
        const root = built.nodes.get(spec.id);
        if (spec.kind !== "mesh" || !spec.clips?.length || !validPrimitiveClips(spec.clips) || !root) continue;
        const player = new ClipPlayer(root, primitiveClips(spec.clips));
        const unregister = registerClipPlayer(sourceKey, scene.id, spec.id, player);
        const entries = clipPlayersRef.current.get(built) ?? [];
        entries.push({ player, unregister });
        clipPlayersRef.current.set(built, entries);
      }
    }
    // Texture maps (PR15): bound at once when already decoded, else as they load.
    const assetsById = new Map(scene.assets.map((a) => [a.id, a]));
    textureRefs.current.set(
      built,
      applyMaterialMaps({
        materials: built.materials,
        materialSpecs: materialsById,
        assets: assetsById,
        sourceKey,
        cache: textureCache,
        fetchBytes: (sha256) => getAssetBytes(rest, sha256),
        isCurrent: () => builtRef.current === built,
        onBound: () => shadowRef.current?.markDirty(),
      }).held,
    );
    addPickProxies(built);
    setBuiltWireframe(built, gizmoModeRef.current.getSnapshot().wireframe);
    const snapshot = selectionRef.current.getSnapshot();
    const kept = snapshot.ids.filter(
      (id) => !prevNodeIds.has(id) || built.nodes.has(id),
    );
    if (kept.length !== snapshot.ids.length) {
      selectionRef.current.set(kept);
    }

    // View-only fill light when the scene has no lights (§5.2).
    const fill = fillLightRef.current;
    if (fill) {
      fill.visible =
        prefsRef.current.fillLight && !scene.nodes.some((n) => n.kind === "light");
    }

    // New objects scale in (only within the same scene, never on open).
    popsRef.current.clear();
    if (sameScene && prevNodeIds.size > 0 && !reducedMotion()) {
      const now = performance.now();
      for (const [id, obj] of built.nodes) {
        if (prevNodeIds.has(id)) continue;
        const kind = obj.userData.kind as string | undefined;
        if (kind === "light" || kind === "camera") continue;
        popsRef.current.set(obj, { start: now, base: obj.scale.clone() });
        obj.scale.multiplyScalar(0.85);
      }
    }

    // Row 12: opening a scene frames its contents, unless the user has
    // already placed this surface's view (E-09 keeps that pose). The
    // card always frames itself.
    if (!sameScene) {
      lastBuiltSceneIdRef.current = scene.id;
      if (chrome === "card" || !isPoseTouched(poseKey)) {
        frameAll(false, true);
      }
    }
    shadowRef.current?.markDirty();
    refreshSelectionMark();
    editSessionRef.current?.onRebuilt(editSessionRef.current && built.nodes.get(editStore.getSnapshot().nodeId ?? "") ? built.nodes.get(editStore.getSnapshot().nodeId ?? "") ?? null : null);

    let cancelled = false;
    void resolveModelSlots(built, sourceKey, rest).then((items) => {
      if (!cancelled) {
        setPlaceholders(items);
        shadowRef.current?.markDirty();
        if (!sameScene && (chrome === "card" || !isPoseTouched(poseKey))) frameAll(false, true);
      }
    });
    return () => {
      cancelled = true;
      if (!isGizmoDragging()) disposeCurrentBuild();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, rendererReady]);

  // --- selection: attach the gizmo + the mark -----------------------------
  useEffect(() => {
    const manager = gizmoManagerRef.current;
    const built = builtRef.current;
    if (!built) return;
    const primary = selectionSnap.primary;
    if (primary && chrome === "editor") { markLearning("select"); if (scene.nodes.find(node => node.id === primary)?.kind === "model") offerTip("locked"); }
    // A hidden primary detaches the gizmo and the mark (E-08).
    const primaryNode = primary
      ? scene.nodes.find((n) => n.id === primary)
      : undefined;
    const hidden = primaryNode?.visible === false;
    const obj =
      !hidden && primary ? (built.nodes.get(primary) ?? null) : null;
    manager?.setTarget(editSnap.active ? null : obj, editSnap.active ? [] : selectionSnap.ids);
    updateSelectionMark(editSnap.active ? null : obj);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, scene, rendererReady, editSnap.active]);

  // --- gizmo mode: mode, grid, wireframe --------------------------------------
  useEffect(() => {
    const manager = gizmoManagerRef.current;
    if (manager) manager.setMode(modeSnap.mode);
    editSessionRef.current?.gizmoModeChanged();
    gridVisibleRef.current = modeSnap.grid;
    if (gridRef.current) gridRef.current.visible = modeSnap.grid;
    const built = builtRef.current;
    if (built) setBuiltWireframe(built, modeSnap.wireframe);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeSnap.mode, modeSnap.grid, modeSnap.wireframe, scene, rendererReady]);

  // --- frame request (F key / Frame button) ------------------------------------
  useEffect(() => {
    if (modeSnap.frameCounter === 0) return;
    if (chrome !== "card") markPoseTouched(poseKey);
    frameSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeSnap.frameCounter]);

  // --- reset view (Reset view button, G-02) --------------------------------------
  // Glides the orbit camera to (4, 3, 6) / (0, 0, 0). Does not write the scene.
  useEffect(() => {
    if (modeSnap.resetCounter === 0) return;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    // Drain leftover damping momentum before the move (see PR5 notes:
    // residual deltas otherwise drift the camera off the reset pose).
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.enableDamping = damping;
    if (chrome !== "card") markPoseTouched(poseKey);
    moveCamera(new THREE.Vector3(4, 3, 6), new THREE.Vector3(0, 0, 0), true);
    setCameraPose(poseKey, {
      position: [4, 3, 6],
      target: [0, 0, 0],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeSnap.resetCounter]);

  /** View gizmo click: glide to look along -axis at the target. */
  function viewFrom(axisKey: string): void {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;
    const axis = GIZMO_AXES.find((a) => a.key === axisKey);
    if (!axis) return;
    markPoseTouched(poseKey);
    const dist = camera.position.distanceTo(controls.target);
    const dir = axis.dir.clone();
    // Straight up/down would make the orbit degenerate: tilt a hair.
    if (Math.abs(dir.y) > 0.99) dir.set(0, Math.sign(dir.y), 0.0001).normalize();
    moveCamera(controls.target.clone().addScaledVector(dir, dist), controls.target.clone(), true);
  }

  function disposeCurrentBuild(): void {
    const threeScene = threeSceneRef.current;
    for (const placeholder of placeholderRef.current) {
      disposeStatsPlaceholder(placeholder);
    }
    placeholderRef.current = [];
    popsRef.current.clear();
    const built = builtRef.current;
    if (built) {
      if (threeScene) threeScene.remove(built.root);
      for (const entry of clipPlayersRef.current.get(built) ?? []) entry.unregister();
      clipPlayersRef.current.delete(built);
      disposeBuiltScene(built);
      for (const template of templateRefs.current.get(built) ?? []) templateCache.release(template);
      templateRefs.current.delete(built);
      for (const texture of textureRefs.current.get(built) ?? []) textureCache.release(texture);
      textureRefs.current.delete(built);
      builtRef.current = null;
    }
  }

  async function resolveModelSlots(
    built: BuiltScene,
    key: string,
    restClient: RestFn,
  ): Promise<ModelPlaceholderInfo[]> {
    const items: ModelPlaceholderInfo[] = [];
    const fetchBytes = (sha256: string) => getAssetBytes(restClient, sha256);
    // The resolved theme stroke (G-13): the wire box uses it.
    const stroke = strokeHexRef.current;
    for (const slot of built.modelSlots) {
      const outcome = await templateCache.get(key, slot.asset, fetchBytes);
      if (cancelledSlot(built)) return items;
      if (templateGate(slot.asset) !== null && chrome === "editor") offerTip("cap");
      if (outcome && !isTemplateFailure(outcome) && templateCache.acquire(outcome)) {
        const held = templateRefs.current.get(built) ?? [];
        held.push(outcome);
        templateRefs.current.set(built, held);
        const clones = resolveModelSlot(slot, outcome);
        if (chrome === "editor" && slot.meshIndex === undefined && outcome.animations?.length && clones[0]) {
          const player = new ClipPlayer(clones[0], clipsForClone(outcome.scene, clones[0], outcome.animations));
          const unregister = registerClipPlayer(key, String(built.root.userData.sceneId), String(slot.node.userData.nodeId), player);
          const entries = clipPlayersRef.current.get(built) ?? [];
          entries.push({ player, unregister });
          clipPlayersRef.current.set(built, entries);
        }
      } else {
        // G-13: the four not-drawn cases stay distinct.
        const reason: DrawCapReason =
          outcome === null
            ? (templateGate(slot.asset) ?? "unavailable")
            : (isTemplateFailure(outcome) ? outcome.failure : "unavailable");
        const placeholder = createStatsPlaceholder(slot.asset, stroke);
        slot.node.add(placeholder.group);
        placeholderRef.current.push(placeholder);
        items.push({
          nodeName: nodeNameOf(slot),
          assetName: slot.asset.originalName || slot.asset.id,
          tris: slot.asset.stats.tris ?? null,
          hasBounds: slot.asset.stats.bounds !== undefined,
          bytes: slot.asset.bytes ?? null,
          ignored: slot.asset.stats.ignored ?? [],
          reason,
        });
      }
    }
    return items;
  }

  function cancelledSlot(built: BuiltScene): boolean {
    return builtRef.current !== built;
  }

  if (webglError) {
    return (
      <div className="p3d-message">
        <div className="p3d-overlay-card p3d-glass">
          Plastis3D cannot draw 3D in this browser: no WebGL2 context is
          available.
        </div>
      </div>
    );
  }

  if (noLease) {
    return (
      <div className="p3d-message" style={{ justifyContent: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{scene.name}</div>
          <div className="p3d-muted">
            The 3D view is unavailable right now: all three renderer slots
            are in use. The scene has {scene.nodes.length} nodes at revision{" "}
            {scene.revision}.
          </div>
        </div>
      </div>
    );
  }

  const showGizmo = interactive && (chrome === "editor" || stageWidth >= 360);
  const stageClass =
    "p3d-stage" +
    (prefs.background === "plain" ? " p3d-stage--plain" : "") +
    (tier === "low" ? " p3d-stage--low" : "");

  return (
    <div ref={stageRef} className={stageClass} style={{ width: "100%", height: "100%" }}>
      <div ref={mountRef} className="p3d-stage-mount" />
      {overlay}
      {chrome === "editor" && (() => {
        const unavailable = !gpu?.tracer;
        const why = unavailable ? (gpu ? RENDER_COPY[gpu.reason as "software" | "float" | "probe"] : RENDER_COPY.checking) : undefined;
        const hasSplats = scene.nodes.some(n => n.kind === "splat");
        const pct = Math.min(100, Math.round((renderSamples / 256) * 100));
        // The longer explanations live behind an info button, so the bar stays one small control.
        const notes = [
          unavailable && gpu ? why : null,
          gpu && !gpu.splats && hasSplats ? RENDER_COPY.splats : null,
          renderMode && hasSplats ? RENDER_COPY.meshOnly : null,
        ].filter((note) => typeof note === "string") as string[];
        return <div className={"p3d-render-bar p3d-glass" + (renderMode ? " p3d-render-bar--active" : "")} role="group" aria-label="Render">
          {!renderMode ? (
            <button type="button" className="p3d-btn p3d-btn--sm" disabled={unavailable} title={why} onClick={() => setRenderMode(true)}>
              <Icon name="camera" size={14} /> {RENDER_COPY.render}
            </button>
          ) : (
            <>
              <button type="button" className="p3d-btn p3d-btn--sm p3d-btn--outline" onClick={() => setRenderMode(false)}>{RENDER_COPY.preview}</button>
              <span className="p3d-render-progress" role="progressbar" aria-label="Render progress" aria-valuemin={0} aria-valuemax={256} aria-valuenow={renderSamples}><span style={{ width: pct + "%" }} /></span>
              <span className="p3d-render-count" aria-live="polite">{renderSamples} / 256 {RENDER_COPY.samples}</span>
              <button type="button" className="p3d-btn p3d-btn--sm p3d-btn--primary" disabled={!renderSamples} onClick={() => void saveRenderImage()}>{RENDER_COPY.save}</button>
            </>
          )}
          {notes.length > 0 && (
            <button type="button" className="p3d-iconbtn p3d-render-info" aria-label="About Render" aria-expanded={showWhy} onClick={() => setShowWhy((value) => !value)}>
              <Icon name="info" size={15} />
            </button>
          )}
          {showWhy && notes.length > 0 && <div className="p3d-render-why p3d-glass" role="note">{notes.map((note) => <p key={note}>{note}</p>)}</div>}
          {renderMessage && <span className="p3d-render-note" role="status">{renderMessage}</span>}
        </div>;
      })()}
      {showGizmo && (
        <svg
          ref={gizmoSvgRef}
          className="p3d-viewgizmo"
          width={72}
          height={72}
          viewBox="0 0 72 72"
          role="group"
          aria-label="View direction"
          style={{ position: "absolute", top: 10, right: 10, zIndex: 3, overflow: "visible" }}
        >
          <circle cx={36} cy={36} r={33} fill="var(--p3d-glass)" stroke="var(--p3d-stroke)" />
          {GIZMO_AXES.filter((a) => a.positive).map((a) => (
            <line
              key={a.key}
              data-line={a.key}
              x1={36}
              y1={36}
              x2={36}
              y2={36}
              stroke={`var(--p3d-${a.cls})`}
              strokeWidth={2}
              strokeLinecap="round"
            />
          ))}
          {GIZMO_AXES.map((a) => (
            <g
              key={a.key}
              data-axis={a.key}
              role="button"
              tabIndex={0}
              aria-label={GIZMO_NAMES[a.key]}
              style={{ cursor: "pointer" }}
              onClick={() => viewFrom(a.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  viewFrom(a.key);
                }
              }}
            >
              <title>{GIZMO_NAMES[a.key]}</title>
              <circle
                r={a.positive ? 8 : 5.5}
                fill={a.positive ? `var(--p3d-${a.cls})` : "var(--p3d-raised)"}
                stroke={`var(--p3d-${a.cls})`}
                strokeWidth={a.positive ? 0 : 1.5}
              />
              {a.label && (
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={9}
                  fontWeight={700}
                  fill="#fff"
                  style={{ pointerEvents: "none" }}
                >
                  {a.label}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      {hintShown && (
        <div className={`p3d-hint p3d-glass${hintGone ? " p3d-hint--gone" : ""}`} role="note">
          <Icon name="rotate" size={14} />
          <span><b>Drag</b> to look around · <b>Right-drag</b> to move the view · <b>Scroll</b> to zoom</span>
          <button
            type="button"
            className="p3d-iconbtn p3d-iconbtn--sm"
            aria-label="Hide this tip"
            onClick={() => dismissHint()}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
      {guardTripped && prefs.quality === "auto" && (
        <div className="p3d-stage-note p3d-glass" role="status">
          Simplified view for speed.
        </div>
      )}
      {placeholders.length > 0 && (
        // Not a modal: pointer events pass through, so orbit still works
        // on the wire box underneath (G-13).
        <div className="p3d-overlay-center">
          {placeholders.map((item) => {
            const text = drawCapOverlayText(item);
            return (
              <div key={`${item.nodeName}:${item.assetName}`} className="p3d-overlay-card p3d-glass">
                <div className="p3d-muted">
                  Model &ldquo;{item.nodeName}&rdquo; ({item.assetName})
                </div>
                <b>{text.title}</b>
                {text.detail && <div>{text.detail}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- helpers -----------------------------------------------------------------

function nodeNameOf(slot: ModelSlot): string {
  return slot.node.name || slot.asset.id;
}

/**
 * Invisible pick proxies for light and camera nodes: their objects have
 * no geometry, so a raycast could never select them. three.js r180
 * raycasts invisible objects, so the proxy stays clickable. Shared
 * geometry/material (never disposed); the proxy meshes leave with the
 * built root on dispose.
 */
function addPickProxies(built: BuiltScene): void {
  for (const obj of built.nodes.values()) {
    const kind = obj.userData.kind as string | undefined;
    if (kind !== "light" && kind !== "camera") continue;
    const proxy = new THREE.Mesh(PICK_PROXY_GEOMETRY, PICK_PROXY_MATERIAL);
    proxy.visible = false;
    proxy.name = `pick-proxy:${obj.userData.nodeId as string}`;
    obj.add(proxy);
  }
}
