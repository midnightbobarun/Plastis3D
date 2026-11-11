// src/editor/CurveSection.tsx — the Curve settings of a curve part, and "Add > Curve" (PR28).
//
// The gateway samples the spline and writes the mesh (Python, so the agent can do the same through
// plastis3d_curve). Here the points are numeric fields; Apply sends one request, which regenerates the asset in
// one revision (one undo restores the old shape). Dragging points in the 3D view is a follow-on (R-95).
import { useEffect, useState } from "react";
import { makeCurve } from "../api";
import type { CurveParams, RestFn } from "../api";
import { COPY } from "../copy";
import { invalidateSceneData } from "../state/sceneQuery";
import type { NodeSpec, SceneSpec } from "../types";
import { Section } from "../ui/controls";
import { toastApiError } from "./sceneActions";

export const DEFAULT_CURVE: CurveParams = {
  kind: "tube",
  points: [[-1, 0, 0], [-0.4, 0.8, 0.2], [0.4, 0.8, -0.2], [1, 0, 0]],
  closed: false,
  interpolation: "centripetal",
  radius: 0.08,
  radialSegments: 12,
  tubularSegments: 64,
};

/** Add > Curve: a new tube part at `position`. Returns the new node's id, or null on failure. */
export async function addCurve(rest: RestFn, scene: SceneSpec, name: string, position: [number, number, number], sourceKey?: string): Promise<string | null> {
  try {
    const envelope = await makeCurve(rest, scene.id, { baseRevision: scene.revision, name, curve: DEFAULT_CURVE, transform: { t: position, r: [0, 0, 0], s: [1, 1, 1] } });
    if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
    return envelope.nodes.find((n) => n.name === name && n.generator?.type === "curve")?.id ?? null;
  } catch (err) {
    toastApiError(err, "edit");
    return null;
  }
}

export function CurveSection({ node, scene, rest, sourceKey }: { node: NodeSpec; scene: SceneSpec; rest: RestFn; sourceKey?: string }) {
  const saved = node.generator?.params as unknown as CurveParams;
  const [draft, setDraft] = useState<CurveParams>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(node.generator?.params as unknown as CurveParams), [node.id, scene.revision, node.generator]);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);
  const tube = draft.kind === "tube";

  async function apply(): Promise<void> {
    if (busy || !changed) return;
    setBusy(true);
    try {
      await makeCurve(rest, scene.id, { baseRevision: scene.revision, id: node.id, curve: draft });
      if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
    } catch (err) {
      toastApiError(err, "edit");
    } finally {
      setBusy(false);
    }
  }
  const set = <K extends keyof CurveParams>(key: K, value: CurveParams[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const num = (label: string, key: "radius" | "radialSegments" | "tubularSegments" | "segments" | "angle", step: number) => (
    <label key={key} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>{label}
      <input className="p3d-input" type="number" step={step} aria-label={label} style={{ width: 90 }} value={draft[key] ?? 0} onChange={(e) => set(key, Number(e.target.value))} />
    </label>
  );
  return (
    <Section id="curve" title={COPY.curveTitle} icon="move" defaultOpen={false} summary={changed ? COPY.textUnapplied : `${draft.points.length}`}>
      <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>{COPY.curveKind}
        <select className="p3d-select" aria-label={COPY.curveKind} value={draft.kind} onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as CurveParams["kind"], closed: false }))}>
          <option value="tube">{COPY.curveTube}</option><option value="lathe">{COPY.curveLathe}</option>
        </select></label>
      {tube && <label style={{ display: "flex", gap: 8 }}><input type="checkbox" aria-label={COPY.curveClosed} checked={draft.closed} onChange={(e) => set("closed", e.target.checked)} />{COPY.curveClosed}</label>}
      {tube ? <>{num(COPY.curveRadius, "radius", 0.01)}{num(COPY.curveRadial, "radialSegments", 1)}{num(COPY.curveTubular, "tubularSegments", 4)}</> : <>{num(COPY.curveSegments, "segments", 1)}{num(COPY.curveAngle, "angle", 10)}</>}
      <div role="group" aria-label={COPY.curvePoints}>
        {draft.points.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ width: 18 }}>{i + 1}</span>
            {(["X", "Y", "Z"] as const).map((axis, k) => (
              <input key={axis} className="p3d-input" type="number" step={0.1} aria-label={`Point ${i + 1} ${axis}`} style={{ width: 62 }} value={p[k]} onChange={(e) => setDraft((d) => ({ ...d, points: d.points.map((q, j) => (j === i ? q.map((c, m) => (m === k ? Number(e.target.value) : c)) : q)) }))} />
            ))}
            <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.curveRemovePoint} ${i + 1}`} disabled={draft.points.length <= 2} onClick={() => setDraft((d) => ({ ...d, points: d.points.filter((_, j) => j !== i) }))}>×</button>
          </div>
        ))}
        <button type="button" className="p3d-btn p3d-btn--sm" disabled={draft.points.length >= 256} onClick={() => setDraft((d) => { const last = d.points[d.points.length - 1]; const before = d.points[d.points.length - 2] ?? last; return { ...d, points: [...d.points, last.map((c, k) => c + (c - before[k]) || c + 0.5)] }; })}>{COPY.curveAddPoint}</button>
      </div>
      <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy || !changed} onClick={() => void apply()}>{COPY.textApply}</button>
    </Section>
  );
}
