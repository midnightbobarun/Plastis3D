import { SPLAT_COPY } from "../copy";
import { ClipKeys } from "./ClipKeys";
// src/editor/Inspector.tsx — the Properties panel (UI/UX redesign §7.3,
// PR32; PR5 behaviour kept).
//
// One scroll column of collapsible Section cards (no tabs). The header
// names the selection in plain words ("Hat · Cone"). Sections: Transform
// (AxisRows with drag-to-scrub, per-row reset, uniform-scale lock),
// Material (preset balls, the 16-colour palette, plain-word sliders, then
// More: opacity, glow colour, double-sided), Shape (plain-named primitive
// parameters), Light, Camera (Look through / Set from view), Model, Part,
// Size, Actions. Nothing selected shows the scene card.
//
// Edits the PRIMARY selection. Drafts are local; Enter or blur commits,
// Escape reverts; a drag commits once on release. SPEC_INVALID shows the
// server's one-line message under the field; other failures toast.
//
// Shared materials (bug fix, PR32): editing a material that other nodes
// also use gives THIS node its own copy instead of recolouring every
// node that shares it — "I made the hat red" must not paint the body.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Checkbox, CopyButton } from "@hermes/plugin-sdk";
import type { RestFn } from "../api";
import { getAssetBytes } from "../api";
import { useHealth } from "./useHealth";
import type { HealthState } from "./useHealth";
import { useCleanupPreview } from "./useCleanupPreview";
import type { CleanupPreviewState } from "./useCleanupPreview";
import { comparisonRows } from "../state/healthComparison";
import {
  countRows,
  hasAnalysis,
  healthHeadline,
  healthSummary,
  hasOutput,
  nodeCosts,
  scoreLine,
  severityLabel,
} from "../state/health";
import { LibrarySection } from "./LibrarySection";
import { TextSection } from "./TextSection";
import { ModifiersSection } from "./ModifiersSection";
import { UvSection } from "./UvSection";
import { CurveSection } from "./CurveSection";
import { RigSection } from "./RigSection";
import { COPY, LOCKED_SENTENCE } from "../copy";
import { ImportDialog } from "../io/ImportDialog";
import type { FilesDoor } from "../io/importFlow";
import type { GizmoModeStore } from "../gizmos/gizmoMode";
import { MAP_SLOTS, isImageAsset, mimeTypeFor } from "../scene/textures";
import type { MapSlot } from "../scene/textures";
import { countPrimitive, primitiveLocalBounds } from "../scene/primitiveStats";
import { PRIMITIVE_DEFAULTS } from "../scene/build";
import {
  commitPatch,
  deleteNodes,
  duplicateNodes,
  renameNode,
  subtreeIds,
  toastApiError,
  updateNodeFields,
} from "./sceneActions";
import { ConfirmDialog } from "./ConfirmDialog";
import { DEFAULT_MATERIAL, aimRotation } from "./AddMenu";
import { useSelection } from "../state/selection";
import type { SelectionStore } from "../state/selection";
import { getLivePosition, getLiveTarget } from "../state/cameraPose";
import { rememberColor, useViewPrefs } from "../state/viewPrefs";
import {
  AxisRow,
  MaterialBall,
  ScrubField,
  Section,
  Slider,
  SwatchGrid,
} from "../ui/controls";
import { Icon, nodeIconName } from "../ui/icons";
import { MATERIAL_PRESETS, matchingPreset, paletteName, presetFields } from "../ui/materials";
import type {
  AssetSpec,
  MaterialSpec,
  NodeSpec,
  SceneSpec,
  SceneStats,
  Transform,
} from "../types";

/** A material edit: map slots take an asset id, or null to clear the map. */
type MaterialFields = Omit<Partial<MaterialSpec>, MapSlot> & Partial<Record<MapSlot, string | null>>;

export interface InspectorProps {
  rest: RestFn;
  scene: SceneSpec;
  selection: SelectionStore;
  /** Backend identity and the Desktop file door, for the texture picker (PR15). */
  sourceKey?: string;
  files?: FilesDoor | null;
  gizmoMode?: GizmoModeStore;
  /** Envelope stats for the scene card (tris), when known. */
  stats?: SceneStats | null;
}

const PRIMITIVE_LABEL: Record<string, string> = {
  box: "Box",
  sphere: "Sphere",
  cylinder: "Cylinder",
  cone: "Cone",
  torus: "Torus",
  plane: "Plane",
  capsule: "Capsule",
};

/** "Cone", "Key light", "Camera"… — the kind in plain words. */
export function kindWords(node: NodeSpec): string {
  switch (node.kind) {
    case "mesh":
      return node.primitive ? (PRIMITIVE_LABEL[node.primitive.type] ?? "Shape") : "Shape";
    case "light":
      return node.light?.type === "point"
        ? "Point light"
        : node.light?.type === "spot"
          ? "Spot light"
          : "Sun light";
    case "camera":
      return "Camera";
    case "group":
      return "Group";
    case "model":
      return "Imported model";
    case "part":
      return "Model part";
    case "splat": return SPLAT_COPY.title;
    default:
      return node.kind;
  }
}

