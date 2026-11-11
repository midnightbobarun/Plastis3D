// PR32 (UI/UX redesign): the pure pieces behind the new chrome —
// placement on the floor (§5.7), material presets (§7.4), the scene
// tile hue and relative time (§6.3), counts, and the frame-time guard.
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  aimRotation,
  buildAddNode,
  floorY,
  uniqueNodeName,
} from "../../src/scene/placement";
import {
  MATERIAL_PRESETS,
  PALETTE,
  matchingPreset,
  paletteName,
  presetFields,
} from "../../src/ui/materials";
import { formatCount, relativeTime, sceneHue } from "../../src/ui/format";
import { FrameTimeGuard, easeInOut } from "../../src/viewport/stage";
import type { MaterialSpec, PrimitiveSpec } from "../../src/types";

const t = (node: Record<string, unknown>) => (node.transform as { t: number[]; r: number[] });

describe("placement (§5.7)", () => {
  it("puts a default box's bottom on the floor", () => {
    expect(floorY({ type: "box", width: 1, height: 1, depth: 1 } as PrimitiveSpec, [0, 0, 0])).toBeCloseTo(0.5);
  });
  it("puts a torus (a standing ring) on the floor", () => {
    expect(floorY({ type: "torus", radius: 0.5, tube: 0.15 } as PrimitiveSpec, [0, 0, 0])).toBeCloseTo(0.65);
  });
  it("creates planes flat, at floor height", () => {
    const node = buildAddNode("plane", "Plane");
    expect(t(node).r).toEqual([-90, 0, 0]);
    expect(t(node).t[1]).toBeCloseTo(0);
  });
  it("drops at the orbit target snapped to 0.5 m", () => {
    const node = buildAddNode("box", "Box", { target: [2.3, 1, -0.8], eye: [5, 5, 5], occupied: [] });
    expect(t(node).t).toEqual([2.5, 0.5, -1]);
  });
  it("steps along +X instead of landing inside a recent object", () => {
    const node = buildAddNode("box", "Box", { target: [0, 0, 0], eye: [5, 5, 5], occupied: [[0, 0, 0.5]] });
    expect(t(node).t[0]).toBeGreaterThanOrEqual(1);
  });
  it("aims a new sun at the target", () => {
    const node = buildAddNode("directional", "Sun", { target: [0, 0, 0], eye: [5, 5, 5], occupied: [] });
    const r = t(node).r;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...r.map((d) => (d * Math.PI) / 180) as [number, number, number], "XYZ"));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const toTarget = new THREE.Vector3(...(t(node).t as [number, number, number])).negate().normalize();
    expect(forward.dot(toTarget)).toBeGreaterThan(0.999);
  });
  it("aimRotation points -Z from eye to target", () => {
    const r = aimRotation(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, 0));
    expect(r.map((v) => Math.round(v) + 0)).toEqual([0, 0, 0]);
  });
  it("names collide into Box 2, Box 3", () => {
    expect(uniqueNodeName("Box", new Set(["Box", "Box 2"]))).toBe("Box 3");
  });
});

describe("material presets (§7.4)", () => {
  const base: MaterialSpec = {
    id: "m",
    color: "#e0483e",
    emissive: "#000000",
    metalness: 0,
    roughness: 0.6,
    opacity: 1,
    doubleSide: false,
  };
  it("keeps the colour except Gold and Glass", () => {
    const glossy = MATERIAL_PRESETS.find((p) => p.id === "glossy")!;
    expect(presetFields(glossy, base).color).toBe("#e0483e");
    const gold = MATERIAL_PRESETS.find((p) => p.id === "gold")!;
    expect(presetFields(gold, base).color).toBe("#d4a83f");
  });
  it("Glow makes the emissive the colour itself", () => {
    const glow = MATERIAL_PRESETS.find((p) => p.id === "glow")!;
    expect(presetFields(glow, base).emissive).toBe("#e0483e");
  });
  it("recognises the default material as Clay, and a custom mix as none", () => {
    expect(matchingPreset(base)?.id).toBe("clay");
    expect(matchingPreset({ ...base, roughness: 0.71 })).toBeNull();
  });
  it("has 16 named palette colours", () => {
    expect(PALETTE).toHaveLength(16);
    expect(paletteName("#E0483E")).toBe("Tomato");
  });
});

describe("format", () => {
  it("relative time", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    expect(relativeTime("2026-11-09T11:59:40Z", now)).toBe("Edited just now");
    expect(relativeTime("2026-11-09T11:55:00Z", now)).toBe("Edited 5 min ago");
    expect(relativeTime("2026-11-09T09:00:00Z", now)).toBe("Edited 3 h ago");
    expect(relativeTime("2026-11-08T11:00:00Z", now)).toBe("Edited yesterday");
    expect(relativeTime("nonsense", now)).toBe("");
  });
  it("scene hue is stable and from the theme hues", () => {
    expect(sceneHue("snowman")).toBe(sceneHue("snowman"));
    expect(sceneHue("snowman")).toMatch(/^var\(--ui-/);
  });
  it("counts", () => {
    expect(formatCount(976)).toBe("976");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(25300)).toBe("25k");
    expect(formatCount(1_250_000)).toBe("1.3M");
  });
});

describe("stage helpers", () => {
  it("the frame-time guard trips once on a slow median, never on stalls", () => {
    const guard = new FrameTimeGuard(10, 33);
    let now = 0;
    let tripped = 0;
    for (let i = 0; i < 30; i += 1) {
      now += 50;
      if (guard.tick(now)) tripped += 1;
    }
    expect(tripped).toBeGreaterThanOrEqual(1);
    const calm = new FrameTimeGuard(10, 33);
    now = 0;
    let calmTrips = 0;
    for (let i = 0; i < 30; i += 1) {
      now += i % 5 === 0 ? 1000 : 16; // stalls are ignored
      if (calm.tick(now)) calmTrips += 1;
    }
    expect(calmTrips).toBe(0);
  });
  it("easeInOut is 0 → 1, symmetric", () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
  });
});
