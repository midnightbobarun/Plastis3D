// tests/harness/mock-host.ts — Tier 4 mock Hermes host (stage-0 §4.3).
//
// Lets the built desktop/plugin.js bundle be tested in a real browser page
// WITHOUT Hermes. This file plays two roles:
//   1. The @hermes/plugin-sdk stub: tests/harness/vite.config.mts aliases
//      '@hermes/plugin-sdk' to this file, so the bundle's SDK import
//      resolves here. npm react is the host React stand-in.
//   2. The page entry: mock-host.html loads this module, which mounts the
//      mock host, dynamically imports the built bundle, calls its
//      register(ctx), and renders every registered pane (and route) into
//      the page.
//
// PluginContext is a plain TS interface (register, rest, storage, files,
// onEvent, host.state, host.paneVisibility), so a hand-written fake is
// straightforward.
//
// host.paneVisibility is a FUNCTION returning a readonly reactive atom, not
// a boolean. The mock reports visibility for plastis3d:viewport and
// plastis3d:scenes; any other id (a local id such as "viewport" never
// reports visible) returns an atom that is always false.
//
// FIDELITY LIMITS (recorded, not hidden): the mock can drift from the real
// host. It only APPROXIMATES:
//   - ctx.rest serves a STATEFUL in-memory copy of the one-scene fixture
//     (tests/harness/fixture-scene.ts), seeded per page load. PATCH
//     /scenes/{id} enforces baseRevision (mismatch rejects with an error
//     carrying code REVISION_CONFLICT), applies ops (update_node merges
//     transform/visible/materialId/parent/name; set_material merges
//     material; add_node appends with a minted id; delete_node removes a
//     subtree; duplicate_node deep-copies with new ids; build replaces
//     nodes/materials; undo/redo pop/push a simple history stack of
//     specs), bumps the revision, and returns the feedback envelope.
//     POST /scenes creates a scene (default rig nodes copied from the
//     fixture, revision 1). DELETE /scenes/{id} returns
//     { ok: true, deleted }. POST /scenes/{id}/export resolves a canned
//     success { ok, path, bytes, revision, stats, filename } (PR6: the
//     real gateway exports since PR6; the mock has no real GLB bytes
//     behind it — bytes is 0 and the path is the gateway's naming
//     scheme — so the success path is exercisable without a backend).
//     POST .../imports resolves a canned PR7 success: the feedback
//     envelope with the two-primitive fixture asset row and one new
//     model node (see mockAssetBase64 / the imports branch for the
//     fidelity limits — the mock has no import engine and no exploder,
//     so it always returns the locked-style model node and ignores
//     the uploaded bytes). GET /assets/{sha256} resolves the D1 base64
//     envelope { ok, sha256, size, bytes } for the fixture hash (real
//     GLB bytes, fetched from tests/fixtures/two-primitive.glb and
//     base64-encoded at mock runtime) and rejects ASSET_NOT_FOUND for
//     any other hash. There is no real gateway behind it.
//     Envelope stats are analytic primitive counts (exact for the
//     fixture primitives; approximate for capsule/cylinder verts).
//   - The broadcast subscription path is exercised on demand: onEvent
//     records the subscription type in report.eventSubscriptions and
//     keeps the listener, and tests deliver gateway events with
//     __emit / __emitSceneChanged (0-E) — a scene.changed payload
//     distinct from a poll refetch. Broadcast delivery itself was
//     proven live in PR1.
//   - host.navigate (records the path and writes location.hash like the
//     real host; does not route),
//   - captureGatewayFileDownload records the download against the
//     sourceKey captured at capture time (no real save dialog),
//   - theme variables (the page has no Hermes theme; --ui-* vars are unset),
//   - the 10-second module-evaluation deadline (not enforced).
//   - host.profileRoutes returns the current route list (one local route
//     by default; tests switch it with __setProfileRoutes + __remount).
//     The mock has no registry.
//   - The SIMPLE UI kit stubs are minimal plain-HTML equivalents
//     preserving the props the plugin uses; they carry no host styling,
//     no Radix portal/focus behaviour, and no tooltips (Tip renders its
//     label as a title attribute).
//   - ctx.files is a test-driven door: folders/list/stat/readDataUrl read
//     window.__plastis3dMock.__files (empty by default). requestFolder
//     resolves { ok: true, folder: null } (cancel — the mock has no
//     picker); tests simulate a grant by setting __files.folders.
// Tier 4 tests the bundle against this mock, never against Hermes — Tier 6
// (live Desktop: hermes plugins doctor / validate, real pane) remains the
// only true check. WebGL in Playwright runs via SwiftShader (Playwright
// adds --enable-unsafe-swiftshader automatically).
import { createElement, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  FIXTURE_SCENE_ID,
  fixtureSceneSpec,
} from "./fixture-scene";
import type { ImportFileEntry, ImportFolder } from "../../src/io/importFlow";
import type {
  AssetSpec,
  MaterialSpec,
  NodeSpec,
  PrimitiveSpec,
  SceneEnvelope,
  SceneSpec,
  SceneStats,
} from "../../src/types";

// ------------------------------------------------------------ SDK stub surface
// Area constants mirror the pinned host source exactly
// (~/.hermes/hermes-agent/apps/desktop/src/sdk/areas.ts and
// src/app/routes.ts): PANES_AREA 'panes', ROUTES_AREA 'routes',
// SIDEBAR_NAV_AREA 'sidebar.nav', PALETTE_AREA 'palette',
// STATUSBAR_AREAS { left: 'statusBar.left', right: 'statusBar.right' }.
export const PANES_AREA = "panes";
export const ROUTES_AREA = "routes";
export const SIDEBAR_NAV_AREA = "sidebar.nav";
export const PALETTE_AREA = "palette";
export const STATUSBAR_AREAS = {
  left: "statusBar.left",
  right: "statusBar.right",
} as const;
export const KEYBINDS_AREA = "keybinds";
export const TRANSCRIPT_DIRECTIVE_AREA = "transcript.directives";
export const TOOL_MEDIA_RENDERER_AREA = "transcript.toolMedia";

/** Deep copy for JSON-safe spec data (the mock never shares its state). */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** An Error carrying a gateway-style .code (what src/api.ts reads). */
function mockError(code: string, message: string): Error {
  const error = new Error(message);
  (error as Error & { code: string }).code = code;
  return error;
}

// --- PR22: the screenshot protocol (mirrors plastis3d_scene/capture.py) ------
interface MockCapture { id: string; scene: string; revision: number; status: "pending" | "claimed" | "done"; surface: string | null }
const mockCaptures = new Map<string, MockCapture>();
const captureResults: Array<{ id: string; surface: string; revision: number; png: string }> = [];

