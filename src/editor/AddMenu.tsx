// src/editor/AddMenu.tsx — the Add popover (UI/UX redesign §7.5, PR32).
//
// `+ Add` is the editor's one filled primary button. It opens a
// plugin-owned popover of illustrated tiles: Shapes (7), Light & camera
// (sun, bulb, spot, camera), Organize (group). Type to filter, Enter
// adds the first match. Shift+A opens it from anywhere on the editor
// root (ignored while typing); the pane has no Add (§6.2).
//
// Placement (§5.7): a new shape lands ON the floor (its analytic bottom
// at y = 0) where the user is looking (the orbit target, snapped to
// 0.5 m), stepping along +X if it would land inside something added in
// this session. Planes are created flat (r = [-90, 0, 0]). A directional
// or spot light is aimed at the target from above-front; a camera
// copies the current orbit view ("camera from view"). One PATCH, one
// history entry; the agent's add_node is unchanged.
//
// Each new shape gets its own material in the next colour of a friendly
// cycle, so a scene built from the Add menu is colourful by default and
// recolouring one object never recolours its siblings. The material is
// created in the same patch (set_material with a minted id, then
// add_node), under the 32-op cap.

import { useEffect, useMemo, useRef, useState } from "react";
import type { RestFn } from "../api";
import { patchScene } from "../api";
import type { PatchOp } from "../api";
import { COPY, toastForCode } from "../copy";
import { addText } from "./TextSection";
import { addCurve } from "./CurveSection";
import type { SelectionStore } from "../state/selection";
import type { NodeSpec, PrimitiveSpec, SceneSpec } from "../types";
import { notifyToast } from "./sceneActions";
import { primitiveLocalBounds } from "../scene/primitiveStats";
import { DEFAULT_MATERIAL, buildAddNode, uniqueNodeName } from "../scene/placement";
import type { AddKind, Placement } from "../scene/placement";
export { DEFAULT_MATERIAL, aimRotation, buildAddNode, floorY, uniqueNodeName } from "../scene/placement";
export type { AddKind, Placement } from "../scene/placement";
import { getLivePosition, getLiveTarget } from "../state/cameraPose";
import { Icon } from "../ui/icons";
import type { IconName } from "../ui/icons";
import { Popover, Tile } from "../ui/controls";

/** The colour cycle for new shapes (palette names: Coral, Sky, Marigold,
 *  Leaf, Plum, Teal, Blush, Ocean). */
const SHAPE_COLORS = ["#f07c6a", "#5ba8e0", "#f2b33d", "#6baf4b", "#7b4b94", "#2e9c97", "#e9a8b8", "#2d5da8"];
let colorCursor = 0;

interface AddItem {
  kind: AddKind | "text" | "curve";
  label: string;
  icon: IconName;
  hint: string;
  keywords: string;
}

const SHAPES: AddItem[] = [
  { kind: "box", label: "Box", icon: "box", hint: "Box — crates, tables, buildings", keywords: "cube block" },
  { kind: "sphere", label: "Sphere", icon: "sphere", hint: "Sphere — balls, heads, planets", keywords: "ball round" },
  { kind: "cylinder", label: "Cylinder", icon: "cylinder", hint: "Cylinder — cans, pillars, wheels", keywords: "tube can pillar" },
  { kind: "cone", label: "Cone", icon: "cone", hint: "Cone — hats, roofs, trees", keywords: "pyramid hat" },
  { kind: "torus", label: "Torus", icon: "torus", hint: "Torus — rings, donuts, tyres", keywords: "ring donut" },
  { kind: "plane", label: "Plane", icon: "plane", hint: "Plane — a flat floor or table top", keywords: "floor ground flat" },
  { kind: "capsule", label: "Capsule", icon: "capsule", hint: "Capsule — pills, limbs, rounded posts", keywords: "pill" },
];
const LIGHTS: AddItem[] = [
  { kind: "directional", label: "Sun", icon: "sun", hint: "Directional light — even light from one direction, like the sun", keywords: "directional light" },
  { kind: "point", label: "Bulb", icon: "bulb", hint: "Point light — glows out in every direction, like a bulb", keywords: "point light lamp" },
  { kind: "spot", label: "Spot", icon: "spot", hint: "Spot light — a cone of light, like a torch", keywords: "spot light torch" },
  { kind: "camera", label: "Camera", icon: "camera", hint: "Camera — saves the view you're looking from now", keywords: "view" },
];
const ORGANIZE: AddItem[] = [
  { kind: "group", label: "Group", icon: "group", hint: "Group — an empty folder to hold other objects", keywords: "folder empty null" },
  { kind: "text", label: "Text", icon: "model", hint: COPY.textAddHint, keywords: "words letters type 3d" },
  { kind: "curve", label: "Curve", icon: "model", hint: COPY.curveAddHint, keywords: "tube pipe wire rail path lathe spline" },
];
const ALL_ITEMS = [...SHAPES, ...LIGHTS, ...ORGANIZE];

