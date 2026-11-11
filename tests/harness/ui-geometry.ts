// tests/harness/ui-geometry.ts — measure the stage overlays and report overlaps and overflow (UI/UX polish W6).
//
// The same function runs in the harness (page.evaluate on the mock host) and in scripts/run-ui-live-check.mjs
// (against the real Webapp), so a layout bug that shows up in Hermes fails here too.
export const OVERLAYS: Record<string, string> = {
  dock: ".p3d-dock",
  topBar: ".p3d-stage-top",
  cube: ".p3d-viewgizmo",
  help: ".p3d-shortcut-help > button",
  checklist: ".p3d-learning",
  renderBar: ".p3d-render-bar",
  stats: ".p3d-stage-bl",
  viewButtons: ".p3d-stage-br",
  editBar: ".p3d-edit-bar",
  coach: ".p3d-coach",
  hint: ".p3d-hint",
  agentBar: ".p3d-agent-bar",
};

export interface GeometryReport {
  stage: number[];
  present: string[];
  outside: string[];
  overlaps: string[];
}

/** Evaluated inside the page. `stageSelector` picks the stage to measure. */
export function measureOverlays(arg: { stageSelector: string; overlays: Record<string, string> }): GeometryReport {
  const stage = document.querySelector(arg.stageSelector) as HTMLElement | null;
  if (!stage) throw new Error("no stage: " + arg.stageSelector);
  const sb = stage.getBoundingClientRect();
  const boxes: Array<{ name: string; r: DOMRect }> = [];
  for (const [name, selector] of Object.entries(arg.overlays)) {
    const el = stage.querySelector(selector) as HTMLElement | null;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    boxes.push({ name, r });
  }
  const outside: string[] = [];
  for (const { name, r } of boxes) {
    if (r.left < sb.left - 1 || r.top < sb.top - 1 || r.right > sb.right + 1 || r.bottom > sb.bottom + 1) {
      outside.push(`${name} [${Math.round(r.left - sb.left)},${Math.round(r.top - sb.top)} ${Math.round(r.width)}x${Math.round(r.height)}] in stage ${Math.round(sb.width)}x${Math.round(sb.height)}`);
    }
  }
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r;
      const b = boxes[j].r;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 2 && h > 2) overlaps.push(`${boxes[i].name} x ${boxes[j].name} (${Math.round(w)}x${Math.round(h)}px)`);
    }
  }
  return { stage: [Math.round(sb.width), Math.round(sb.height)], present: boxes.map((b) => b.name), outside, overlaps };
}