function mockCaptureRest(path: string, method: string, opts?: unknown): unknown {
  const body = ((opts as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as Record<string, unknown>;
  if (method === "GET" && path.startsWith("/captures/pending")) {
    const scene = new URLSearchParams(path.split("?")[1] ?? "").get("scene");
    const requests = [...mockCaptures.values()].filter((c) => c.status === "pending" && (!scene || c.scene === scene)).map(({ id, scene: sceneId, revision }) => ({ id, scene: sceneId, revision, expiresIn: 10 }));
    return { ok: true, requests };
  }
  const match = path.match(/^\/captures\/([0-9a-f]{32})(\/claim)?$/);
  const found = match ? mockCaptures.get(match[1]) : undefined;
  if (!match || method !== "POST" || !found) throw mockError("CAPTURE_NOT_FOUND", "no such capture request");
  const surface = String(body.surface ?? "");
  if (match[2]) {
    if (found.status !== "pending" && found.surface !== surface) throw mockError("CAPTURE_CONFLICT", "another surface already claimed this capture request");
    found.status = "claimed";
    found.surface = surface;
    return { ok: true, request: { id: found.id, scene: found.scene, revision: found.revision } };
  }
  if (found.status !== "claimed") throw mockError("CAPTURE_NOT_FOUND", "already answered");
  if (found.surface !== surface) throw mockError("CAPTURE_CONFLICT", "claimed by another surface");
  if (Number(body.revision) < found.revision) throw mockError("CAPTURE_STALE", "stale");
  found.status = "done";
  captureResults.push({ id: found.id, surface, revision: Number(body.revision), png: String(body.png ?? "") });
  return { ok: true, revision: Number(body.revision) };
}

// --- gateway activation epoch ------------------------------------------------
let gatewayEpoch = 0;

/**
 * Whether the mock ctx carries a files door (merge fix, PR5 report).
 * The real host omits ctx.files on older shells; the import-dialog
 * noFilesDoor test flips this off with __setFilesEnabled(false) +
 * __remount() to exercise that branch. On (default): a full door.
 * A page reload resets it (module state).
 */
let filesDoorEnabled = true;

/** The mock gateway activation epoch (starts 0; tests move it). */
export function gatewayActivationEpoch(): number {
  return gatewayEpoch;
}

// --- matchMedia stub (0-E) ---------------------------------------------------
// The mock page has a real matchMedia, but its answers are fixed by the
// browser; tests need a toggleable `(prefers-reduced-motion: reduce)`
// (G-03). This stub answers that one query from module state and
// delegates every other query to the native matchMedia. Listeners
// registered on the stub are notified on __setReducedMotion.
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
let reducedMotion = false;
/** Change listeners on the reduced-motion stub query, shared across instances. */
const reducedMotionListeners = new Set<
  (event: { matches: boolean; media: string }) => void
>();

function reducedMotionQueryList(): MediaQueryList {
  const list = {
    get matches(): boolean {
      return reducedMotion;
    },
    media: REDUCED_MOTION_QUERY,
    onchange: null as
      | ((event: { matches: boolean; media: string }) => void)
      | null,
    addEventListener(
      type: string,
      listener: (event: { matches: boolean; media: string }) => void,
    ): void {
      if (type === "change") reducedMotionListeners.add(listener);
    },
    removeEventListener(
      type: string,
      listener: (event: { matches: boolean; media: string }) => void,
    ): void {
      if (type === "change") reducedMotionListeners.delete(listener);
    },
    addListener(
      listener: (event: { matches: boolean; media: string }) => void,
    ): void {
      reducedMotionListeners.add(listener);
    },
    removeListener(
      listener: (event: { matches: boolean; media: string }) => void,
    ): void {
      reducedMotionListeners.delete(listener);
    },
    dispatchEvent(): boolean {
      return true;
    },
  };
  return list as unknown as MediaQueryList;
}

function installMatchMediaStub(): void {
  if (typeof window === "undefined") return;
  const native = window.matchMedia.bind(window);
  window.matchMedia = (query: string): MediaQueryList => {
    if (query.trim() === REDUCED_MOTION_QUERY) {
      return reducedMotionQueryList();
    }
    return native(query);
  };
}

// --- host.state.viewport stub (0-E) -------------------------------------------
// host.state.viewport is ReadableAtom<{ width, height, narrow }> (SDK doc
// :1398). The mock reports a 1280x800 non-narrow viewport; tests flip
// it with __setViewport (G-15 / narrow-pane specs). The atom itself is
// created next to the host singleton below (after the MockAtom class).

// --- mock scene store (stateful, seeded per page load) -----------------------
const mockScenes = new Map<string, SceneSpec>();
const mockHistory = new Map<string, { undo: SceneSpec[]; redo: SceneSpec[] }>();
const mockThumbnails = new Map<string, { revision: number; png: string }>();
const mockDrafts = new Map<string, { nodeId: string; baseRevision: number; currentRevision: number; from: Record<string, unknown> | null; mesh: unknown; savedAt: number }>();
let nodeCounter = 0;

function seedMockScenes(): void {
  mockScenes.clear();
  mockHistory.clear();
  nodeCounter = 0;
  const spec = fixtureSceneSpec();
  mockScenes.set(spec.id, spec);
  mockHistory.set(spec.id, { undo: [], redo: [] });
}

seedMockScenes();

/** Analytic primitive counts (exact for the fixture primitives). */
function analyticPrimitive(primitive: PrimitiveSpec): { tris: number; verts: number } {
  const p = primitive as unknown as Record<string, number>;
  switch (primitive.type) {
    case "box":
      return { tris: 12, verts: 24 };
    case "sphere": {
      const ws = p.widthSegments ?? 16;
      const hs = p.heightSegments ?? 12;
      return { tris: 2 * ws * (hs - 1), verts: (ws + 1) * (hs + 1) };
    }
    case "cylinder": {
      const rs = p.radialSegments ?? 16;
      return { tris: 4 * rs, verts: (rs + 1) * 4 + 2 };
    }
    case "cone": {
      const rs = p.radialSegments ?? 16;
      return { tris: 2 * rs, verts: (rs + 1) * 3 + 1 };
    }
    case "torus": {
      const radial = p.radialSegments ?? 12;
      const tubular = p.tubularSegments ?? 24;
      return { tris: 2 * radial * tubular, verts: (radial + 1) * (tubular + 1) };
    }
    case "plane":
      return { tris: 2, verts: 4 };
    case "capsule": {
      // Approximation only (the fixture has no capsule; no test asserts it).
      const radial = p.radialSegments ?? 8;
      const cap = p.capSegments ?? 4;
      return {
        tris: radial * (cap * 4 + 2),
        verts: (radial + 1) * (cap * 2 + 3),
      };
    }
    default:
      return { tris: 12, verts: 24 };
  }
}

/** Envelope stats computed from the spec (fixture: 376 tris, 269 verts). */
function sceneStats(spec: SceneSpec): SceneStats {
  let tris = 0;
  let verts = 0;
  const assetsById = new Map(spec.assets.map((a) => [a.id, a]));
  for (const node of spec.nodes) {
    if (node.kind === "mesh" && node.primitive) {
      const counts = analyticPrimitive(node.primitive);
      tris += counts.tris;
      verts += counts.verts;
    } else if (
      (node.kind === "model" || node.kind === "part") &&
      node.modelAssetId
    ) {
      const asset = assetsById.get(node.modelAssetId);
      if (asset) {
        tris += asset.stats.tris ?? 0;
        verts += asset.stats.verts ?? 0;
      }
    }
  }
  return { tris, verts, materials: spec.materials.length, nodes: spec.nodes.length };
}

/** The feedback envelope for a stored spec (deep-copied out). */
function envelopeFor(spec: SceneSpec): SceneEnvelope {
  const history = mockHistory.get(spec.id) ?? { undo: [], redo: [] };
  return {
    ok: true,
    scene: {
      id: spec.id,
      revision: spec.revision,
      units: spec.units,
      upAxis: spec.upAxis,
    },
    nodes: deepCopy(spec.nodes),
    materials: deepCopy(spec.materials),
    assets: deepCopy(spec.assets),
    stats: sceneStats(spec),
    feedback: {
      canUndo: history.undo.length > 0,
      canRedo: history.redo.length > 0,
      defaultsAdded: [],
      historyTruncated: false,
    },
  };
}

/** Apply one PATCH op to a working copy (throws a coded error on refusal). */
function applyMockOp(spec: SceneSpec, op: Record<string, unknown>): void {
  switch (op.op) {
    case "set_scene_name": { spec.name = op.name as string; return; }
    case "update_node": {
      const id = op.id as string;
      const node = spec.nodes.find((n) => n.id === id);
      if (!node) {
        throw mockError("NODE_NOT_FOUND", `NODE_NOT_FOUND no node with id ${JSON.stringify(id)}`);
      }
      const changes =
        op.changes && typeof op.changes === "object"
          ? (op.changes as Record<string, unknown>)
          : op;
      for (const [key, value] of Object.entries(changes)) {
        if (key === "op" || key === "id" || key === "changes") continue;
        if (
          key === "primitive" &&
          value &&
          typeof value === "object" &&
          node.primitive
        ) {
          node.primitive = { ...node.primitive, ...(value as object) };
        } else if (
          (key === "light" || key === "camera") &&
          value &&
          typeof value === "object" &&
          (node as unknown as Record<string, unknown>)[key]
        ) {
          (node as unknown as Record<string, unknown>)[key] = {
            ...((node as unknown as Record<string, unknown>)[key] as object),
            ...(value as object),
          };
        } else {
          (node as unknown as Record<string, unknown>)[key] = deepCopy(value);
        }
      }
      break;
    }
    case "set_material": {
      const material = deepCopy(op.material as MaterialSpec); // never mutate the recorded request
      // Like the gateway: a map set to null is cleared, not stored.
      for (const slot of ["baseColorMap", "normalMap", "metallicRoughnessMap", "emissiveMap"] as const) {
        if ((material as unknown as Record<string, unknown>)[slot] === null) delete material[slot];
      }
      const at = spec.materials.findIndex((m) => m.id === material.id);
      if (at >= 0) spec.materials[at] = deepCopy(material);
      else spec.materials.push(deepCopy(material));
      if (Array.isArray(op.assignTo)) {
        for (const nodeId of op.assignTo as string[]) {
          const node = spec.nodes.find((n) => n.id === nodeId);
          if (node) node.materialId = material.id;
        }
      }
      break;
    }
    case "add_node": {
      const node = deepCopy(op.node) as NodeSpec;
      if (!node.id) node.id = `n_mock${++nodeCounter}`;
      spec.nodes.push(node);
      break;
    }
    case "delete_node": {
      const id = op.id as string;
      const remove = new Set<string>([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of spec.nodes) {
          if (n.parent && remove.has(n.parent) && !remove.has(n.id)) {
            remove.add(n.id);
            grew = true;
          }
        }
      }
      spec.nodes = spec.nodes.filter((n) => !remove.has(n.id));
      break;
    }
    case "duplicate_node": {
      const id = op.id as string;
      const root = spec.nodes.find((n) => n.id === id);
      if (!root) {
        throw mockError("NODE_NOT_FOUND", `NODE_NOT_FOUND no node with id ${JSON.stringify(id)}`);
      }
      const subtree: NodeSpec[] = [root];
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of spec.nodes) {
          if (
            n.parent &&
            subtree.some((s) => s.id === n.parent) &&
            !subtree.some((s) => s.id === n.id)
          ) {
            subtree.push(n);
            grew = true;
          }
        }
      }
      const idMap = new Map<string, string>();
      for (const n of subtree) idMap.set(n.id, `n_mock${++nodeCounter}`);
      for (const n of subtree) {
        const copy = deepCopy(n);
        copy.id = idMap.get(n.id) as string;
        if (copy.parent && idMap.has(copy.parent)) {
          copy.parent = idMap.get(copy.parent) as string;
        }
        spec.nodes.push(copy);
      }
      break;
    }
    case "build": {
      if (Array.isArray(op.nodes)) spec.nodes = deepCopy(op.nodes);
      if (Array.isArray(op.materials)) spec.materials = deepCopy(op.materials);
      if (typeof op.name === "string") spec.name = op.name;
      break;
    }
    case "import_asset": {
      // Mock-only convenience: the real gateway REFUSES import_asset in
      // a PATCH (SPEC_INVALID; only the import engine's scan produces
      // it — pre-PR9 completion plan, audit A-2). Fidelity gap, test
      // setup only (R-31). It attaches an
      // already-described asset row plus its model node, for tests that
      // need a model node without an import round-trip.
      if (op.asset && typeof op.asset === "object") {
        spec.assets.push(deepCopy(op.asset) as AssetSpec);
      }
      if (op.node && typeof op.node === "object") {
        const node = deepCopy(op.node) as NodeSpec;
        if (!node.id) node.id = `n_mock${++nodeCounter}`;
        spec.nodes.push(node);
      }
      break;
    }
    default:
      throw mockError(
        "SPEC_INVALID",
        `SPEC_INVALID mock host: unsupported op ${JSON.stringify(op.op)}`,
      );
  }
}

// --- profile routes (switched by tests) --------------------------------------
export interface MockProfileRoute {
  profile: string;
  targetProfile: string;
  connectionId: string;
  mode: string;
}

let currentRoutes: MockProfileRoute[] = [
  {
    profile: "default",
    targetProfile: "default",
    connectionId: "mock-connection-1",
    mode: "local",
  },
];

/** The sourceKey for the current first route (connectionId:profile). */
function currentSourceKey(): string {
  const route = currentRoutes[0];
  return route ? `${route.connectionId}:${route.profile}` : "local:default";
}

// --- downloads (captureGatewayFileDownload) ----------------------------------
export interface MockDownload {
  path: string;
  suggestedName: string;
  sourceKey: string;
}

const downloads: MockDownload[] = [];

/**
 * Mock approximation: no gateway file bridge. The returned function
 * records the download against the sourceKey captured at CAPTURE time
 * (from profileRoutes()[0]) — never retargeted by a later host switch.
 * The export-source test invokes it through __invokeCapturedDownload.
 */
export function captureGatewayFileDownload(): (
  path: string,
  suggestedName: string,
) => Promise<void> {
  const capturedSourceKey = currentSourceKey();
  return async (path: string, suggestedName: string) => {
    downloads.push({ path, suggestedName, sourceKey: capturedSourceKey });
  };
}

/** The function from the most recent __captureDownload() call. */
let pendingDownload: ((path: string, suggestedName: string) => Promise<void>) | null = null;

// --- SIMPLE UI kit stubs (plain-HTML equivalents) ---------------------------
// Minimal stand-ins for the SDK's simple components, preserving the props
// the plugin uses. No host styling, no Radix behaviour. These are named
// exports of the SDK stub module, matching the real SDK barrel
// (apps/desktop/src/sdk/index.ts re-exports them from @hermes/plugin-sdk).
type AnyProps = Record<string, unknown>;

// Host SDK settings primitives: app/settings/primitives.tsx, ListRow and ToggleRow.
export function ListRow({ title, action }: { title: ReactNode; action?: ReactNode }) { return createElement("div", null, title, action); }
export function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return createElement("label", null, label, createElement("input", { type: "checkbox", role: "switch", "aria-label": label, "aria-checked": checked, checked, onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked) })); }
export function KbdGroup({ keys }: { keys: string[] }) { return createElement("kbd", null, keys.join(" + ")); }
export function Button(props: AnyProps) {
  const { children, variant, size, loading, disabled, ...rest } = props as {
    children?: ReactNode;
    variant?: string;
    size?: string;
    loading?: boolean;
    disabled?: boolean;
  } & AnyProps;
  return createElement(
    "button",
    {
      type: "button",
      ...rest,
      disabled: disabled === true || loading === true,
      "aria-busy": loading === true ? true : undefined,
      "data-variant": variant,
      "data-size": size,
    },
    children,
  );
}

export function Input(props: AnyProps) {
  return createElement("input", props as never);
}

export function Badge(props: AnyProps) {
  const { children, variant, size, ...rest } = props as {
    children?: ReactNode;
    variant?: string;
    size?: string;
  } & AnyProps;
  return createElement(
    "span",
    { ...rest, "data-variant": variant, "data-size": size },
    children,
  );
}