/** A material id not in the scene. */
function mintMaterialId(scene: SceneSpec): string {
  const taken = new Set(scene.materials.map((m) => m.id));
  for (;;) {
    const id = `m_${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(id)) return id;
  }
}

/** Footprints of objects added in this session, per scene id. */
const occupiedByScene = new Map<string, Array<[number, number, number]>>();

export interface AddMenuProps {
  rest: RestFn;
  scene: SceneSpec;
  selection: SelectionStore;
  chrome?: "editor" | "pane";
  /** Show only the icon (the outliner footer uses a ghost variant). */
  variant?: "primary" | "ghost";
  /** The trigger's accessible name (default "Add"). */
  ariaLabel?: string;
}

/** `+ Add` and its popover. Sends one PATCH (one history entry). */
export function AddMenu({ rest, scene, selection, chrome = "editor", variant = "primary", ariaLabel = "Add" }: AddMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Shift+A on the editor root opens the popover (not while typing).
  useEffect(() => {
    if (variant !== "primary") return undefined;
    const root = anchorRef.current?.closest("[data-plastis-root=editor]");
    if (!root) return undefined;
    const onKey = (e: Event) => {
      const ev = e as KeyboardEvent;
      if (!(ev.shiftKey && (ev.key === "A" || ev.key === "a")) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      ev.preventDefault();
      setOpen(true);
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [variant]);

  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL_ITEMS.filter((i) => `${i.label} ${i.keywords} ${i.kind}`.toLowerCase().includes(q));
  }, [query]);

  async function add(item: AddItem): Promise<void> {
    setOpen(false);
    anchorRef.current?.focus();
    const taken = new Set(scene.nodes.map((n: NodeSpec) => n.name));
    const label = item.kind === "directional" ? "Sun" : item.kind === "point" ? "Bulb" : item.kind === "spot" ? "Spotlight" : item.label;
    const name = uniqueNodeName(label, taken);
    const occupied = occupiedByScene.get(scene.id) ?? [];
    const placement: Placement = {
      target: getLiveTarget(chrome),
      eye: getLivePosition(chrome),
      occupied,
    };
    if (item.kind === "curve") {
      const target = getLiveTarget(chrome);
      const created = await addCurve(rest, scene, name, [Math.round(target[0] * 2) / 2, 0, Math.round(target[2] * 2) / 2]);
      if (created) selection.select(created);
      return;
    }
    if (item.kind === "text") {
      const target = getLiveTarget(chrome);
      const created = await addText(rest, scene, name, [Math.round(target[0] * 2) / 2, 0, Math.round(target[2] * 2) / 2]);
      if (created) selection.select(created);
      return;
    }
    const isShape = SHAPES.some((s) => s.kind === item.kind);
    const ops: PatchOp[] = [];
    let materialId = "m_default";
    if (isShape) {
      materialId = mintMaterialId(scene);
      const color = SHAPE_COLORS[colorCursor % SHAPE_COLORS.length];
      colorCursor += 1;
      ops.push({
        op: "set_material",
        material: { ...DEFAULT_MATERIAL, id: materialId, color, roughness: 0.45 },
      });
    }
    const node = buildAddNode(item.kind as AddKind, name, placement, materialId);
    ops.push({ op: "add_node", node });
    try {
      const envelope = await patchScene(rest, scene.id, scene.revision, ops);
      const created = envelope.nodes.find((n) => n.name === name);
      if (created) selection.select(created.id);
      if (isShape) {
        const t = (node.transform as { t: number[] }).t;
        const prim = node.primitive as PrimitiveSpec;
        const local = primitiveLocalBounds(prim);
        const half = local ? Math.max(local.max[0] - local.min[0], local.max[2] - local.min[2]) / 2 : 0.5;
        occupiedByScene.set(scene.id, [...occupied, [t[0], t[2], half] as [number, number, number]].slice(-24));
      }
    } catch (err) {
      const toast = toastForCode(
        err instanceof Error && "code" in err
          ? String((err as { code: unknown }).code)
          : "SPEC_INVALID",
        {
          context: "edit",
          serverMessage: err instanceof Error ? err.message : undefined,
        },
      );
      notifyToast(toast);
    }
  }

  const group = (title: string, items: AddItem[]) => (
    <div>
      <div className="p3d-menu-label">{title}</div>
      <div className="p3d-tiles">
        {items.map((item) => (
          <Tile key={item.kind} icon={item.icon} label={item.label} hint={item.hint} onClick={() => void add(item)} />
        ))}
      </div>
    </div>
  );

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align={variant === "primary" ? "end" : "start"}
      side={variant === "primary" ? "bottom" : "top"}
      role="menu"
      label="Add"
      className="p3d-add"
      anchor={
        <button
          ref={anchorRef}
          type="button"
          className={variant === "primary" ? "p3d-btn p3d-btn--primary" : "p3d-btn p3d-btn--sm"}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          title="Add a shape, light or camera (Shift+A)"
          onClick={() => setOpen((v) => !v)}
        >
          <Icon name="plus" size={16} />
          <span className="p3d-add-label">Add</span>
        </button>
      }
    >
      <div className="p3d-add-search-wrap">
        <Icon name="search" size={16} />
        <input
          ref={searchRef}
          className="p3d-add-search"
          placeholder="Search shapes, lights…"
          aria-label="Search shapes and lights"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered && filtered.length > 0) {
              e.preventDefault();
              void add(filtered[0]);
            }
          }}
        />
      </div>
      {filtered ? (
        filtered.length > 0 ? (
          group("Results", filtered)
        ) : (
          <div className="p3d-help" style={{ padding: "12px 8px" }}>
            Nothing called “{query}”. Try box, ball, light or camera.
          </div>
        )
      ) : (
        <>
          {group("Shapes", SHAPES)}
          {group("Light & camera", LIGHTS)}
          {group("Organize", ORGANIZE)}
        </>
      )}
    </Popover>
  );
}