function formatNumber(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatVec(v: [number, number, number]): string {
  return `(${formatNumber(v[0])}, ${formatNumber(v[1])}, ${formatNumber(v[2])})`;
}

function formatMeters(n: number): string {
  if (n >= 10) return `${n.toFixed(1)} m`;
  if (n >= 1) return `${n.toFixed(2)} m`;
  return `${Math.round(n * 100)} cm`;
}

const onEditError = (err: unknown) => toastApiError(err, "edit");

// --- inspector ---------------------------------------------------------------

export function Inspector({ rest, scene, selection, stats, sourceKey, files, gizmoMode }: InspectorProps) {
  const snapshot = useSelection(selection);
  const [mapPick, setMapPick] = useState<{ slot: MapSlot; materialId: string } | null>(null);
  // Held here, not in the section, so the report survives a change of selection.
  const health = useHealth(rest, scene, sourceKey);
  const cleanup = useCleanupPreview(rest, scene, sourceKey);
  const healthFocus = useRef<{ scope: string; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [scaleLocked, setScaleLocked] = useState(true);
  const nameCancelledRef = useRef(false);

  const nodesById = useMemo(
    () => new Map(scene.nodes.map((n) => [n.id, n])),
    [scene.nodes],
  );
  const materialsById = useMemo(
    () => new Map(scene.materials.map((m) => [m.id, m])),
    [scene.materials],
  );
  const assetsById = useMemo(
    () => new Map(scene.assets.map((a) => [a.id, a])),
    [scene.assets],
  );

  const primaryId = snapshot.primary;
  const node = primaryId !== null ? nodesById.get(primaryId) : undefined;

  // --- nothing selected: the scene card ---------------------------------------
  if (!node) {
    const objects = scene.nodes.filter((n) => n.kind !== "light" && n.kind !== "camera").length;
    const lights = scene.nodes.filter((n) => n.kind === "light").length;
    return (
      <div className="p3d-panel-scroll">
        <div className="p3d-insp-head">
          <span className="p3d-insp-icon"><Icon name="scene" size={18} /></span>
          <div style={{ minWidth: 0, flex: "1 1 auto" }}>
            <div className="p3d-insp-name">{scene.name}</div>
            <div className="p3d-insp-kind" title="One unit is one meter. Y points upward.">Scene · metres · Y-up</div>
          </div>
          <CopyButton appearance="icon" text={scene.id} title="Copy scene id" />
        </div>
        <div className="p3d-scene-card">
          <dl className="p3d-stat-grid">
            <dt>Objects</dt>
            <dd>{objects}</dd>
            <dt>Lights</dt>
            <dd>{lights === 0 ? "None (a soft fill is used)" : lights}</dd>
            {stats && (
              <>
                <dt>Triangles</dt>
                <dd>{stats.tris.toLocaleString()}</dd>
              </>
            )}
            <dt>Revision</dt>
            <dd>{scene.revision}</dd>
          </dl>
          <div className="p3d-help" style={{ fontSize: 12 }}>
            meters · Y-up · Revision {scene.revision} · {scene.nodes.length} nodes
          </div>
          <div className="p3d-muted" style={{ fontSize: 13 }}>
            Select a node in the view or the list.
          </div>
        </div>
        <HealthSection health={health} scene={scene} cleanup={cleanup} selection={selection} focusRequest={healthFocus} />
        <LibrarySection rest={rest} scene={scene} sourceKey={sourceKey} />
      </div>
    );
  }

  const asset: AssetSpec | undefined =
    node.modelAssetId !== undefined ? assetsById.get(node.modelAssetId) : undefined;
  const material: MaterialSpec | undefined =
    node.materialId !== undefined ? materialsById.get(node.materialId) : undefined;

  // N-05: the model a selected part belongs to (topmost group).
  const partModelName: string | null =
    node.kind === "part"
      ? (() => {
          let current = node;
          const seen = new Set<string>([current.id]);
          while (current.parent !== null) {
            const parent = nodesById.get(current.parent);
            if (!parent || seen.has(parent.id)) break;
            seen.add(parent.id);
            current = parent;
          }
          return current.kind === "group" ? current.name : (asset?.originalName ?? "—");
        })()
      : null;

  const current = node;

  async function commitTransform(axis: keyof Transform, index: number, v: number): Promise<void> {
    const tr = current.transform;
    const next: Transform = {
      t: [...tr.t] as Transform["t"],
      r: [...tr.r] as Transform["r"],
      s: [...tr.s] as Transform["s"],
    };
    next[axis][index] = v;
    await updateNodeFields(rest, scene, current.id, { transform: next });
  }

  async function commitTransformRow(axis: keyof Transform, values: [number, number, number]): Promise<void> {
    const tr = current.transform;
    const next: Transform = {
      t: [...tr.t] as Transform["t"],
      r: [...tr.r] as Transform["r"],
      s: [...tr.s] as Transform["s"],
    };
    next[axis] = values;
    await updateNodeFields(rest, scene, current.id, { transform: next });
  }

  /** How many OTHER nodes use this material. */
  const sharedWith = material
    ? scene.nodes.filter((n) => n.id !== current.id && n.materialId === material.id).length
    : 0;

  /** Returns the id of the material the node ends up with. */
  async function commitMaterial(fields: MaterialFields): Promise<string> {
    const base: MaterialSpec = material ?? { ...DEFAULT_MATERIAL };
    const merged = { ...base, ...fields } as MaterialSpec & Partial<Record<MapSlot, string | null>>;
    if (material && sharedWith === 0) {
      merged.id = material.id;
    } else {
      // A part without an override, or a material shared with other
      // nodes: this node gets its own copy (an explicit fresh id, so the
      // assignment is unambiguous on every backend).
      const taken = new Set(scene.materials.map((m) => m.id));
      let id = "";
      do id = `m_${Math.random().toString(36).slice(2, 8)}`;
      while (taken.has(id));
      merged.id = id;
      // A new copy has nothing to clear: drop cleared maps instead of sending null.
      for (const slot of MAP_SLOTS) if (merged[slot] === null) delete merged[slot];
    }
    await commitPatch(rest, scene, [
      { op: "set_material", material: merged, assignTo: [current.id] },
    ]);
    return merged.id;
  }

  /** Choose an image for a slot: the node gets its own material first when it has none. */
  async function startMapPick(slot: MapSlot): Promise<void> {
    if (sourceKey === undefined || gizmoMode === undefined) return;
    try {
      const id = material && sharedWith === 0 ? material.id : await commitMaterial({});
      setMapPick({ slot, materialId: id });
    } catch (err) {
      onEditError(err);
    }
  }

  async function doDuplicate(): Promise<void> {
    try {
      const before = new Set(scene.nodes.map((n) => n.id));
      const envelope = await duplicateNodes(rest, scene, [current.id]);
      const created = envelope.nodes.map((n) => n.id).filter((id) => !before.has(id));
      if (created.length > 0) selection.set(created);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function doDelete(): Promise<void> {
    setConfirmDelete(false);
    try {
      const removed = subtreeIds(scene.nodes, current.id);
      await deleteNodes(rest, scene, scene.nodes, [current.id]);
      for (const id of removed) selection.remove(id);
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  async function setCameraFromView(): Promise<void> {
    const eye = getLivePosition("editor");
    const target = getLiveTarget("editor");
    const from = new THREE.Vector3(...eye);
    const r = aimRotation(from, new THREE.Vector3(...target));
    await updateNodeFields(rest, scene, current.id, {
      transform: { t: eye.map((v) => Math.round(v * 1000) / 1000), r, s: current.transform.s },
    });
  }

  const shownName = nameDraft ?? node.name;
  const tr = node.transform;

  return (
    <div className="p3d-panel-scroll">
      <div className="p3d-insp-head">
        <span className="p3d-insp-icon"><Icon name={nodeIconName(node)} size={18} /></span>
        <div style={{ minWidth: 0, flex: "1 1 auto" }}>
          <input
            className="p3d-text-input"
            style={{ fontSize: 15, fontWeight: 600, height: 30, padding: "0 6px", marginLeft: -6, background: "transparent" }}
            value={shownName}
            aria-label="Node name"
            maxLength={64}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={() => setNameDraft(node.name)}
            onBlur={() => {
              if (nameCancelledRef.current) {
                nameCancelledRef.current = false;
                setNameDraft(null);
                return;
              }
              const next = (nameDraft ?? node.name).trim();
              setNameDraft(null);
              if (next === "" || next === node.name) return;
              void renameNode(rest, scene, node.id, next).catch(onEditError);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              } else if (e.key === "Escape") {
                nameCancelledRef.current = true;
                setNameDraft(null);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <div className="p3d-insp-kind">
            {kindWords(node)}
            {node.visible === false ? " · hidden" : ""}
          </div>
        </div>
      </div>
      <div className="p3d-help" style={{ padding: "0 14px 10px" }}>
        {snapshot.ids.length > 1
          ? `${snapshot.ids.length} nodes selected — showing ${node.name}.`
          : "Shift-click another node to select several."}
      </div>

      <Section id="transform" title="Transform" icon="move">
        <AxisRow
          label="Position"
          prefix="T"
          values={tr.t}
          step={0.1}
          unit="m"
          defaults={[0, 0, 0]}
          onCommit={(i, v) => commitTransform("t", i, v)}
          onReset={() => commitTransformRow("t", [0, 0, 0])}
          onError={onEditError}
        />
        <AxisRow
          label="Rotation"
          prefix="R"
          values={tr.r}
          step={1}
          unit="°"
          defaults={[0, 0, 0]}
          onCommit={(i, v) => commitTransform("r", i, v)}
          onReset={() => commitTransformRow("r", [0, 0, 0])}
          onError={onEditError}
        />
        <AxisRow
          label="Scale"
          prefix="S"
          values={tr.s}
          step={0.01}
          defaults={[1, 1, 1]}
          onCommit={(i, v) => commitTransform("s", i, v)}
          onReset={() => commitTransformRow("s", [1, 1, 1])}
          onError={onEditError}
          locked={scaleLocked}
          onToggleLock={() => setScaleLocked((l) => !l)}
          onCommitAll={(i, v) => {
            // Uniform: keep the proportions — scale all three by the
            // factor the edited field moved by.
            const ref = tr.s[i];
            if (ref === 0) return commitTransformRow("s", [v, v, v]);
            const k = v / ref;
            return commitTransformRow("s", tr.s.map((c) => Math.round(c * k * 10000) / 10000) as [number, number, number]);
          }}
        />
        <div className="p3d-help">Drag a letter to change a value. Hold Shift for big steps, Alt for fine ones.</div>
      </Section>

      {(node.kind === "mesh" || node.kind === "part") && (
        <MaterialSection
          material={material}
          isOverride={node.kind === "part" && !material}
          sharedWith={sharedWith}
          onCommit={commitMaterial}
        />
      )}

      {(node.kind === "mesh" || node.kind === "part") && sourceKey !== undefined && gizmoMode !== undefined && (
        <TexturesSection
          material={material}
          rest={rest}
          assetsById={assetsById}
          onPickMap={(slot) => void startMapPick(slot)}
          onCommit={commitMaterial}
        />
      )}

      {node.kind === "mesh" && <ClipKeys node={node} scene={scene} rest={rest} />}

      {(node.kind === "mesh" || node.kind === "part") && <ModifiersSection node={node} scene={scene} rest={rest} sourceKey={sourceKey} />}

      {(node.kind === "mesh" || node.kind === "part") && <UvSection node={node} scene={scene} rest={rest} sourceKey={sourceKey} />}

      {node.kind === "part" && node.generator?.type === "curve" && <CurveSection node={node} scene={scene} rest={rest} sourceKey={sourceKey} />}

      {(node.kind === "mesh" || (node.kind === "part" && !node.generator) || (node.kind === "model" && node.generator?.type === "rig")) && <RigSection node={node} scene={scene} rest={rest} sourceKey={sourceKey} />}

      {node.kind === "part" && node.generator?.type === "text" && <TextSection node={node} scene={scene} rest={rest} sourceKey={sourceKey} />}

      {node.kind === "mesh" && node.primitive && (
        <Section id="shape" title="Shape" icon={nodeIconName(node)} summary={PRIMITIVE_LABEL[node.primitive.type]}>
          {primitiveParams(node.primitive).map((param) => (
            <div key={param.key} className="p3d-field-row">
              <span className="p3d-label" title={param.technical}>{param.label}</span>
              <ScrubField
                handle="↔"
                ariaLabel={param.label}
                value={param.value}
                step={param.integer ? 1 : 0.05}
                integer={param.integer}
                min={param.integer ? 3 : 0.001}
                max={param.integer ? 64 : undefined}
                unit={param.integer ? undefined : "m"}
                title={`${param.label} (${param.technical}) — drag to change`}
                onCommit={(v) =>
                  updateNodeFields(rest, scene, current.id, {
                    primitive: { type: current.primitive?.type, [param.key]: v },
                  })
                }
                onError={onEditError}
              />
            </div>
          ))}
          <div className="p3d-help">“Smoothness” sets how many sides curved shapes have.</div>
        </Section>
      )}

      {node.kind === "light" && node.light && (
        <Section id="light" title="Light" icon={nodeIconName(node)} summary={kindWords(node)}>
          <div className="p3d-label">Colour</div>
          <SwatchGrid
            value={node.light.color}
            ariaLabel="Light colour"
            onPick={(hex) =>
              void updateNodeFields(rest, scene, current.id, { light: { color: hex } }).catch(onEditError)
            }
          />
          <div className="p3d-label">Brightness</div>
          <Slider
            ariaLabel="Intensity"
            value={node.light.intensity}
            min={0}
            max={node.light.type === "directional" ? 10 : 100}
            step={0.1}
            ends={["Dim", "Bright"]}
            onCommit={(v) => updateNodeFields(rest, scene, current.id, { light: { intensity: v } })}
            onError={onEditError}
          />
          {node.light.type !== "directional" && (
            <>
              <div className="p3d-field-row">
                <span className="p3d-label">Reach</span>
                <ScrubField
                  handle="↔"
                  ariaLabel="Distance"
                  value={node.light.distance ?? 0}
                  step={0.5}
                  min={0}
                  unit="m"
                  onCommit={(v) => updateNodeFields(rest, scene, current.id, { light: { distance: v } })}
                  onError={onEditError}
                />
              </div>
              <div className="p3d-help">0 means no range limit.</div>
            </>
          )}
          {node.light.type === "spot" && (
            <>
              <div className="p3d-field-row">
                <span className="p3d-label">Cone</span>
                <ScrubField
                  handle="∠"
                  ariaLabel="Cone angle"
                  value={node.light.angle ?? 60}
                  step={1}
                  min={1}
                  max={89}
                  unit="°"
                  onCommit={(v) => updateNodeFields(rest, scene, current.id, { light: { angle: v } })}
                  onError={onEditError}
                />
              </div>
              <div className="p3d-label">Edge</div>
              <Slider
                ariaLabel="Penumbra"
                value={node.light.penumbra ?? 0}
                ends={["Sharp", "Soft"]}
                onCommit={(v) => updateNodeFields(rest, scene, current.id, { light: { penumbra: v } })}
                onError={onEditError}
              />
            </>
          )}
        </Section>
      )}

      {node.kind === "camera" && node.camera && (
        <Section id="camera" title="Camera" icon="camera">
          <div className="p3d-label">Lens</div>
          <Slider
            ariaLabel="Field of view"
            value={node.camera.fov}
            min={10}
            max={120}
            step={1}
            ends={["Zoomed in", "Wide"]}
            onCommit={(v) => updateNodeFields(rest, scene, current.id, { camera: { fov: v } })}
            onError={onEditError}
          />
          <div className="p3d-field-row">
            <span className="p3d-label">Near</span>
            <ScrubField
              handle="↔"
              ariaLabel="Near"
              value={node.camera.near}
              step={0.01}
              min={0.0001}
              unit="m"
              onCommit={(v) => updateNodeFields(rest, scene, current.id, { camera: { near: v } })}
              onError={onEditError}
            />
          </div>
          <div className="p3d-field-row">
            <span className="p3d-label">Far</span>
            <ScrubField
              handle="↔"
              ariaLabel="Far"
              value={node.camera.far}
              step={1}
              min={0.01}
              unit="m"
              onCommit={(v) => updateNodeFields(rest, scene, current.id, { camera: { far: v } })}
              onError={onEditError}
            />
          </div>
          <div className="p3d-actions">
            <button
              type="button"
              className="p3d-btn p3d-btn--outline p3d-btn--sm"
              title="Point this camera where you are looking now"
              onClick={() => void setCameraFromView().catch(onEditError)}
            >
              <Icon name="camera" size={15} />
              Set from view
            </button>
          </div>
          <div className="p3d-help">
            This camera is saved in the file. The view you orbit is separate.
          </div>
        </Section>
      )}

      {node.kind === "splat" && <Section id="splat" title={SPLAT_COPY.title} icon="model"><p>{SPLAT_COPY.detail}</p><dl className="p3d-stat-grid"><dt>{SPLAT_COPY.count}</dt><dd>{Math.floor((scene.assets.find(a => a.id === node.splatAssetId)?.bytes ?? 0) / 32).toLocaleString()}</dd></dl></Section>}
      {node.kind === "model" && (
        <Section id="model" title="Model" icon="model" summary={asset ? asset.sourceFormat.toUpperCase() : undefined}>
          {asset ? (
            <dl className="p3d-stat-grid">
              <dt>File</dt>
              <dd style={{ wordBreak: "break-all" }}>{asset.originalName}</dd>
              <dt>Format</dt>
              <dd>{asset.sourceFormat}</dd>
              <dt>Size</dt>
              <dd>{formatBytes(asset.bytes)}</dd>
              <dt>Triangles</dt>
              <dd>
                {asset.stats.tris === null || asset.stats.tris === undefined
                  ? "Triangles unknown"
                  : String(asset.stats.tris)}
              </dd>
              <dt>Vertices</dt>
              <dd>{asset.stats.verts ?? "—"}</dd>
              <dt>Materials</dt>
              <dd>{asset.stats.materials ?? "—"}</dd>
              <dt>Bounds</dt>
              <dd>
                {asset.stats.bounds
                  ? `${formatVec(asset.stats.bounds.min)} – ${formatVec(asset.stats.bounds.max)}`
                  : "—"}
              </dd>
              <dt>Clips</dt>
              <dd>{String(asset.stats.clips ?? 0)}</dd>
              <dt>Skins</dt>
              <dd>{String(asset.stats.skins ?? 0)}</dd>
            </dl>
          ) : (
            <div className="p3d-muted">Asset record missing.</div>
          )}
          {asset?.stats.ignored && asset.stats.ignored.length > 0 && (
            <div>
              <div className="p3d-label">Ignored</div>
              <ul style={{ margin: "4px 0 0", paddingLeft: 16, fontSize: 12 }}>
                {asset.stats.ignored.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="p3d-help" style={{ display: "flex", gap: 6 }}>
            <Icon name="lock" size={14} />
            <span>{LOCKED_SENTENCE}</span>
          </div>
        </Section>
      )}

      {node.kind === "part" && (
        <Section id="part" title="Part" icon="part">
          <dl className="p3d-stat-grid">
            <dt>Part of</dt>
            <dd>{`"${partModelName ?? "—"}"`}</dd>
            <dt>File</dt>
            <dd>{asset?.originalName ?? "—"}</dd>
            <dt>Mesh</dt>
            <dd>{String(node.meshIndex ?? "—")}</dd>
            <dt>Primitive</dt>
            <dd>{String(node.primitiveIndex ?? "—")}</dd>
            <PartStats node={node} asset={asset} />
          </dl>
        </Section>
      )}

      {(node.kind === "mesh" || node.kind === "model") && (
        <Section id="size" title="Size" icon="ruler" summary={sizeSummary(node, asset)}>
          <NodeStats node={node} asset={asset} />
        </Section>
      )}

      <HealthSection health={health} scene={scene} cleanup={cleanup} selection={selection} focusRequest={healthFocus} />

      <Section id="actions" title="Actions" icon="more">
        <div className="p3d-actions">
          <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => void doDuplicate()}>
            <Icon name="duplicate" size={15} />
            Duplicate
            <span className="p3d-kbd">⌘D</span>
          </button>
          <button
            type="button"
            className="p3d-btn p3d-btn--outline p3d-btn--sm p3d-btn--danger"
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={15} />
            Delete
          </button>
        </div>
      </Section>

      {mapPick !== null &&
        sourceKey !== undefined &&
        gizmoMode !== undefined &&
        // Wait until the scene has caught up with the node's new material.
        scene.materials.some((m) => m.id === mapPick.materialId) && (
          <ImportDialog
            rest={rest}
            scene={scene}
            sourceKey={sourceKey}
            files={files ?? null}
            selection={selection}
            gizmoMode={gizmoMode}
            mapTarget={mapPick}
            onClose={() => setMapPick(null)}
          />
        )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${node.name}”?`}
          body="This removes that node and anything parented under it."
          confirmLabel="Delete"
          onConfirm={() => void doDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

// --- material section ----------------------------------------------------------

function MaterialSection({
  material,
  isOverride,
  sharedWith,
  onCommit,
}: {
  material: MaterialSpec | undefined;
  isOverride: boolean;
  sharedWith: number;
  onCommit: (fields: MaterialFields) => Promise<unknown>;
}) {
  const prefs = useViewPrefs();
  const shown: MaterialSpec = material ?? { ...DEFAULT_MATERIAL };
  const active = matchingPreset(shown);
  const commit = (fields: Partial<MaterialSpec>) => onCommit(fields).catch(onEditError);
  return (
    <Section
      id="material"
      title={isOverride ? "Material override" : "Material"}
      icon="palette"
      summary={`${active?.label ?? "Custom"} · ${paletteName(shown.color) ?? shown.color}`}
    >
      {isOverride && (
        <div className="p3d-help">
          No override yet — editing here creates one for this part only.
        </div>
      )}
      {sharedWith > 0 && (
        <div className="p3d-help">
          Shared with {sharedWith === 1 ? "1 other object" : `${sharedWith} other objects`}. Changes here give this one its own copy.
        </div>
      )}
      <div className="p3d-balls" role="group" aria-label="Material presets">
        {MATERIAL_PRESETS.map((preset) => {
          const fields = presetFields(preset, shown);
          return (
            <button
              key={preset.id}
              type="button"
              className="p3d-ballbtn"
              aria-pressed={active?.id === preset.id}
              title={preset.hint}
              onClick={() => void commit(fields)}
            >
              <MaterialBall
                look={{
                  color: fields.color ?? shown.color,
                  roughness: preset.roughness,
                  metalness: preset.metalness,
                  opacity: preset.opacity,
                  emissive: fields.emissive,
                }}
              />
              {preset.label}
            </button>
          );
        })}
      </div>
      <div className="p3d-label">Colour</div>
      <SwatchGrid
        value={shown.color}
        ariaLabel="Colour"
        recent={prefs.recentColors}
        onPick={(hex) => {
          if (!paletteName(hex)) rememberColor(hex);
          const glowing = shown.emissive.toLowerCase() !== "#000000";
          void commit(glowing && shown.emissive.toLowerCase() === shown.color.toLowerCase()
            ? { color: hex, emissive: hex }
            : { color: hex });
        }}
      />
      <div className="p3d-label">Finish</div>
      <div title="How blurry reflections are. Low is shiny, high is chalky."><Slider
        ariaLabel="Roughness"
        value={shown.roughness}
        ends={["Shiny", "Rough"]}
        onCommit={(v) => onCommit({ roughness: v })}
        onError={onEditError}
      />
      </div><div title="How much the surface behaves like metal."><Slider
        ariaLabel="Metalness"
        value={shown.metalness}
        ends={["Plastic", "Metal"]}
        onCommit={(v) => onCommit({ metalness: v })}
        onError={onEditError}
      />
      </div><MoreMaterial shown={shown} onCommit={onCommit} />
    </Section>
  );
}

/** Pictures on the surface: its own section, beside Material, UV map and Rig. */
function TexturesSection({ material, rest, assetsById, onPickMap, onCommit }: {
  material: MaterialSpec | undefined;
  rest: RestFn;
  assetsById: Map<string, AssetSpec>;
  onPickMap: (slot: MapSlot) => void;
  onCommit: (fields: MaterialFields) => Promise<unknown>;
}) {
  const shown: MaterialSpec = material ?? { ...DEFAULT_MATERIAL };
  const filled = MAP_SLOTS.filter((slot) => shown[slot] !== undefined).length;
  return (
    <Section id="textures" title="Textures" icon="image" summary={filled === 0 ? "None" : `${filled} of ${MAP_SLOTS.length}`}>
      <MapsBlock
        shown={shown}
        rest={rest}
        assetsById={assetsById}
        onPick={onPickMap}
        onClear={(slot) => void onCommit({ [slot]: null }).catch(onEditError)}
      />
    </Section>
  );
}

// --- health (PR16) ----------------------------------------------------------------

/** The compatibility report (redesign §7.3): findings as icon + sentence rows. */
function HealthSection({ health, scene, cleanup, selection, focusRequest }: {
  health: HealthState;
  scene: SceneSpec;
  cleanup: CleanupPreviewState;
  selection: SelectionStore;
  focusRequest: { current: { scope: string; label: string } | null };
}) {
  const { report, running, failed, budget, setBudget, run, comparison } = health;
  const tidy = cleanup.preview?.cleanup ?? null;
  const tidyOps = cleanup.preview?.operations ?? [];
  const tidyBusy = cleanup.busy;
  const tidyMessage = cleanup.message;
  const previewTidy = cleanup.run;
  const applyTidy = cleanup.apply;
  const healthRoot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pending = focusRequest.current;
    if (!pending) return;
    focusRequest.current = null;
    if (pending.scope !== cleanup.scope) return;
    Array.from(healthRoot.current?.querySelectorAll("button") ?? []).find(button => button.getAttribute("aria-label") === pending.label)?.focus();
  });
  const knownIds = new Set(scene.nodes.map(node => node.id));
  const showObjects = (ids: string[], additive: boolean, label: string) => {
    const valid = [...new Set(ids)].filter(id => knownIds.has(id));
    if (!valid.length) return;
    const previous = selection.getSnapshot().ids;
    const next = additive ? [...new Set([...previous, ...valid])] : valid;
    if (next.length === previous.length && next.every((id, i) => id === previous[i])) return;
    focusRequest.current = { scope: cleanup.scope, label };
    selection.set(next);
  };
  const showButton = (ids: string[], label: string) => {
    const valid = ids.filter(id => knownIds.has(id));
    return valid.length ? <button type="button" className="p3d-btn p3d-btn--sm" aria-label={label} onClick={event => showObjects(valid, event.metaKey || event.ctrlKey || event.shiftKey, label)}>Show objects</button> : null;
  };
  const tidyHasWork = tidy !== null && tidy.applied === false && tidy.summary[0] !== COPY.tidyNothing;
  return (
    <Section
      id="health"
      title="Health"
      icon="check"
      defaultOpen={false}
      summary={healthSummary(report)}
    >
      <div className="p3d-health" ref={healthRoot}>
        {report === null && !failed && <div className="p3d-help">{COPY.healthIntro}</div>}
        {report !== null && (
          <>
            <div className="p3d-health-head" role="status">{healthHeadline(report)}</div>
            {hasOutput(report) && <p className="p3d-help" data-testid="health-output">
              {COPY.healthOutput}: {(report.output.bytes / 1024).toFixed(1)} KiB · {COPY.healthOutputJson}: {(report.output.jsonBytes / 1024).toFixed(1)} KiB · {COPY.healthOutputNodes}: {report.output.nodes} · {COPY.healthOutputSkins}: {report.output.skins} · {COPY.healthOutputClips}: {report.output.clips}
            </p>}
            {report.issues.length > 0 && (
              <ul className="p3d-health-list">
                {report.issues.map((issue, index) => (
                  <li
                    key={`${issue.code}-${index}`}
                    className="p3d-health-row"
                    data-severity={issue.severity}
                    title={issue.code}
                  >
                    <Icon name={issue.severity === "info" ? "info" : "warning"} size={15} />
                    <span>
                      <strong>{severityLabel(issue.severity)}.</strong> {issue.message}
                      {issue.provenance && <small className="p3d-muted"> · {issue.provenance === "output" ? COPY.healthOutputScope : issue.provenance === "source" ? COPY.healthSourceScope : COPY.healthSceneScope}</small>}
                      {issue.sourceFindings && issue.sourceFindings.length > 0 && <span className="p3d-help" style={{ display: "block" }}>{COPY.healthSourceEvidence}: {issue.sourceFindings.map((source) => `${source.message}${source.where ? ` (${source.where})` : ""}`).join("; ")}</span>}
                      {issue.where && <span className="p3d-health-where"> ({issue.where})</span>}
                      {showButton([...(issue.nodeIds ?? []), ...(issue.sourceFindings ?? []).flatMap(source => source.nodeIds ?? [])], `Show objects for finding ${index + 1}`)}
                      {issue.code === "DEGENERATE_TRIANGLES" && <button type="button" className="p3d-btn p3d-btn--sm" disabled={tidyBusy} onClick={() => void previewTidy(["weld"])}>Preview weld</button>}
                      {issue.code === "MANY_MATERIALS" && <button type="button" className="p3d-btn p3d-btn--sm" disabled={tidyBusy} onClick={() => void previewTidy(["dedupe_materials", "prune_materials", "prune_groups"])}>Preview material tidy</button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {comparison && <div className="p3d-help" data-testid="health-comparison">
              <strong>Checked revision {comparison.before.revision} → {comparison.after.revision}</strong>
              <dl className="p3d-stat-grid">{comparisonRows(comparison).flatMap(([label, value]) => [<dt key={label}>{label}</dt>, <dd key={`${label}-value`}>{value}</dd>])}</dl>
              This surface session only; same budget and weight version. Estimates can change when checks are partial.
            </div>}
            {hasAnalysis(report) && (
              <>
                <div className="p3d-health-score" data-score={report.analysis.score.value ?? "none"}>
                  <strong>{scoreLine(report.analysis)}</strong>
                  <span className="p3d-help">
                    {report.analysis.score.value === null
                      ? report.analysis.score.reason
                      : COPY.healthScoreHint}
                    {report.analysis.score.basedOnPartialChecks && report.analysis.score.value !== null
                      ? " Some checks were skipped, so this may be generous."
                      : ""}
                  </span>
                </div>
                <dl className="p3d-stat-grid" aria-label={COPY.healthNumbers}>
                  {countRows(report.analysis).flatMap(([label, value]) => [
                    <dt key={`${label}-t`}>{label}</dt>,
                    <dd key={`${label}-d`}>{value}</dd>,
                  ])}
                </dl>
              </>
            )}
            {nodeCosts(report).length > 0 && <details className="p3d-help" open={health.costsOpen} onToggle={event => health.setCostsOpen(event.currentTarget.open)}>
              <summary>Object costs · base-pass estimates</summary>
              <p>Draw estimates use editor visibility and assume imported content loads, before batching. GLB still contains hidden objects; editor bounds substitutes are excluded. Culling, shadows and extra transparency passes can change actual work. Asset bytes are shared references, not memory owned by each object. Geometry includes hidden objects. Material and texture totals can include unused imported items; skipped checks can leave totals incomplete.</p>
              <ul>{nodeCosts(report).map(row => <li key={row.nodeId}>
                <span>{row.name}: {row.triangles?.toLocaleString() ?? "unknown"} triangles · {row.drawCalls?.toLocaleString() ?? "unknown"} estimated draws{row.visible ? "" : " · hidden"} · {row.referencedAssetBytes === null ? "unknown" : formatBytes(row.referencedAssetBytes)} referenced asset</span>
                {showButton([row.nodeId], `Select ${row.name}`)}
              </li>)}</ul>
            </details>}
            {report.unchecked.length > 0 && (
              <div className="p3d-help">
                {COPY.healthNotChecked}: {report.unchecked.map((u) => `${u.what} (${u.reason})`).join("; ")}.
              </div>
            )}
          </>
        )}
        {failed && <div className="p3d-help" role="alert">{COPY.healthFailed}</div>}
        {cleanup.busy && !cleanup.posting && tidy === null && <button type="button" className="p3d-btn p3d-btn--sm" onClick={cleanup.cancel}>Cancel preview</button>}
        {tidy !== null && (
          <div className="p3d-tidy" role="group" aria-label="Tidy up preview">
            <ul>
              {tidy.summary.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {tidyHasWork && (
              <div className="p3d-help">
                {[
                  ...tidy.changes.materialsMerged.map((m) => `${m.from} → ${m.into}`),
                  ...tidy.changes.materialsRemoved,
                  ...tidy.changes.groupsRemoved.map((g) => g.name ?? g.id),
                  ...(tidy.changes.assetsWelded ?? []).map((w) => w.name),
                ].join(", ")}
              </div>
            )}
            <ul className="p3d-help" aria-label="Affected objects">
              {tidy.changes.materialsMerged.map(row => <li key={row.from}>Material {row.from} → {row.into} {showButton(scene.nodes.filter(node => node.materialId === row.from).map(node => node.id), `Show material ${row.from} objects`)}</li>)}
              {tidy.changes.groupsRemoved.map(row => <li key={row.id}>Group {row.name ?? row.id} {showButton([row.id], `Show group ${row.name ?? row.id}`)}</li>)}
              {(tidy.changes.assetsWelded ?? []).map(row => <li key={row.assetId}>Model {row.name} {showButton(row.nodes ?? scene.nodes.filter(node => node.modelAssetId === row.assetId).map(node => node.id), `Show model ${row.name}`)}{row.becameDrawable === true && <span> · Would meet the mesh and byte draw limits after Apply; loading can still fail.</span>}</li>)}
              {tidy.changes.nodesRepointed.length > 0 && <li>{showButton(tidy.changes.nodesRepointed, "Show all repointed objects")}</li>}
            </ul>
            {(tidy.changes.weldSkipped ?? []).length > 0 && (
              <div className="p3d-help">
                {COPY.weldLeftAlone}: {(tidy.changes.weldSkipped ?? []).map((s) => `${s.what} (${s.reason})`).join("; ")}.
              </div>
            )}
            <div className="p3d-actions">
              {tidyHasWork && (
                <button
                  type="button"
                  className="p3d-btn p3d-btn--sm"
                  disabled={tidyBusy}
                  onClick={() => void applyTidy()}
                >
                  {tidyOps.includes("weld") ? COPY.weldApply : COPY.tidyApply}
                </button>
              )}
              <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" disabled={cleanup.posting} onClick={cleanup.cancel}>
                {COPY.tidyCancel}
              </button>
            </div>
          </div>
        )}
        {tidyMessage !== null && (
          <div className="p3d-help" role={tidyMessage === COPY.tidyFailed ? "alert" : "status"}>{tidyMessage}</div>
        )}
        <div className="p3d-label">{COPY.healthBudget}</div>
        <div className="p3d-health-seg" role="group" aria-label="Budget">
          {(["mobile", "desktop"] as const).map((name) => (
            <button
              key={name}
              type="button"
              className="p3d-btn p3d-btn--sm"
              aria-pressed={budget === name}
              onClick={() => setBudget(name)}
            >
              {name === "mobile" ? "Phone" : "Desktop"}
            </button>
          ))}
        </div>
        <div className="p3d-actions">
          <button
            type="button"
            className="p3d-btn p3d-btn--outline p3d-btn--sm"
            disabled={running}
            onClick={() => void run()}
          >
            {running ? COPY.healthRunning : report ? COPY.healthRerun : COPY.healthRun}
          </button>
          <button
            type="button"
            className="p3d-btn p3d-btn--outline p3d-btn--sm"
            disabled={tidyBusy}
            title={COPY.tidyIntro}
            onClick={() => void previewTidy(["dedupe_materials", "prune_materials", "prune_groups"])}
          >
            {COPY.tidyButton}
          </button>
          <button
            type="button"
            className="p3d-btn p3d-btn--outline p3d-btn--sm"
            disabled={tidyBusy}
            title={COPY.weldIntro}
            onClick={() => void previewTidy(["weld"])}
          >
            {COPY.weldButton}
          </button>
        </div>
      </div>
    </Section>
  );
}

// --- texture maps (PR15) ---------------------------------------------------------

const MAP_LABELS: Record<MapSlot, { title: string; hint: string }> = {
  baseColorMap: { title: "Picture", hint: "Paints this picture on the surface." },
  normalMap: { title: "Bumps", hint: "Adds fine bumps and dents without changing the shape." },
  metallicRoughnessMap: { title: "Shine and metal", hint: "Says which parts are shiny or metallic." },
  emissiveMap: { title: "Glow picture", hint: "A picture of what lights up on its own." },
};

/** A small object-URL preview of an image asset, fetched through the byte route. */
function useAssetPreview(rest: RestFn, asset: AssetSpec | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const sha = asset?.sha256;
  useEffect(() => {
    if (!asset || !sha) {
      setUrl(null);
      return undefined;
    }
    let cancelled = false;
    let made: string | null = null;
    getAssetBytes(rest, sha)
      .then((bytes) => {
        if (cancelled) return;
        made = URL.createObjectURL(new Blob([bytes], { type: mimeTypeFor(asset) }));
        setUrl(made);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
    // The bytes depend on the image, not on every render of the asset row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sha]);
  return url;
}

function MapTile({
  slot,
  asset,
  rest,
  onPick,
  onClear,
}: {
  slot: MapSlot;
  asset: AssetSpec | undefined;
  rest: RestFn;
  onPick: () => void;
  onClear: () => void;
}) {
  const preview = useAssetPreview(rest, asset);
  const label = MAP_LABELS[slot];
  return (
    <div className="p3d-map-tile" data-slot={slot} title={label.hint}>
      <div className="p3d-map-thumb" aria-hidden={preview === null}>
        {preview ? <img src={preview} alt="" draggable={false} /> : <Icon name="image" size={18} />}
      </div>
      <div className="p3d-map-meta">
        <div className="p3d-map-title">{label.title}</div>
        <div className="p3d-muted p3d-map-sub">
          {asset
            ? `${asset.originalName || "picture"} · ${asset.stats.width ?? "?"} × ${asset.stats.height ?? "?"}`
            : "None"}
        </div>
      </div>
      <div className="p3d-map-actions">
        <button
          type="button"
          className="p3d-btn p3d-btn--outline p3d-btn--sm"
          aria-label={`${asset ? "Replace" : "Choose"} ${label.title.toLowerCase()} image`}
          onClick={onPick}
        >
          {asset ? "Replace" : "Choose…"}
        </button>
        {asset && (
          <button
            type="button"
            className="p3d-btn p3d-btn--sm"
            aria-label={`Clear ${label.title.toLowerCase()} image`}
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function MapsBlock({
  shown,
  rest,
  assetsById,
  onPick,
  onClear,
}: {
  shown: MaterialSpec;
  rest: RestFn;
  assetsById: Map<string, AssetSpec>;
  onPick: (slot: MapSlot) => void;
  onClear: (slot: MapSlot) => void;
}) {
  return (
    <div className="p3d-maps" role="group" aria-label="Maps">
      {MAP_SLOTS.map((slot) => {
        const id = shown[slot];
        const asset = id !== undefined ? assetsById.get(id) : undefined;
        return (
          <MapTile
            key={slot}
            slot={slot}
            asset={isImageAsset(asset) ? asset : undefined}
            rest={rest}
            onPick={() => onPick(slot)}
            onClear={() => onClear(slot)}
          />
        );
      })}
      {(
        <div className="p3d-help">
          Pictures are copied into your scene. A model part can only carry a picture if the model has texture coordinates.
        </div>
      )}
    </div>
  );
}

function MoreMaterial({
  shown,
  onCommit,
}: {
  shown: MaterialSpec;
  onCommit: (fields: MaterialFields) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        className="p3d-btn p3d-btn--sm"
        style={{ paddingLeft: 4 }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="chevron" size={14} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform var(--p3d-med) var(--p3d-ease)" }} />
        More
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
          <div className="p3d-label">See-through</div>
          <Slider
            ariaLabel="Opacity"
            value={shown.opacity}
            ends={["Clear", "Solid"]}
            onCommit={(v) => onCommit({ opacity: v })}
            onError={onEditError}
          />
          <div className="p3d-label">Glow colour</div>
          <div className="p3d-color-row">
            <input
              type="color"
              className="p3d-color-input"
              title="Light the surface gives off by itself. It does not light other objects." aria-label="Emissive"
              value={/^#[0-9a-f]{6}$/i.test(shown.emissive) ? shown.emissive : "#000000"}
              onChange={() => {}}
              onBlur={(e) => {
                const v = e.target.value.toLowerCase();
                if (v !== shown.emissive.toLowerCase()) void onCommit({ emissive: v }).catch(onEditError);
              }}
            />
            <button
              type="button"
              className="p3d-btn p3d-btn--sm"
              disabled={shown.emissive.toLowerCase() === "#000000"}
              onClick={() => void onCommit({ emissive: "#000000" }).catch(onEditError)}
            >
              No glow
            </button>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Checkbox
              checked={shown.doubleSide}
              onCheckedChange={(checked) =>
                void onCommit({ doubleSide: checked === true }).catch(onEditError)
              }
            />
            <span>Double-sided</span>
          </label>
          <div className="p3d-help">Double-sided draws the back of thin surfaces too.</div>
        </div>
      )}
    </div>
  );
}

// --- part + node stats ---------------------------------------------------------

function PartStats({ node, asset }: { node: NodeSpec; asset?: AssetSpec }) {
  const part = asset?.stats.parts?.find(
    (p) => p.meshIndex === node.meshIndex && p.primitiveIndex === node.primitiveIndex,
  );
  if (!part) {
    return (
      <>
        <dt>Stats</dt>
        <dd>No per-part stats recorded.</dd>
      </>
    );
  }
  return (
    <>
      <dt>Triangles</dt>
      <dd>{String(part.tris)}</dd>
      <dt>Vertices</dt>
      <dd>{String(part.verts)}</dd>
      <dt>Bounds</dt>
      <dd>{`${formatVec(part.bounds.min)} – ${formatVec(part.bounds.max)}`}</dd>
    </>
  );
}

function sizeSummary(node: NodeSpec, asset?: AssetSpec): string | undefined {
  const box = node.kind === "mesh" ? meshBox(node) : asset?.stats.bounds ? boxFrom(asset.stats.bounds) : null;
  if (!box) return undefined;
  const size = box.getSize(new THREE.Vector3());
  return `${formatMeters(size.y)} tall`;
}

function boxFrom(b: { min: [number, number, number]; max: [number, number, number] }): THREE.Box3 {
  return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
}

function NodeStats({ node, asset }: { node: NodeSpec; asset?: AssetSpec }) {
  if (node.kind === "mesh" && node.primitive) {
    const counts = countPrimitive(node.primitive);
    const box = meshBox(node);
    const size = box?.getSize(new THREE.Vector3());
    return (
      <dl className="p3d-stat-grid">
        {size && (
          <>
            <dt>Width × height × depth</dt>
            <dd>{`${formatMeters(size.x)} × ${formatMeters(size.y)} × ${formatMeters(size.z)}`}</dd>
          </>
        )}
        <dt>Triangles</dt>
        <dd>{counts ? String(counts.tris) : "—"}</dd>
        <dt>Vertices</dt>
        <dd>{counts ? String(counts.verts) : "—"}</dd>
        <dt>Materials</dt>
        <dd>1</dd>
        <dt>Bounds</dt>
        <dd>{box ? `${formatVec([box.min.x, box.min.y, box.min.z])} – ${formatVec([box.max.x, box.max.y, box.max.z])}` : "—"}</dd>
      </dl>
    );
  }
  if (node.kind === "model" && asset) {
    const box = asset.stats.bounds ? boxFrom(asset.stats.bounds) : null;
    const size = box?.getSize(new THREE.Vector3());
    return (
      <dl className="p3d-stat-grid">
        {size && (
          <>
            <dt>Width × height × depth</dt>
            <dd>{`${formatMeters(size.x)} × ${formatMeters(size.y)} × ${formatMeters(size.z)}`}</dd>
          </>
        )}
        <dt>Triangles</dt>
        <dd>
          {asset.stats.tris === null || asset.stats.tris === undefined
            ? "Triangles unknown"
            : String(asset.stats.tris)}
        </dd>
        <dt>Vertices</dt>
        <dd>{asset.stats.verts ?? "—"}</dd>
        <dt>Materials</dt>
        <dd>{asset.stats.materials ?? "—"}</dd>
      </dl>
    );
  }
  return null;
}

/** World-space box of a mesh node (local primitive bounds × transform). */
function meshBox(node: NodeSpec): THREE.Box3 | null {
  if (!node.primitive) return null;
  const local = primitiveLocalBounds(node.primitive);
  if (!local) return null;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(node.transform.r[0]),
    THREE.MathUtils.degToRad(node.transform.r[1]),
    THREE.MathUtils.degToRad(node.transform.r[2]),
    "XYZ",
  );
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...node.transform.t),
    new THREE.Quaternion().setFromEuler(euler),
    new THREE.Vector3(...node.transform.s),
  );
  const box = new THREE.Box3();
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      for (const z of [local.min[2], local.max[2]]) {
        box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(matrix));
      }
    }
  }
  return box;
}

/** Editable numeric params of a primitive, with plain labels (§7.3). */
function primitiveParams(primitive: NonNullable<NodeSpec["primitive"]>): Array<{
  key: string;
  label: string;
  technical: string;
  value: number;
  integer: boolean;
}> {
  const segmentKeys = new Set([
    "widthSegments",
    "heightSegments",
    "radialSegments",
    "tubularSegments",
    "capSegments",
  ]);
  const type = primitive.type;
  const labels: Record<string, string> = {
    width: "Width",
    height: "Height",
    depth: "Depth",
    radius: type === "torus" ? "Ring size" : "Radius",
    radiusTop: "Top radius",
    radiusBottom: "Bottom radius",
    tube: "Ring thickness",
    length: "Length",
    widthSegments: "Smoothness",
    heightSegments: "Smoothness (rings)",
    radialSegments: type === "torus" ? "Smoothness (around tube)" : "Smoothness",
    tubularSegments: "Smoothness (around ring)",
    capSegments: "Cap smoothness",
  };
  // Show every parameter, filling the spec defaults for the ones the
  // node does not set (an agent-built primitive often sets none).
  const merged: Record<string, unknown> = { ...(PRIMITIVE_DEFAULTS[type] ?? {}), ...primitive };
  return Object.entries(merged)
    .filter(([key]) => key !== "type")
    .map(([key, value]) => ({
      key,
      label: labels[key] ?? key,
      technical: key,
      value: typeof value === "number" ? value : 0,
      integer: segmentKeys.has(key),
    }));
}