export function Codicon(props: AnyProps) {
  const { name, ...rest } = props as { name: string } & AnyProps;
  return createElement(
    "span",
    { ...rest, "aria-hidden": true, "data-name": name },
    name,
  );
}

export function EmptyState(props: AnyProps) {
  const { title, description, ...rest } = props as {
    title: string;
    description?: string;
  } & AnyProps;
  return createElement(
    "div",
    rest,
    createElement("div", null, title),
    description ? createElement("div", null, description) : null,
  );
}

export function ErrorState(props: AnyProps) {
  const { title, description, children, ...rest } = props as {
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
  } & AnyProps;
  return createElement(
    "div",
    rest,
    createElement("div", null, title),
    description ? createElement("div", null, description) : null,
    children,
  );
}

export function CopyButton(props: AnyProps) {
  const { text, label, showLabel, onCopied, onCopyError, ...rest } = props as {
    text: string | { text: string };
    label?: string;
    showLabel?: boolean;
    onCopied?: () => void;
    onCopyError?: (error: unknown) => void;
  } & AnyProps;
  const payload = typeof text === "string" ? text : text?.text ?? "";
  return createElement(
    "button",
    {
      type: "button",
      ...rest,
      onClick: () => {
        const done = () => onCopied?.();
        try {
          const result = (
            navigator as Navigator & { clipboard?: { writeText: (t: string) => Promise<void> } }
          ).clipboard?.writeText(payload);
          if (result && typeof result.then === "function") {
            void result.then(done, (err: unknown) => onCopyError?.(err));
          } else {
            done();
          }
        } catch (err) {
          onCopyError?.(err);
        }
      },
    },
    showLabel === true ? (label ?? "Copy") : "Copy",
  );
}

export function GlyphSpinner(props: AnyProps) {
  const { ariaLabel, ...rest } = props as { ariaLabel?: string } & AnyProps;
  return createElement(
    "span",
    { ...rest, "aria-label": ariaLabel ?? "Loading" },
    "⠋",
  );
}

/**
 * Skeleton stub (G-12): the real component is a pulsing div with
 * `data-slot="skeleton"`; the stub renders the same hook (no pulse
 * animation in the mock — the harness asserts presence, not motion).
 */
export function Skeleton(props: AnyProps) {
  return createElement("div", { ...props, "data-slot": "skeleton" });
}

/**
 * Separator stub (N-03): the real component is a Radix
 * `SeparatorPrimitive.Root` with `data-slot="separator"`; it has no
 * portal (unlike Dialog), so a plain element is a faithful stub —
 * the PR5 Radix-mock-host concern is narrower here (see D-IMPL-19).
 */
export function Separator(props: AnyProps) {
  const { orientation, decorative, ...rest } = props as {
    orientation?: string;
    decorative?: boolean;
  } & AnyProps;
  return createElement("div", {
    ...rest,
    "data-slot": "separator",
    "data-orientation": orientation ?? "horizontal",
    role: decorative === false ? "separator" : undefined,
  });
}

/**
 * StatusDot stub (G-14): the real component is an aria-hidden span
 * coloured by `tone`; the stub renders the same hook + tone so the
 * harness can assert the degraded-store indicator is present.
 */
export function StatusDot(props: AnyProps) {
  const { tone, style, ...rest } = props as {
    tone?: string;
    style?: Record<string, unknown>;
  } & AnyProps;
  return createElement("span", {
    ...rest,
    "aria-hidden": true,
    "data-tone": tone ?? "muted",
    // The real StatusDot is a visibly sized dot; an empty unstyled
    // span would be "hidden" to Playwright and misrepresent the host.
    style: {
      display: "inline-block",
      width: 8,
      height: 8,
      borderRadius: "50%",
      background:
        tone === "warn"
          ? "#b45309"
          : tone === "bad"
            ? "#b91c1c"
            : tone === "good"
              ? "#15803d"
              : "#6b7280",
      ...style,
    },
  });
}

export function SearchField(props: AnyProps) {
  const { placeholder, value, onChange, inputRef, ...rest } = props as {
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
    inputRef?: { current: HTMLInputElement | null };
  } & AnyProps;
  return createElement("input", {
    type: "search",
    ...rest,
    placeholder,
    value,
    ref: inputRef,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  });
}

export function Tip(props: AnyProps) {
  const { label, children } = props as {
    label: ReactNode;
    children: ReactNode;
  };
  return createElement(
    "span",
    { title: typeof label === "string" ? label : undefined },
    children,
  );
}

export function Checkbox(props: AnyProps) {
  const { checked, onCheckedChange, ...rest } = props as {
    checked?: boolean | "indeterminate";
    onCheckedChange?: (checked: boolean | "indeterminate") => void;
  } & AnyProps;
  return createElement("input", {
    type: "checkbox",
    ...rest,
    checked: checked === true,
    onChange: (event: { target: { checked: boolean } }) =>
      onCheckedChange?.(event.target.checked),
  });
}

export function SegmentedControl(props: AnyProps) {
  const { options, value, onChange, disabled, ...rest } = props as {
    options: ReadonlyArray<{ id: string; label: string }>;
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
  } & AnyProps;
  return createElement(
    "div",
    { ...rest, "aria-disabled": disabled === true ? true : undefined },
    options.map((option) =>
      createElement(
        "button",
        {
          key: option.id,
          type: "button",
          "aria-pressed": value === option.id,
          disabled: disabled === true,
          onClick: () => onChange(option.id),
        },
        option.label,
      ),
    ),
  );
}

/** Minimal readonly reactive atom: .get() in handlers, useValue() in React. */
export class MockAtom<T> {
  private value: T;
  private listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  /** Test-only: flip the atom and notify subscribers. */
  set(next: T): void {
    this.value = next;
    for (const fn of [...this.listeners]) fn(next);
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export type ReadableAtom<T> = Pick<MockAtom<T>, "get" | "subscribe">;

export function useValue<T>(atom: ReadableAtom<T>): T {
  return useSyncExternalStore(
    (onChange) => atom.subscribe(() => onChange()),
    () => atom.get(),
  );
}

// --- host singleton (approximation of the real host object) -----------------
/** The host.state.viewport atom (0-E): 1280x800, not narrow, by default. */
const viewportAtom = new MockAtom({
  width: 1280,
  height: 800,
  narrow: false,
});

const paneAtoms = new Map<string, MockAtom<boolean>>();

// --- useTheme stub (N-01) ------------------------------------------------------
// The SDK's useTheme() hook (SDK doc :407–418) reads the painted theme.
// The mock keeps a single themeName with a test knob; subscribers
// re-render through useSyncExternalStore, like useValue's atoms. The
// snapshot object is replaced only when the name changes (a fresh
// object per getSnapshot call would re-render in a loop).
let currentTheme: { themeName: string } = { themeName: "default" };
const themeNameListeners = new Set<() => void>();

export function useTheme(): { themeName: string } {
  return useSyncExternalStore(
    (onChange) => {
      themeNameListeners.add(onChange);
      return () => {
        themeNameListeners.delete(onChange);
      };
    },
    () => currentTheme,
  );
}

function setThemeName(name: string): void {
  if (name === currentTheme.themeName) return;
  currentTheme = { themeName: name };
  for (const fn of [...themeNameListeners]) fn();
}

function paneAtom(id: string): MockAtom<boolean> {
  let atom = paneAtoms.get(id);
  if (!atom) {
    // Only the fully-qualified contributed pane ids report visible. A local
    // id such as "viewport" (without the plastis3d: prefix) never does.
    atom = new MockAtom(id === "plastis3d:viewport" || id === "plastis3d:scenes");
    paneAtoms.set(id, atom);
  }
  return atom;
}

export interface MockNotification {
  kind: string;
  message: string;
}

export interface MockRestRequest {
  path: string;
  opts?: unknown;
  sourceKey: string;
}

export interface MockFilesState {
  folders: ImportFolder[];
  listing: ImportFileEntry[];
  files: Record<string, { size: number; dataUrl?: string }>;
  /** R-04: list() reports `truncated` (the host's 10,000-entry cap). */
  truncated?: boolean;
}

export interface MockHostReport {
  started: boolean;
  pluginId: string | null;
  contributions: Array<{ id: string; area: string; title?: string }>;
  panesMounted: string[];
  routesMounted: string[];
  /** STATUSBAR_AREAS contributions rendered into #statusbar (PR5: the status chip). */
  statusbarMounted: string[];
  canvasPresent: boolean;
  errors: string[];
  restCalls: unknown[];
  /** Every ctx.rest call with its opts and the sourceKey at call time. */
  restRequests: MockRestRequest[];
  navigations: string[];
  /** Every ctx.onEvent subscription type, in order (broadcast test). */
  eventSubscriptions: string[];
  /** Every host.notify / host.notifyError, in order. */
  notifications: MockNotification[];
  /** The mock gateway activation epoch (starts 0). */
  gatewayEpoch: number;
  /** Downloads recorded by captureGatewayFileDownload(). */
  downloads: MockDownload[];
  /** The mock ctx.files door state (tests set folders/listing/files). */
  __files: MockFilesState;
  /** Every path passed to the files door's readDataUrl, in order (PR12: a texture is never read). */
  __fileReads: string[];
  /** Image asset ids the view fetched through GET /assets (PR15). */
  imageFetches: string[];
  /** Every GET /scenes/{id}/check the mock served (PR16). */
  checkRequests: Array<{ sceneId: string; revision: number; kind: string; budget: string }>;
  /** Every POST /scenes/{id}/cleanup the mock served (PR18). */
  cleanupRequests: Array<{ dryRun: boolean; baseRevision: number; operations: string[] | null }>;
  /**
   * Test hook: flip a pane's visibility atom (e.g.
   * setPaneVisible("plastis3d:viewport", false)) so poll/visibility
   * tests can hide the viewport and assert the 4 s poll stops and the
   * frame loop pauses.
   */
  setPaneVisible: (paneId: string, visible: boolean) => void;
  /** Test hook: set the mock gateway activation epoch. */
  __setGatewayEpoch: (n: number) => void;
  /**
   * Test hook: pretend this shell has (or lacks) a ctx.files door.
   * Takes effect on the next mount/remount — the import-dialog
   * noFilesDoor test flips it off, then __remount()s. A page reload
   * resets it to on.
   */
  __setFilesEnabled: (enabled: boolean) => void;
  /**
   * Test hook: simulate a concurrent external edit — bump the fixture
   * scene's revision by one and return the new revision.
   */
  __bumpRevision: () => number;
  /** Test hook: switch the mock's profileRoutes (no remount). */
  __setProfileRoutes: (routes: MockProfileRoute[]) => void;
  /** Test hook: re-run register with a fresh ctx (after a route switch). */
  __remount: () => Promise<void>;
  /** The next POST /images is refused with this gateway code (PR15). */
  __refuseNextImage: (code: string, message: string) => void;
  /** Merge these fields over the mock's default compatibility report (PR16). */
  __setCheckReport: (fields: Record<string, unknown> | null) => void;
  /** What the next POST /scenes/{id}/cleanup would do (PR18). */
  __setCleanup: (changes: {
    materialsMerged: Array<{ from: string; into: string }>;
    materialsRemoved: string[];
    groupsRemoved: Array<{ id: string; name?: string }>;
    nodesRepointed: string[];
    assetsWelded?: Array<{ assetId: string; name: string; verticesRemoved: number; trianglesRemoved: number; bytesBefore: number; bytesAfter: number }>;
    weldSkipped?: Array<{ what: string; reason: string }>;
  } | null) => void;
  /** The next GET /scenes/{id}/check fails (PR16). */
  __failNextCheck: () => void;
  /** Test hook: drive the mock rest directly (same stateful backend). */
  __rest: (path: string, opts?: unknown) => Promise<unknown>;
  /**
   * Test hook (0-C): run a palette row's `run()` by contribution id.
   * The mock has no palette UI; the row's `data.run` is the real
   * plugin code (setPendingDialog with invoker null + navigate), so
   * this drives the palette-open path faithfully.
   */
  __runPalette: (id: string) => void;
  /** Test hook: make the NEXT rest call wait `ms` before answering. */
  __delayNextRest: (ms: number, path?: string) => void;
  __delayNextRestReply: (ms: number, path: string) => void;
  __delayNextImageReply: (ms: number) => void;
  __holdNextPatch: () => void;
  __releasePatch: () => void;
  /**
   * Test hook (G-14): fail the list GET and the scene GETs with
   * REST_FAILED while on (the Agent switch off). Off again and the
   * next GET succeeds.
   */
  __setStoreDown: (on: boolean) => void;
  /**
   * Test hook (G-13): make GET /assets for `sha256` resolve the
   * gateway's ok:false ASSET_TOO_LARGE payload while on.
   */
  __setAssetTooLarge: (sha256: string, on: boolean) => void;
  /**
   * Test hook (R-12): make GET /scenes/{id} reject the way the Webapp
   * transport does for an HTTP failure — `Error("<status>: <json body>")`
   * (browser-transport.ts:210) — until cleared with null.
   */
  __setSceneError: (
    sceneId: string,
    error: { status: number; code: string; message: string } | null,
  ) => void;
  /** Test hook: capture a gateway download (records at capture time). */
  __captureDownload: () => void;
  /** Test hook: invoke the captured download save action. */
  __invokeCapturedDownload: (path: string, suggestedName: string) => Promise<void>;
  /**
   * Test hook (0-E broadcast helper): deliver a gateway event to the
   * subscribed ctx.onEvent listeners, e.g. a `scene.changed` payload
   * distinct from a poll refetch. The mock previously never emitted
   * gateway events; it now emits on demand.
   */
  __emit: (type: string, event: unknown) => void;
  /**
   * Test hook (0-E): deliver `plugin.plastis3d.scene.changed` for a
   * scene + revision (payload `{ scene, revision }`, the shape
   * sceneQuery's onSceneChanged reads).
   */
  __emitSceneChanged: (sceneId: string, revision: number) => void;
  /** Test hooks (PR14): seed or read a scene's stored thumbnail in the mock gateway. */
  __setThumbnail: (sceneId: string, revision: number, png: string) => void;
  __thumbnail: (sceneId: string) => { revision: number; png: string } | null;
  /** Test hooks (PR24): seed or inspect a mesh-edit draft in the mock gateway. */
  __setDraft: (sceneId: string, nodeId: string, draft: { baseRevision: number; from: Record<string, unknown> | null; mesh: unknown; savedAt: number }) => void;
  __hasDraft: (sceneId: string, nodeId: string) => boolean;
  /** Test hook (PR22): create a pending screenshot request; returns its id. */
  __requestCapture: (scene: string, revision: number) => string;
  /** Test hook (PR22): every PNG a surface posted for a claimed request. */
  __captureResults: () => Array<{ id: string; surface: string; revision: number; png: string }>;
  /**
   * Test hook (0-E): flip the `(prefers-reduced-motion: reduce)`
   * matchMedia stub and notify its change listeners.
   */
  __setReducedMotion: (reduced: boolean) => void;
  /** Test hook (0-E): set the host.state.viewport stub value. */
  __setViewport: (viewport: {
    width: number;
    height: number;
    narrow: boolean;
  }) => void;
  /** Test hook (0-E): read the current host.state.viewport stub value. */
  __viewport: () => { width: number; height: number; narrow: boolean };
  /** Test hook (N-01): change the useTheme() themeName. */
  __setThemeName: (name: string) => void;
}

declare global {
  interface Window {
    __plastis3dMock: MockHostReport;
  }
}

export const report: MockHostReport = {
  started: false,
  pluginId: null,
  contributions: [],
  panesMounted: [],
  routesMounted: [],
  statusbarMounted: [],
  canvasPresent: false,
  errors: [],
  restCalls: [],
  restRequests: [],
  navigations: [],
  eventSubscriptions: [],
  notifications: [],
  gatewayEpoch: 0,
  downloads,
  __files: { folders: [], listing: [], files: {} },
  __fileReads: [],
  imageFetches: [],
  checkRequests: [],
  cleanupRequests: [],
  setPaneVisible(paneId: string, visible: boolean): void {
    paneAtom(paneId).set(visible);
  },
  __setGatewayEpoch(n: number): void {
    gatewayEpoch = n;
    report.gatewayEpoch = n;
  },
  __setFilesEnabled(enabled: boolean): void {
    filesDoorEnabled = enabled;
  },
  __bumpRevision(): number {
    const spec = mockScenes.get(FIXTURE_SCENE_ID);
    if (!spec) throw new Error("mock host: fixture scene is gone");
    spec.revision += 1;
    return spec.revision;
  },
  __setProfileRoutes(routes: MockProfileRoute[]): void {
    currentRoutes = routes.map((r) => ({ ...r }));
  },
  __remount(): Promise<void> {
    return remountMockHost();
  },
  __rest(path: string, opts?: unknown): Promise<unknown> {
    return mockRest(path, opts);
  },
  __runPalette(id: string): void {
    const found = currentRegistered.find((c) => c.id === id);
    if (!found) throw new Error(`mock host: no contribution ${id}`);
    const run = (found.data as { run?: unknown } | undefined)?.run;
    if (typeof run !== "function") {
      throw new Error(`mock host: contribution ${id} has no run`);
    }
    run();
  },
  __delayNextImageReply(ms: number): void { nextImageReplyDelayMs = ms; },
  __holdNextPatch(): void { holdNextPatch = true; },
  __releasePatch(): void { releaseHeldPatch?.(); releaseHeldPatch = null; },
  __delayNextRestReply(ms: number, path: string): void { nextRestReplyDelay = { ms, path }; },
  __delayNextRest(ms: number, path?: string): void {
    nextRestDelayMs = ms; nextRestDelayPath = path ?? null;
  },
  __setStoreDown(on: boolean): void {
    storeDown = on;
    routeAbsent = false;
  },
  __setRouteAbsent(on: boolean): void { storeDown = on; routeAbsent = on; },
  __setSceneError(
    sceneId: string,
    error: { status: number; code: string; message: string } | null,
  ): void {
    if (error) sceneErrors.set(sceneId, error);
    else sceneErrors.delete(sceneId);
  },
  __setAssetTooLarge(sha256: string, on: boolean): void {
    if (on) assetTooLargeShas.add(sha256);
    else assetTooLargeShas.delete(sha256);
  },
  __setCleanup(changes: typeof mockCleanup): void {
    mockCleanup = changes;
  },
  __setCheckReport(fields: Record<string, unknown> | null): void {
    mockCheckReport = fields;
  },
  __failNextCheck(): void {
    checkFailure = true;
  },
  __refuseNextImage(code: string, message: string): void {
    refuseNextImage(code, message);
  },
  __captureDownload(): void {
    pendingDownload = captureGatewayFileDownload();
  },
  async __invokeCapturedDownload(path: string, suggestedName: string): Promise<void> {
    if (!pendingDownload) throw new Error("mock host: no captured download");
    await pendingDownload(path, suggestedName);
  },
  __emit(type: string, event: unknown): void {
    const listeners = eventListeners.get(type);
    if (!listeners) return;
    for (const fn of [...listeners]) fn(event);
  },
  __setThumbnail(sceneId: string, revision: number, png: string): void {
    mockThumbnails.set(sceneId, { revision, png });
  },
  __thumbnail(sceneId: string): { revision: number; png: string } | null {
    return mockThumbnails.get(sceneId) ?? null;
  },
  __setDraft(sceneId: string, nodeId: string, draft: { baseRevision: number; from: Record<string, unknown> | null; mesh: unknown; savedAt: number }): void {
    mockDrafts.set(`${sceneId}/${nodeId}`, { nodeId, currentRevision: 0, ...draft });
  },
  __hasDraft(sceneId: string, nodeId: string): boolean {
    return mockDrafts.has(`${sceneId}/${nodeId}`);
  },
  __requestCapture(scene: string, revision: number): string {
    const id = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    mockCaptures.set(id, { id, scene, revision, status: "pending", surface: null });
    return id;
  },
  __captureResults(): Array<{ id: string; surface: string; revision: number; png: string }> {
    return [...captureResults];
  },
  __emitSceneChanged(sceneId: string, revision: number): void {
    report.__emit("plugin.plastis3d.scene.changed", {
      payload: { scene: sceneId, revision },
    });
  },
  __setReducedMotion(reduced: boolean): void {
    reducedMotion = reduced;
    const event = { matches: reduced, media: REDUCED_MOTION_QUERY };
    for (const fn of [...reducedMotionListeners]) fn(event);
  },
  __setViewport(viewport: {
    width: number;
    height: number;
    narrow: boolean;
  }): void {
    viewportAtom.set({ ...viewport });
  },
  __viewport(): { width: number; height: number; narrow: boolean } {
    return { ...viewportAtom.get() };
  },
  __setThemeName(name: string): void {
    setThemeName(name);
  },
};

/** One-shot delay (ms) applied to the next mock rest call, then consumed. */
let nextImageReplyDelayMs = 0;
let nextRestDelayMs = 0;
let nextRestDelayPath: string | null = null;
let holdNextPatch = false;
let releaseHeldPatch: (() => void) | null = null;

/**
 * Store-down simulation (G-14): while true, the list GET and the
 * scene GETs fail with REST_FAILED (the Agent switch off — the
 * gateway is unreachable). Only the list/scene GETs fail: those are
 * the calls the store-failure state machine reads. Flip it off and
 * "Try again" refetches successfully.
 */
let storeDown = false;
let routeAbsent = false;

/**
 * 413 simulation (G-13): GET /assets for a sha in this set resolves
 * the gateway's ok:false ASSET_TOO_LARGE payload (code + message, no
 * stats — the real gateway shape). The asset must be drawable and
 * under the draw cap, so the cache actually fetches it.
 */
const assetTooLargeShas = new Set<string>();
// R-12: per-scene GET failures, in the Webapp transport's error shape.
const sceneErrors = new Map<string, { status: number; code: string; message: string }>();

// Test hook (G-12): ?delayRest=<ms> delays the FIRST rest call of the
// page load, so the list-loading UI is observable at startup — the
// hook cannot be armed before load any other way.
{
  const delayRestParam = Number(
    new URLSearchParams(location.search).get("delayRest"),
  );
  if (Number.isFinite(delayRestParam) && delayRestParam > 0) {
    nextRestDelayMs = delayRestParam;
  }
}

// Test hook (G-14): ?storeDown=1 starts the page with the store down,
// so the first-load store failure is observable — same reason as
// ?delayRest above.
{
  if (new URLSearchParams(location.search).get("storeDown") === "1") {
    storeDown = true;
  }
}

export const writeClipboardText = async (text: string) => { (window as unknown as Record<string, unknown>).__copiedPrompt = text; return true; };
export const host = {
  composer: { insertText: async (_id: string | null, text: string) => { (window as unknown as Record<string, unknown>).__insertedPrompt = text; return (window as unknown as Record<string, unknown>).__composerMounted === true; } },
  navigate(path: string): void {
    // Records the navigation AND writes the hash the way the real host
    // does (apps/desktop/src/sdk/index.ts: `window.location.hash =
    // '#' + to`, a HashRouter), so the `?scene=` query lands inside the
    // hash and `location.search` is untouched (F-UI-FIX-07). The mock
    // still has no router: every registered route stays mounted.
    report.navigations.push(path);
    const to = path.startsWith("#") ? path.slice(1) : path;
    window.location.hash = `#${to}`;
  },
  notify(opts: { kind: string; message: string }): string {
    report.notifications.push({ kind: opts.kind, message: opts.message });
    return `mock-notify-${report.notifications.length}`;
  },
  notifyError(error: unknown, fallbackMessage: string): string {
    void error;
    report.notifications.push({ kind: "error", message: fallbackMessage });
    return `mock-notify-${report.notifications.length}`;
  },
  paneVisibility(paneId: string): ReadableAtom<boolean> {
    return paneAtom(paneId);
  },
  profileRoutes(): MockProfileRoute[] {
    // The current route list; tests switch it with __setProfileRoutes.
    return currentRoutes.map((r) => ({ ...r }));
  },
  state: {
    gateway: new MockAtom("open"),
    profile: new MockAtom("default"),
    busy: new MockAtom(false),
    viewport: viewportAtom,
  } as Record<string, ReadableAtom<unknown>>,
};

// ------------------------------------------------------------ mock PluginContext
export interface MockContribution {
  id: string;
  area: string;
  title?: string;
  order?: number;
  render?: () => unknown;
  data?: unknown;
}

// --- mock asset bytes (PR7) -------------------------------------------------
//
// The mock serves REAL GLB bytes for GET /assets: the checked-in
// fixture tests/fixtures/two-primitive.glb (2184 bytes, 36 tris),
// fetched from the Vite dev server at mock runtime and base64-encoded
// here — the D1 envelope shape the real gateway returns. The fixture
// is served under its own sha256, so a template parsed from the mock's
// bytes is the same template the Tier 3 oracle proves GLTFLoader
// accepts. The sha is verified against the fetched bytes at load: a
// regenerated fixture fails loudly here instead of serving bytes
// under the wrong hash (update MOCK_ASSET_SHA256 with the new
// `sha256sum` if the fixture ever changes).
//
// Choice, recorded: fetch the checked-in fixture at mock runtime
// (not an embedded base64 literal) — the harness Vite server serves
// the repo root, so /tests/fixtures/... is fetchable from the page,
// and the bytes stay single-sourced with the oracle fixture. If the
// mock ever runs somewhere the fixture file is not served, GET
// /assets fails loudly (REST_FAILED with the fetch message) instead
// of silently serving stale bytes.
export const MOCK_ASSET_SHA256 =
  "ba710c41bffcdee203548ba1f24160bd20c6a873f79e4df23f37924937812acd";
/** Size in bytes of tests/fixtures/two-primitive.glb (sha-guarded). */
export const MOCK_ASSET_BYTES = 2184;
/** Stats for the fixture, from tests/fixtures/two-primitive.expected.json. */
export const MOCK_ASSET_STATS: {
  tris: number;
  verts: number;
  meshes: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
} = {
  tris: 36,
  verts: 108,
  meshes: 2,
  bounds: { min: [-1, -0.5, -1], max: [2.5, 4, 1] },
};

const MOCK_ASSET_PATH = "/tests/fixtures/two-primitive.glb";

/** Cached { base64, size } of the fixture GLB (fetched once, lazily). */
let mockAssetCache: { base64: string; size: number } | null = null;
let mockAssetLoad: Promise<{ base64: string; size: number }> | null = null;

/** Base64-encode an ArrayBuffer (btoa needs a binary string; chunked). */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Fetch the fixture GLB and return its base64 + size, verifying the
 * sha256 of the fetched bytes against MOCK_ASSET_SHA256 first.
 */
async function mockAssetBase64(): Promise<{ base64: string; size: number }> {
  if (mockAssetCache !== null) return mockAssetCache;
  if (!mockAssetLoad) {
    mockAssetLoad = (async () => {
      const res = await fetch(MOCK_ASSET_PATH);
      if (!res.ok) {
        throw new Error(
          `mock host: could not load fixture ${MOCK_ASSET_PATH} (HTTP ${res.status})`,
        );
      }
      const buffer = await res.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (hex !== MOCK_ASSET_SHA256) {
        throw new Error(
          `mock host: fixture ${MOCK_ASSET_PATH} sha256 ${hex} != ` +
            `${MOCK_ASSET_SHA256}; update MOCK_ASSET_SHA256`,
        );
      }
      const loaded = { base64: arrayBufferToBase64(buffer), size: buffer.byteLength };
      mockAssetCache = loaded;
      return loaded;
    })();
  }
  return mockAssetLoad;
}

/**
 * The stateful mock rest. Every call is recorded in restCalls (path
 * strings, PR4 shape) and restRequests ({ path, opts, sourceKey }).
 * GET /scenes serves the list; GET /scenes/{id} the envelope for the
 * stored spec; PATCH enforces baseRevision and applies ops; POST
 * /scenes creates; DELETE removes; POST .../export resolves a canned
 * success (PR6: the real gateway exports; the mock returns the
 * gateway's result shape with bytes 0 — no real GLB behind it) and
 * POST .../imports resolves a canned PR7 success (the feedback
 * envelope with the two-primitive fixture asset + one model node —
 * the mock has no import engine, so the uploaded bytes are ignored
 * and no exploder runs); GET /assets/{sha256} resolves the D1 base64
 * envelope for the fixture hash and rejects ASSET_NOT_FOUND for any
 * other hash.
 */
/**
 * A 4 x 4 RGBA PNG: the top-left pixel is red, the rest is a blue and white
 * checkerboard, so an upright picture is recognisable (PR15 orientation check).
 */
export const MOCK_PATTERN_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHklEQVR4nGP4z8DwX87mxH8QANEMyBwQYEDmYFUBAPAmLuuAWck5AAAAAElFTkSuQmCC";

/** Set by a test: what the next POST /scenes/{id}/cleanup would do (PR18). */
let mockCleanup: {
  materialsMerged: Array<{ from: string; into: string }>;
  materialsRemoved: string[];
  groupsRemoved: Array<{ id: string; name?: string }>;
  nodesRepointed: string[];
  assetsWelded?: Array<{ assetId: string; name: string; verticesRemoved: number; trianglesRemoved: number; bytesBefore: number; bytesAfter: number }>;
  weldSkipped?: Array<{ what: string; reason: string }>;
} | null = null;

/** Set by a test: fields merged over the default GET /scenes/{id}/check report. */
let mockCheckReport: Record<string, unknown> | null = null;
let checkFailure = false;

/** Set by a test: the next POST /images refuses with this gateway code. */
let imageRefusal: { code: string; message: string } | null = null;
export function refuseNextImage(code: string, message: string): void {
  imageRefusal = { code, message };
}

let nextRestReplyDelay: { ms: number; path: string } | null = null;
async function mockRest(path: string, opts?: unknown): Promise<unknown> {
  const delay = nextRestReplyDelay && path.endsWith(nextRestReplyDelay.path) ? nextRestReplyDelay.ms : 0;
  if (delay) nextRestReplyDelay = null;
  try {
    const result = await mockRestImmediate(path, opts);
    const captured = delay ? deepCopy(result) : result;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    return captured;
  } catch (error) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    throw error;
  }
}
async function mockRestImmediate(path: string, opts?: unknown): Promise<unknown> {
  if ((opts as { method?: string })?.method === "PATCH" && holdNextPatch) {
    holdNextPatch = false;
    await new Promise<void>(resolve => { releaseHeldPatch = resolve; });
  }
  if (nextRestDelayMs > 0 && (!nextRestDelayPath || path.endsWith(nextRestDelayPath))) {
    const delay = nextRestDelayMs;
    nextRestDelayMs = 0; nextRestDelayPath = null;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  report.restCalls.push(path);
  report.restRequests.push({ path, opts, sourceKey: currentSourceKey() });
  const method =
    (opts as { method?: string } | undefined)?.method ?? "GET";

  // G-14 store-down: the list GET and the scene GETs fail while the
  // store is down (the Agent switch off). Recorded above, so a "Try
  // again" refetch attempt is visible in restCalls either way.
  if (
    storeDown &&
    method === "GET" &&
    (path === "/scenes" || path.startsWith("/scenes/"))
  ) {
    if (routeAbsent) throw Object.assign(new Error("Not Found"), { status: 404 });
    throw new Error("network down");
  }

  if (path.startsWith("/captures/")) return mockCaptureRest(path, method, opts);

  if (method === "GET" && path.startsWith("/scenes/")) {
    const failing = sceneErrors.get(decodeURIComponent(path.slice("/scenes/".length)));
    if (failing) {
      throw new Error(
        `${failing.status}: ${JSON.stringify({ ok: false, code: failing.code, message: failing.message })}`,
      );
    }
  }

  if (path === "/scenes") {
    if (method === "GET") {
      return {
        ok: true,
        scenes: [...mockScenes.values()].map((s) => ({
          id: s.id,
          name: s.name,
          revision: s.revision,
          updatedAt: s.updatedAt,
          thumbnailRevision: mockThumbnails.get(s.id)?.revision ?? null,
        })),
      };
    }
    if (method === "POST") {
      const body = (opts as { body?: { name?: string; copyFrom?: string } } | undefined)?.body;
      const name = typeof body?.name === "string" && body.name ? body.name : "Untitled";
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "scene";
      let id = slug;
      let n = 2;
      while (mockScenes.has(id)) {
        id = `${slug}-${n}`;
        n += 1;
      }
      // Default rig nodes copied from the fixture (light + camera).
      const seed = body?.copyFrom ? mockScenes.get(body.copyFrom) : fixtureSceneSpec();
      if (!seed) throw mockError("SCENE_NOT_FOUND", "source scene not found");
      const spec: SceneSpec = {
        ...deepCopy(seed),
        id,
        name,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockScenes.set(id, spec);
      mockHistory.set(id, { undo: [], redo: [] });
      return envelopeFor(spec);
    }
    throw mockError("SPEC_INVALID", `mock host: ${method} /scenes is not supported`);
  }

  if (path.startsWith("/scenes/")) {
    const rest = path.slice("/scenes/".length).split("?")[0];
    const [rawId, ...tail] = rest.split("/");
    const id = decodeURIComponent(rawId);
    const spec = mockScenes.get(id);
    if (!spec) {
      throw mockError(
        "SCENE_NOT_FOUND",
        `SCENE_NOT_FOUND no scene with id ${JSON.stringify(id)}`,
      );
    }
    if (tail[0] === "export" && method === "POST") {
      // Canned PR6 success (see the header fidelity note): the mock
      // has no writer, so bytes is 0 and nothing is written to disk;
      // path/filename follow the gateway's `<id>-r<revision>.glb`
      // naming and revision/stats come from the stored spec.
      const filename = `${id}-r${spec.revision}.glb`;
      return {
        ok: true,
        path: `/exports/${filename}`,
        bytes: 0,
        revision: spec.revision,
        stats: sceneStats(spec),
        filename,
      };
    }
    if ((tail[0] === "check" || tail[0] === "analyze") && method === "GET") {
      // PR16: the compatibility report. The mock has no checker; a test sets
      // the report with __setCheckReport (or a failure with __failNextCheck),
      // and the default is a clean report for the scene's current revision.
      const budgetName = new URLSearchParams(path.split("?")[1] ?? "").get("budget") ?? "mobile";
      report.checkRequests.push({ sceneId: id, revision: spec.revision, kind: tail[0], budget: budgetName });
      if (checkFailure) {
        checkFailure = false;
        throw mockError("STORE_BUSY", "STORE_BUSY: try again");
      }
      return {
        ok: true,
        scene: id,
        revision: spec.revision,
        target: { kind: "scene" },
        summary: { errors: 0, warnings: 0, infos: 0 },
        issues: [],
        unchecked: [],
        stats: { tris: 0, materials: spec.materials.length, nodes: spec.nodes.length, assetsChecked: 0 },
        ...(tail[0] === "analyze"
          ? {
              analysis: {
                version: 1,
                budget:
                  budgetName === "desktop"
                    ? { name: "desktop", label: "Desktop", triangles: 500000, drawCalls: 500, materials: 64, textureMiB: 512 }
                    : { name: "mobile", label: "Phone", triangles: 100000, drawCalls: 100, materials: 16, textureMiB: 64 },
                counts: { triangles: 376, vertices: 269, drawCalls: 5, materials: spec.materials.length, textures: 0, textureBytes: 0, assetBytes: 0 },
                score: {
                  value: 100,
                  reason: null,
                  label: "A heuristic guide against the budget shown, not a certificate.",
                  heuristic: true,
                  weightsVersion: 1,
                  basedOnPartialChecks: false,
                  components: [],
                },
              },
            }
          : {}),
        ...(mockCheckReport ?? {}),
      };
    }
    if (tail[0] === "cleanup" && method === "POST") {
      // PR18: canned. A test sets what the cleanup would do with __setCleanup;
      // a preview changes nothing, an apply removes those materials and
      // groups and bumps the revision once (one history entry).
      const body = (opts as { body?: Record<string, unknown> } | undefined)?.body;
      if (body?.baseRevision !== spec.revision) {
        throw mockError("REVISION_CONFLICT", `REVISION_CONFLICT currentRevision is ${spec.revision}`);
      }
      const changes = mockCleanup ?? { materialsMerged: [], materialsRemoved: [], groupsRemoved: [], nodesRepointed: [] };
      const welded = changes.assetsWelded ?? [];
      const empty = !changes.materialsMerged.length && !changes.materialsRemoved.length && !changes.groupsRemoved.length && !welded.length;
      const lines: string[] = [];
      if (changes.materialsMerged.length) lines.push(`Merge ${changes.materialsMerged.length} identical material${changes.materialsMerged.length === 1 ? "" : "s"} into the first of each.`);
      if (changes.materialsRemoved.length) lines.push(`Remove ${changes.materialsRemoved.length} unused material${changes.materialsRemoved.length === 1 ? "" : "s"}.`);
      if (changes.groupsRemoved.length) lines.push(`Remove ${changes.groupsRemoved.length} empty group${changes.groupsRemoved.length === 1 ? "" : "s"}.`);
      for (const w of welded) lines.push(`Weld ${w.name}: remove ${w.verticesRemoved} duplicate vertices${w.trianglesRemoved ? ` and ${w.trianglesRemoved} empty triangles` : ""}.`);
      report.cleanupRequests.push({ dryRun: body?.dryRun === true, baseRevision: Number(body?.baseRevision), operations: (body?.operations as string[] | undefined) ?? null });
      const info = (applied: boolean) => ({
        operations: (body?.operations as string[] | undefined) ?? ["dedupe_materials", "prune_materials", "prune_groups"],
        dryRun: body?.dryRun === true,
        applied,
        summary: lines.length ? lines : ["Nothing to tidy up."],
        changes,
      });
      if (body?.dryRun === true || empty) return { ...envelopeFor(spec), cleanup: info(false) };
      const working = deepCopy(spec);
      working.materials = working.materials.filter((m) => !changes.materialsRemoved.includes(m.id));
      working.nodes = working.nodes.filter((n) => !changes.groupsRemoved.some((g) => g.id === n.id));
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      mockCleanup = null;
      return { ...envelopeFor(working), cleanup: info(true) };
    }
    if (tail[0] === "images" && method === "POST") {
      // PR15: one mutation, like the gateway. The mock has no image
      // decoder: a 4 x 4 pattern PNG (top-left corner red) stands in for
      // every picked file, and the asset id is a fake sha derived from the
      // file name. `mockImageNotice` flags a refusal for a test.
      const body = (opts as { body?: Record<string, unknown> } | undefined)?.body;
      if (body?.baseRevision !== spec.revision) {
        throw mockError("REVISION_CONFLICT", `REVISION_CONFLICT currentRevision is ${spec.revision}`);
      }
      if (imageRefusal) {
        const refusal = imageRefusal;
        imageRefusal = null;
        throw mockError(refusal.code, `${refusal.code}: ${refusal.message}`);
      }
      const slot = body?.slot as "baseColorMap" | "normalMap" | "metallicRoughnessMap" | "emissiveMap";
      const material = spec.materials.find((m) => m.id === body?.materialId);
      if (!material) throw mockError("MATERIAL_NOT_FOUND", `MATERIAL_NOT_FOUND no material with id ${JSON.stringify(body?.materialId)}`);
      const upload = body?.upload as { filename?: string; bytes?: unknown } | undefined;
      const name =
        upload?.filename ?? String(body?.backendPath ?? "picture.png").split("/").pop() ?? "picture.png";
      const sha = Array.from(name).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(64, "0").slice(-64);
      const working = deepCopy(spec);
      if (!working.assets.some((a) => a.id === sha)) {
        working.assets.push({
          id: sha,
          sha256: sha,
          file: `assets/${sha}.png`,
          format: "png",
          bytes: 87,
          originalName: name,
          sourceFormat: "png",
          stats: { width: 4, height: 4 },
        });
      }
      const target = working.materials.find((m) => m.id === material.id)!;
      target[slot] = sha;
      if (slot === "emissiveMap" && target.emissive.toLowerCase() === "#000000") target.emissive = "#ffffff";
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      if (nextImageReplyDelayMs > 0) {
        const delay = nextImageReplyDelayMs; nextImageReplyDelayMs = 0;
        report.__emitSceneChanged(id, working.revision);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return envelopeFor(working);
    }
    if (tail[0] === "renders" && method === "POST") {
      return { ok: true, path: `/renders/${id}.png`, filename: `${id}.png` };
    }
    // PR14 library: thumbnails, the asset list and Remove unused (mirrors plastis3d_scene/library.py).
    if (tail[0] === "thumbnail") {
      if (method === "PUT") {
        const body = ((opts as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as { revision?: number; png?: string };
        mockThumbnails.set(id, { revision: Number(body.revision), png: String(body.png ?? "") });
        return { ok: true, revision: body.revision, bytes: String(body.png ?? "").length };
      }
      const found = mockThumbnails.get(id);
      if (!found) throw mockError("THUMBNAIL_NOT_FOUND", "this scene has no thumbnail yet");
      return { ok: true, revision: found.revision, png: found.png };
    }
    if (tail[0] === "library") {
      const usedIds = new Set(spec.nodes.map((n) => n.modelAssetId).filter((v): v is string => typeof v === "string"));
      const rows = spec.assets.map((a) => ({ id: a.id, name: a.originalName ?? a.id.slice(0, 8), format: a.format, bytes: a.bytes, used: usedIds.has(a.id), usedBy: usedIds.has(a.id) ? 1 : 0 }));
      const view = { ok: true, revision: spec.revision, assets: rows, unused: rows.filter((r) => !r.used).length, unusedBytes: rows.filter((r) => !r.used).reduce((n, r) => n + r.bytes, 0) };
      if (method === "GET") return view;
      const body = ((opts as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as { baseRevision?: number; dryRun?: boolean };
      if (body.baseRevision !== spec.revision) throw mockError("REVISION_CONFLICT", `REVISION_CONFLICT currentRevision is ${spec.revision}`);
      const removed = rows.filter((r) => !r.used).map((r) => r.id);
      if (body.dryRun || removed.length === 0) return { ...view, removed, applied: false };
      const working = deepCopy(spec);
      working.assets = working.assets.filter((a) => !removed.includes(a.id));
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      return { ...envelopeFor(working), removed, applied: true };
    }
    // PR28 curves (mirrors plastis3d_scene/generators.make_curve): one revision, a part with a curve generator.
    if (tail[0] === "curves" && method === "POST") {
      const body = ((opts as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as { baseRevision?: number; id?: string; name?: string; transform?: NodeSpec["transform"]; curve?: { kind?: string; points?: unknown[]; radius?: number } };
      if (body.baseRevision !== spec.revision) throw mockError("REVISION_CONFLICT", `REVISION_CONFLICT currentRevision is ${spec.revision}`);
      if (!body.curve || (body.curve.radius !== undefined && !(body.curve.radius >= 0.001 && body.curve.radius <= 10)) || !Array.isArray(body.curve.points) || body.curve.points.length < 2) throw mockError("SPEC_INVALID", "SPEC_INVALID: bad curve");
      const working = deepCopy(spec);
      const asset: AssetSpec = { id: `a_curve${++nodeCounter}`, sha256: MOCK_ASSET_SHA256, file: `assets/${MOCK_ASSET_SHA256}.glb`, format: "glb", bytes: MOCK_ASSET_BYTES, originalName: "Edited mesh", sourceFormat: "glb", stats: { tris: 100, verts: 60, meshes: 1, drawable: true, bounds: { min: [...MOCK_ASSET_STATS.bounds.min] as [number, number, number], max: [...MOCK_ASSET_STATS.bounds.max] as [number, number, number] } } };
      working.assets.push(asset);
      let target = body.id ? working.nodes.find((n) => n.id === body.id) : undefined;
      if (!target) {
        target = { id: `n_mock${++nodeCounter}`, name: body.name ?? "Tube", kind: "part", transform: body.transform ?? { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, parent: null, visible: true, modelAssetId: asset.id, meshIndex: 0, primitiveIndex: 0 };
        working.nodes.push(target);
      }
      Object.assign(target, { kind: "part", modelAssetId: asset.id, meshIndex: 0, primitiveIndex: 0, generator: { type: "curve", version: 1, params: body.curve } });
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      return envelopeFor(working);
    }
    // PR30 rigs (mirrors generators.make_rig): the node becomes a locked model with a rig generator, in one revision.
    if (tail[0] === "rigs" && method === "POST") {
      const body = ((opts as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as { baseRevision?: number; id?: string; mesh?: unknown; rig?: { bones?: Array<{ id: string; parent: string | null }> } };
      if (body.baseRevision !== spec.revision) throw mockError("REVISION_CONFLICT", `REVISION_CONFLICT currentRevision is ${spec.revision}`);
      if (!body.rig?.bones?.length || !body.mesh) throw mockError("RIG_INVALID", "RIG_INVALID: bad rig");
      const working = deepCopy(spec);
      const target = working.nodes.find((n) => n.id === body.id);
      if (!target) throw mockError("NODE_NOT_FOUND", "no such node");
      const asset: AssetSpec = { id: `a_rig${++nodeCounter}`, sha256: MOCK_ASSET_SHA256, file: `assets/${MOCK_ASSET_SHA256}.glb`, format: "glb", bytes: MOCK_ASSET_BYTES, originalName: "Edited mesh", sourceFormat: "glb", stats: { tris: 100, verts: 60, meshes: 1, drawable: true, bounds: { min: [...MOCK_ASSET_STATS.bounds.min] as [number, number, number], max: [...MOCK_ASSET_STATS.bounds.max] as [number, number, number] } } };
      working.assets.push(asset);
      delete (target as { primitive?: unknown }).primitive;
      delete (target as { materialId?: unknown }).materialId;
      Object.assign(target, { kind: "model", modelAssetId: asset.id, generator: { type: "rig", version: 1, params: { ...(body.rig as object), baseAssetId: asset.id } } });
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      return envelopeFor(working);
    }
    // PR24 mesh edit: drafts and the bake (mirrors plastis3d_scene/bake.py and drafts.py).
    if (tail[0] === "drafts" && tail[1]) {
      const nodeId = decodeURIComponent(tail[1]);
      const key = `${id}/${nodeId}`;
      if (method === "PUT") {
        const body = (opts as { body?: Record<string, unknown> } | undefined)?.body ?? {};
        mockDrafts.set(key, { nodeId, baseRevision: Number(body.baseRevision), currentRevision: spec.revision, from: (body.from as Record<string, unknown>) ?? null, mesh: body.mesh, savedAt: Date.now() / 1000 });
        return { ok: true, bytes: JSON.stringify(body).length, savedAt: Date.now() / 1000, dropped: 0 };
      }
      if (method === "GET") {
        const draft = mockDrafts.get(key);
        if (!draft) throw mockError("DRAFT_NOT_FOUND", "no unsaved edit for this object");
        return { ok: true, draft: { ...draft, currentRevision: spec.revision } };
      }
      if (method === "DELETE") return { ok: true, deleted: mockDrafts.delete(key) };
    }
    if (tail[0] === "bakes" && method === "POST") {
      const body = ((opts as { body?: Record<string, unknown> } | undefined)?.body ?? {}) as { baseRevision?: number; nodeId?: string; mesh?: { indices?: string; positions?: string }; create?: { name?: string; transform?: NodeSpec["transform"]; parent?: string | null }; generator?: NodeSpec["generator"] };
      if (body.baseRevision !== spec.revision) throw mockError("REVISION_CONFLICT", `REVISION_CONFLICT currentRevision is ${spec.revision}`);
      const working = deepCopy(spec);
      if (body.create) {
        const fresh: NodeSpec = { id: `n_mock${++nodeCounter}`, name: body.create.name ?? "Part", kind: "part", transform: body.create.transform ?? { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }, parent: body.create.parent ?? null, visible: true, modelAssetId: "", meshIndex: 0, primitiveIndex: 0 };
        working.nodes.push(fresh);
        body.nodeId = fresh.id;
      }
      const target = working.nodes.find((n) => n.id === body.nodeId);
      if (!target) throw mockError("NODE_NOT_FOUND", "no node with that id");
      if (target.kind === "model") throw mockError("NODE_LOCKED", "This model is locked. Re-import it as editable parts to edit its mesh.");
      const triangles = Math.floor(atob(body.mesh?.indices ?? "").length / 12);
      const vertices = Math.floor(atob(body.mesh?.positions ?? "").length / 12);
      const asset: AssetSpec = { id: `a_baked${++nodeCounter}`, sha256: MOCK_ASSET_SHA256, file: `assets/${MOCK_ASSET_SHA256}.glb`, format: "glb", bytes: MOCK_ASSET_BYTES, originalName: "Edited mesh", sourceFormat: "glb", stats: { tris: triangles, verts: vertices, meshes: 1, drawable: true, bounds: { min: [...MOCK_ASSET_STATS.bounds.min] as [number, number, number], max: [...MOCK_ASSET_STATS.bounds.max] as [number, number, number] } } };
      working.assets.push(asset);
      Object.assign(target, { kind: "part", modelAssetId: asset.id, meshIndex: 0, primitiveIndex: 0 });
      delete (target as { primitive?: unknown }).primitive;
      if (body.generator) target.generator = body.generator; else delete target.generator;
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      mockDrafts.delete(`${id}/${body.nodeId}`);
      return envelopeFor(working);
    }
    if (tail[0] === "imports" && method === "POST") {
      // Canned PR7 success (see the header fidelity note): the mock
      // has no import engine and no exploder, so every import —
      // upload or backend path — returns the same two-primitive
      // fixture asset as ONE locked-style model node (the
      // explode:false shape, whatever the requested explode flag),
      // with stats from tests/fixtures/two-primitive.expected.json.
      // The uploaded bytes are ignored; the asset row reuses the
      // fixture sha256, so GET /assets serves bytes GLTFLoader can
      // parse and the viewport renders the model. The asset row is
      // appended once (a repeat import reuses it) and the model node
      // is minted per import. baseRevision is enforced like PATCH.
      const body = (opts as { body?: Record<string, unknown> } | undefined)
        ?.body;
      if (body?.baseRevision !== spec.revision) {
        throw mockError(
          "REVISION_CONFLICT",
          `REVISION_CONFLICT currentRevision is ${spec.revision}`,
        );
      }
      const upload = body?.upload as { filename?: unknown } | undefined;
      const backendPath =
        typeof body?.backendPath === "string" ? body.backendPath : null;
      if (
        !(upload && typeof upload.filename === "string" && upload.filename) &&
        !backendPath
      ) {
        throw mockError(
          "SPEC_INVALID",
          "SPEC_INVALID mock host: POST /imports needs { upload } or { backendPath }",
        );
      }
      const originalName =
        upload && typeof upload.filename === "string" && upload.filename
          ? upload.filename
          : (backendPath as string).split("/").pop() || "model.glb";
      const working = deepCopy(spec);
      let asset = working.assets.find((a) => a.sha256 === MOCK_ASSET_SHA256);
      if (!asset) {
        asset = {
          id: "a_two_primitive",
          sha256: MOCK_ASSET_SHA256,
          file: `assets/${MOCK_ASSET_SHA256}.glb`,
          format: "glb",
          bytes: MOCK_ASSET_BYTES,
          originalName,
          sourceFormat: "glb",
          stats: {
            tris: MOCK_ASSET_STATS.tris,
            verts: MOCK_ASSET_STATS.verts,
            meshes: MOCK_ASSET_STATS.meshes,
            drawable: true,
            bounds: {
              min: [...MOCK_ASSET_STATS.bounds.min] as [number, number, number],
              max: [...MOCK_ASSET_STATS.bounds.max] as [number, number, number],
            },
          },
        };
        working.assets.push(asset);
      }
      const node: NodeSpec = {
        id: `n_mock${++nodeCounter}`,
        name: originalName.replace(/\.(glb|gltf|obj|stl|ply)$/i, ""),
        kind: "model",
        transform: { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] },
        parent: null,
        visible: true,
        modelAssetId: asset.id,
      };
      working.nodes.push(node);
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      history.undo.push(deepCopy(spec));
      if (history.undo.length > 50) history.undo.shift();
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      return envelopeFor(working);
    }
    if (tail.length > 0) {
      throw mockError("SPEC_INVALID", `mock host: ${method} ${path} is not supported`);
    }
    if (method === "GET") return envelopeFor(spec);
    if (method === "DELETE") {
      if (Number(new URLSearchParams(path.split("?")[1]).get("baseRevision")) !== spec.revision) throw mockError("REVISION_CONFLICT", "revision conflict");
      mockScenes.delete(id);
      mockHistory.delete(id);
      return { ok: true, deleted: id };
    }
    if (method === "PATCH") {
      const body = (opts as { body?: unknown } | undefined)?.body as
        | { baseRevision?: unknown; ops?: unknown }
        | undefined;
      if (body?.baseRevision !== spec.revision) {
        throw mockError(
          "REVISION_CONFLICT",
          `REVISION_CONFLICT currentRevision is ${spec.revision}`,
        );
      }
      const ops = Array.isArray(body?.ops)
        ? (body.ops as Array<Record<string, unknown>>)
        : [];
      const history = mockHistory.get(id) ?? { undo: [], redo: [] };
      mockHistory.set(id, history);
      if (ops.length === 1 && (ops[0].op === "undo" || ops[0].op === "redo")) {
        const from = ops[0].op === "undo" ? history.undo : history.redo;
        const to = ops[0].op === "undo" ? history.redo : history.undo;
        const prev = from.pop();
        if (!prev) {
          throw mockError("HISTORY_EMPTY", "HISTORY_EMPTY no earlier edit to undo or redo");
        }
        to.push(deepCopy(spec));
        const next = deepCopy(prev);
        next.revision = spec.revision + 1;
        next.updatedAt = new Date().toISOString();
        mockScenes.set(id, next);
        return envelopeFor(next);
      }
      // Apply the batch atomically to a working copy; a refused op
      // rejects before anything is committed (one history entry).
      const working = deepCopy(spec);
      for (const op of ops) applyMockOp(working, op);
      history.undo.push(deepCopy(spec));
      if (history.undo.length > 50) history.undo.shift();
      history.redo = [];
      working.revision = spec.revision + 1;
      working.updatedAt = new Date().toISOString();
      mockScenes.set(id, working);
      return envelopeFor(working);
    }
    throw mockError("SPEC_INVALID", `mock host: ${method} ${path} is not supported`);
  }

  if (path.startsWith("/assets/")) {
    // PR7 (D1): the base64 envelope for the fixture hash; any other
    // hash is 404 ASSET_NOT_FOUND, matching the real gateway. The
    // bytes are the real fixture GLB (fetched + sha-checked lazily),
    // so the TemplateCache parses a genuine template from them.
    const sha = decodeURIComponent(path.slice("/assets/".length));
    // G-13: a flagged hash resolves the gateway's ok:false 413
    // payload (code + message, no stats — the real ASSET_TOO_LARGE
    // shape), so the cache reports asset-too-large instead of
    // fetching bytes.
    if (assetTooLargeShas.has(sha)) {
      return {
        ok: false,
        code: "ASSET_TOO_LARGE",
        message: "ASSET_TOO_LARGE asset too large for the byte route",
      };
    }
    // PR15: an image asset the mock's /images route made.
    const imageAsset = [...mockScenes.values()]
      .flatMap((s) => s.assets)
      .find((a) => a.id === sha && a.format === "png");
    if (imageAsset) {
      report.imageFetches.push(sha);
      return { ok: true, sha256: sha, size: 87, format: "png", mimeType: "image/png", bytes: MOCK_PATTERN_PNG_BASE64 };
    }
    if (sha === "db071e1855c2c86599ed512081bdf0db7c451afaf0025e8ebb5e4a858393d2cb") {
      const response = await fetch("/tests/fixtures/skin-clip-morph.glb");
      if (!response.ok) throw new Error("animated fixture unavailable");
      const buffer = await response.arrayBuffer();
      return { ok: true, sha256: sha, size: buffer.byteLength, bytes: arrayBufferToBase64(buffer) };
    }
    if (sha !== MOCK_ASSET_SHA256) {
      throw mockError(
        "ASSET_NOT_FOUND",
        `ASSET_NOT_FOUND no asset with sha256 ${JSON.stringify(sha)}`,
      );
    }
    const { base64, size } = await mockAssetBase64();
    return { ok: true, sha256: MOCK_ASSET_SHA256, size, bytes: base64 };
  }
  throw mockError(
    "SPEC_INVALID",
    `mock host: ctx.rest(${JSON.stringify(path)}) has no backend`,
  );
}

// ctx.onEvent listeners by event type, across (re)mounts (0-E): the
// broadcast helper (__emit / __emitSceneChanged) delivers to these.
// The disposer returned by onEvent removes the listener, so a re-bind
// (initSceneData on ctx change) never leaves a stale one.
const eventListeners = new Map<string, Set<(event: unknown) => void>>();

export function createMockContext() {
  const registered: MockContribution[] = [];
  const disposers: Array<() => void> = [];
  const store = new Map<string, unknown>();
  const ctx = {
    source: "plugin:plastis3d",
    register(c: MockContribution): () => void {
      registered.push(c);
      if (c.area === TRANSCRIPT_DIRECTIVE_AREA) {
        const mount = document.createElement("div"); mount.id = "transcript"; document.body.appendChild(mount);
        const root = createRoot(mount);
        (window as unknown as Record<string, unknown>).__renderDirective = (name: string, attrs: Record<string,string>, options: { streaming?: boolean; key?: string } = {}) => {
          const data = c.data as unknown as { name: string; render: (props: unknown) => React.ReactNode };
          let target = root;
          if (options.key) {
            const cardMount = document.createElement("div"); mount.appendChild(cardMount);
            target = createRoot(cardMount); disposers.push(() => target.unmount());
          }
          target.render(data.name === name ? data.render({ attrs, source: `::${name}`, streaming: options.streaming ?? false }) : `::${name}`);
        };
        disposers.push(() => { root.unmount(); mount.remove(); });
      }
      report.contributions.push({ id: c.id, area: c.area, title: c.title });
      return () => {
        const i = registered.indexOf(c);
        if (i >= 0) registered.splice(i, 1);
      };
    },
    registerMany(cs: MockContribution[]): () => void {
      const ds = cs.map((c) => ctx.register(c));
      return () => ds.forEach((d) => d());
    },
    onEvent(type: string, listener: (event: unknown) => void): () => void {
      // The subscription itself is recorded so tests can assert the data
      // layer subscribed exactly once to scene.changed. The listener is
      // kept so the 0-E broadcast helper can deliver gateway events on
      // demand (__emit / __emitSceneChanged) — distinct from a poll
      // refetch. Broadcast delivery itself was proven live in PR1.
      report.eventSubscriptions.push(type);
      let listeners = eventListeners.get(type);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(type, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
      };
    },
    onDispose(fn: () => void): void {
      disposers.push(fn);
    },
    setTimeout(fn: () => void, ms: number): () => void {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    },
    setInterval(fn: () => void, ms: number): () => void {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    },
    addEventListener(
      target: EventTarget,
      type: string,
      listener: EventListener,
      options?: AddEventListenerOptions | boolean,
    ): () => void {
      target.addEventListener(type, listener, options);
      return () => target.removeEventListener(type, listener, options);
    },
    // The stateful mock rest (see mockRest above).
    rest: mockRest,
    registerSettingsPage(page: { id: string; render: () => ReactNode }) {
      const mount = document.createElement("div"); mount.id = "plugin-settings";
      mount.hidden = true; document.body.appendChild(mount);
      const root = createRoot(mount); root.render(page.render());
      (window as unknown as Record<string, unknown>).__showSettings = () => { mount.hidden = false; };
      const dispose = () => { root.unmount(); mount.remove(); };
      disposers.push(dispose); return dispose;
    },
    // Approximation: in-memory JSON store, not the host's persisted storage.
    storage: {
      get(key: string): unknown {
        return store.get(key);
      },
      set(key: string, value: unknown): void {
        store.set(key, value);
      },
      remove(key: string): void {
        store.delete(key);
      },
    },
    // The mock files door, backed by window.__plastis3dMock.__files.
    // folders() returns the granted folders (empty by default);
    // list/stat/readDataUrl read from the same state. requestFolder
    // resolves { ok: true, folder: null } (cancel — the mock has no
    // picker); tests simulate a grant by setting __files.folders.
    // Absent entirely when filesDoorEnabled is false (older shell).
    files: filesDoorEnabled
      ? {
      dataFolder: "data" as const,
      folders: async (): Promise<ImportFolder[]> => [...report.__files.folders],
      requestFolder: async () => ({
        ok: true as const,
        folder: null as ImportFolder | null,
      }),
      list: async (_folder: string, _path?: string) => ({
        ok: true as const,
        entries: [...report.__files.listing],
        truncated: report.__files.truncated === true,
      }),
      stat: async (_folder: string, path: string) => {
        const entry = report.__files.files[path];
        if (!entry) return { ok: true as const, exists: false as const };
        return {
          ok: true as const,
          exists: true as const,
          isDirectory: false as const,
          size: entry.size,
        };
      },
      readDataUrl: async (_folder: string, path: string) => {
        report.__fileReads.push(path);
        const entry = report.__files.files[path];
        if (!entry) {
          return {
            ok: false as const,
            error: "not-found",
            message: `mock host: no file at ${JSON.stringify(path)}`,
          };
        }
        if (!entry.dataUrl) {
          return {
            ok: false as const,
            error: "io-error",
            message: `mock host: no dataUrl recorded for ${JSON.stringify(path)}`,
          };
        }
        return { ok: true as const, url: entry.dataUrl };
      },
      release: async (_folderId: string): Promise<boolean> => true,
      }
      : undefined,
    // Exposed for the harness only (not part of the real PluginContext).
    __registered: registered,
    __disposeAll(): void {
      disposers.forEach((d) => d());
    },
  };
  return ctx;
}

// ------------------------------------------------------------ page entry
/** React roots mounted by the mock host (panes + routes), for __remount. */
const mountedRoots: Root[] = [];
/** Contributions registered by the latest mount (for __runPalette). */
let currentRegistered: MockContribution[] = [];

async function mountMockHost(): Promise<void> {
  if (typeof document === "undefined") return; // imported in Node: no DOM to mount.
  window.__plastis3dMock = report;
  const status = document.getElementById("status");
  const panesEl = document.getElementById("panes");
  const routeEl = document.getElementById("route");
  if (!status || !panesEl) return;

  // ?panesOnly=1 (merge fix, PR5 report): mount panes only — no route,
  // no statusbar. The real host only mounts the editor route when the
  // user navigates to it; the mock's mount-everything page is unfaithful
  // for tests that need a single eligible scene poller (the PR4 poll
  // test: the route's viewport is a second eligible surface, so hiding
  // the pane alone never stops the shared scene record's poll).
  const panesOnly = new URLSearchParams(window.location.search).has(
    "panesOnly",
  );

  const fail = (message: string) => {
    report.errors.push(message);
    status.textContent = `mock host: FAILED — ${message}`;
    console.error("[mock-host]", message);
  };

  try {
    const ctx = createMockContext();
    // Dynamic import: the SDK stub (this module) is fully evaluated before
    // this runs, so the bundle's static import of '@hermes/plugin-sdk'
    // resolves to the initialized stub namespace.
    const bundle = await import("/desktop/plugin.js");
    const plugin = bundle.default ?? bundle;
    if (typeof plugin.register !== "function") {
      fail("bundle default export has no register(ctx)");
      return;
    }
    report.pluginId = typeof plugin.id === "string" ? plugin.id : null;
    plugin.register(ctx);
    currentRegistered = ctx.__registered;
    (window as unknown as Record<string, unknown>).__mountExtraEditor = () => {
      const contribution = ctx.__registered.find(c => c.area === ROUTES_AREA);
      const mount = document.createElement("div"); document.body.appendChild(mount);
      const root = createRoot(mount); root.render(contribution?.render?.() as never);
      return () => { root.unmount(); mount.remove(); };
    };


    const panes = ctx.__registered.filter((c) => c.area === PANES_AREA);
    if (panes.length === 0) {
      fail("bundle registered no PANES_AREA pane");
      return;
    }
    for (const pane of panes) {
      const section = document.createElement("section");
      const heading = document.createElement("h2");
      heading.textContent = pane.title ?? pane.id;
      const mount = document.createElement("div");
      mount.className = "pane-mount";
      section.append(heading, mount);
      panesEl.appendChild(section);
      if (typeof pane.render === "function") {
        const root = createRoot(mount);
        root.render(pane.render() as never);
        mountedRoots.push(root);
        report.panesMounted.push(pane.id);
      }
    }

    // ROUTES_AREA contributions render into the #route mount (the editor
    // route in PR5). There is no router in the mock: every registered
    // route renders. report.routesMounted lists them. Skipped under
    // ?panesOnly=1 (see above).
    if (routeEl && !panesOnly) {
      const routes = ctx.__registered.filter((c) => c.area === ROUTES_AREA);
      for (const route of routes) {
        const mount = document.createElement("div");
        mount.className = "route-mount";
        routeEl.appendChild(mount);
        if (typeof route.render === "function") {
          const root = createRoot(mount);
          root.render(route.render() as never);
          mountedRoots.push(root);
          report.routesMounted.push(route.id);
        }
      }
    }

    // STATUSBAR_AREAS contributions render into the #statusbar mount
    // (the status chip in PR5). The real host renders them in the
    // status bar; the mock renders them in a footer strip so T4 can
    // assert on them. report.statusbarMounted lists them.
    const statusbarEl = document.getElementById("statusbar");
    if (statusbarEl && !panesOnly) {
      const chips = ctx.__registered.filter(
        (c) =>
          c.area === STATUSBAR_AREAS.left || c.area === STATUSBAR_AREAS.right,
      );
      for (const chip of chips) {
        const mount = document.createElement("div");
        mount.className = "statusbar-mount";
        statusbarEl.appendChild(mount);
        if (typeof chip.render === "function") {
          const root = createRoot(mount);
          root.render(chip.render() as never);
          mountedRoots.push(root);
          report.statusbarMounted.push(chip.id);
        }
      }
    }

    report.started = true;
    // Let React commit, then record whether a canvas actually appeared.
    setTimeout(() => {
      report.canvasPresent = panesEl.querySelector("canvas") !== null;
      status.textContent =
        `mock host: plugin ${report.pluginId ?? "?"} registered ` +
        `${report.panesMounted.length} pane(s) (${report.panesMounted.join(", ")}); ` +
        `${report.routesMounted.length} route(s) (${report.routesMounted.join(", ")}); ` +
        `canvas ${report.canvasPresent ? "present" : "absent"}`;
    }, 500);
  } catch (err) {
    fail(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }
}

/**
 * Test hook: switch the mock's profileRoutes and re-run register with a
 * fresh ctx (the old React roots are unmounted first). The scene store,
 * rest logs, notifications, and downloads survive the remount — same
 * backend, new connection/profile — which is exactly what the
 * cross-source tests assert about.
 */
async function remountMockHost(): Promise<void> {
  for (const root of mountedRoots.splice(0)) root.unmount();
  const panesEl = document.getElementById("panes");
  const routeEl = document.getElementById("route");
  const statusbarEl = document.getElementById("statusbar");
  if (panesEl) panesEl.innerHTML = "";
  if (routeEl) routeEl.innerHTML = "";
  if (statusbarEl) statusbarEl.innerHTML = "";
  report.panesMounted = [];
  report.routesMounted = [];
  report.statusbarMounted = [];
  report.contributions = [];
  report.errors = [];
  report.started = false;
  await mountMockHost();
}

installMatchMediaStub();

void mountMockHost();
