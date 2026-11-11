// src/editor/UvSection.tsx — UV editing: unwrap, pack, repair and island handles on a 2D canvas (PR26).
//
// The canvas is plain 2D (no WebGL, so no renderer lease). Unwrap cuts the mesh into charts along its seams
// (existing cuts, open edges, and optionally edges sharper than the angle), flattens each by LSCM and packs
// them into [0,1]. Pack, Repair and the island Move / Rotate / Scale work on the result in memory; Apply bakes
// it once (the mesh's vertices are split along the chart borders and carry TEXCOORD_0). Nothing is saved until
// Apply, and there is no generator: unwrap settings are not worth storing.
import { useEffect, useRef, useState } from "react";
import { bakeMesh } from "../api";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import { encodeMesh } from "../scene/bake";
import { meshFromAsset, meshFromPrimitive } from "../scene/baseMesh";
import type { EditMesh } from "../scene/meshEdit";
import { DEFAULT_SEAM_ANGLE, packResult, repairResult, transformIsland, unwrap, UvError } from "../scene/uv/unwrap";
import type { UnwrapResult } from "../scene/uv/unwrap";
import { invalidateSceneData } from "../state/sceneQuery";
import type { NodeSpec, PrimitiveSpec, SceneSpec } from "../types";
import { Section } from "../ui/controls";
import { notifyToast, toastApiError } from "./sceneActions";

const SIZE = 220;
const COLORS = ["#4a90ff", "#ff8a1f", "#3ec28f", "#d65db1", "#f2c94c", "#56ccf2", "#eb5757", "#9b8afb"];
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function say(message: string): void {
  notifyToast({ id: "uvMessage", kind: "info", message } as never);
}

export function UvSection({ node, scene, rest, sourceKey }: { node: NodeSpec; scene: SceneSpec; rest: RestFn; sourceKey?: string }) {
  const [source, setSource] = useState<EditMesh | null>(null);
  const [result, setResult] = useState<UnwrapResult | null>(null);
  const [selected, setSelected] = useState(0);
  const [autoSeams, setAutoSeams] = useState(true);
  const [angle, setAngle] = useState(DEFAULT_SEAM_ANGLE);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => { setSource(null); setResult(null); setNote(null); }, [node.id, scene.revision]);

  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.strokeStyle = "#888"; ctx.strokeRect(0.5, 0.5, SIZE - 1, SIZE - 1);
    if (!result) return;
    const { mesh, islandOfTriangle } = result;
    const uv = mesh.uvs as Float32Array;
    for (let f = 0; f < islandOfTriangle.length; f++) {
      const island = islandOfTriangle[f];
      ctx.strokeStyle = COLORS[island % COLORS.length];
      ctx.fillStyle = island === selected ? `${COLORS[island % COLORS.length]}55` : "transparent";
      ctx.beginPath();
      for (let k = 0; k < 3; k++) { const v = mesh.indices[f * 3 + k]; const x = uv[v * 2] * SIZE, y = (1 - uv[v * 2 + 1]) * SIZE; if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }, [result, selected]);

  async function load(): Promise<EditMesh> {
    if (source) return source;
    let mesh: EditMesh;
    if (node.kind === "mesh") mesh = meshFromPrimitive(node.primitive as PrimitiveSpec);
    else {
      const asset = scene.assets.find((a) => a.id === node.modelAssetId);
      if (!asset) throw new Error("the model is missing");
      mesh = await meshFromAsset(rest, asset, node.meshIndex ?? 0, node.primitiveIndex ?? 0);
    }
    setSource(mesh);
    return mesh;
  }

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true); setNote(null);
    try { await work(); } catch (err) {
      if (err instanceof UvError) setNote(err.message); else toastApiError(err, "edit");
    } finally { setBusy(false); }
  }
  const doUnwrap = () => run(async () => { const mesh = await load(); const out = await unwrap(mesh, { autoSeams, angle }, nextFrame); setResult(out); setSelected(0); setNote(`${out.islands} island${out.islands === 1 ? "" : "s"}`); });
  const doPack = () => run(async () => { if (result) setResult(packResult(result)); });
  const doRepair = () => run(async () => {
    if (!result) return;
    const out = await repairResult(result, await load(), { autoSeams, angle });
    setResult(out.result);
    setNote(out.report.mirrored.length || out.report.bad.length || out.report.normalised ? `Repaired: ${out.report.mirrored.length} mirrored, ${out.report.bad.length} redone${out.report.normalised ? ", values brought into range" : ""}.` : COPY.uvNothingToRepair);
  });
  const doApply = () => run(async () => {
    if (!result) return;
    const wasPrimitive = node.kind === "mesh";
    await bakeMesh(rest, scene.id, { baseRevision: scene.revision, nodeId: node.id, mesh: encodeMesh(result.mesh) });
    if (wasPrimitive) say(COPY.editBecamePart);
    if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
  });
  const island = (op: Parameters<typeof transformIsland>[2]) => { if (result) setResult(transformIsland(result, selected, op)); };
  const pick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width, v = 1 - (event.clientY - rect.top) / rect.height;
    const uv = result.mesh.uvs as Float32Array;
    for (let f = 0; f < result.islandOfTriangle.length; f++) {
      const [a, b, c] = [0, 1, 2].map((k) => result.mesh.indices[f * 3 + k]);
      const d = (x1: number, y1: number, x2: number, y2: number) => (u - x2) * (y1 - y2) - (x1 - x2) * (v - y2);
      const d1 = d(uv[a * 2], uv[a * 2 + 1], uv[b * 2], uv[b * 2 + 1]), d2 = d(uv[b * 2], uv[b * 2 + 1], uv[c * 2], uv[c * 2 + 1]), d3 = d(uv[c * 2], uv[c * 2 + 1], uv[a * 2], uv[a * 2 + 1]);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) { setSelected(result.islandOfTriangle[f]); return; }
    }
  };
  const off = node.generator !== undefined ? COPY.uvForeign : (node.clips?.length ?? 0) > 0 ? COPY.editHasClips : null;
  const btn = "p3d-btn p3d-btn--sm";
  return (
    <Section id="uv" title={COPY.uvTitle} icon="grid" defaultOpen={false} summary={result ? `${result.islands}` : undefined}>
      {off ? <div className="p3d-help">{off}</div> : <>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" aria-label={COPY.uvAutoSeams} checked={autoSeams} onChange={(e) => setAutoSeams(e.target.checked)} />{COPY.uvAutoSeams}
          <input className="p3d-input" type="number" aria-label={COPY.uvAngle} value={angle} min={1} max={180} style={{ width: 70 }} onChange={(e) => setAngle(Number(e.target.value))} disabled={!autoSeams} />
        </label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className={btn} disabled={busy} onClick={() => void doUnwrap()}>{COPY.uvUnwrap}</button>
          <button type="button" className={btn} disabled={busy || !result} onClick={() => void doPack()}>{COPY.uvPack}</button>
          <button type="button" className={btn} disabled={busy || !result} onClick={() => void doRepair()}>{COPY.uvRepair}</button>
        </div>
        <canvas ref={canvas} width={SIZE} height={SIZE} role="img" aria-label={COPY.uvCanvas} data-testid="uv-canvas" onClick={pick} style={{ width: SIZE, height: SIZE, cursor: result ? "pointer" : "default" }} />
        {result && <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }} role="group" aria-label={COPY.uvIsland}>
          <button type="button" className={btn} aria-label="Island left" onClick={() => island({ move: [-0.02, 0] })}>←</button>
          <button type="button" className={btn} aria-label="Island right" onClick={() => island({ move: [0.02, 0] })}>→</button>
          <button type="button" className={btn} aria-label="Island up" onClick={() => island({ move: [0, 0.02] })}>↑</button>
          <button type="button" className={btn} aria-label="Island down" onClick={() => island({ move: [0, -0.02] })}>↓</button>
          <button type="button" className={btn} aria-label="Rotate island" onClick={() => island({ rotate: 1 })}>⟳</button>
          <button type="button" className={btn} aria-label="Island bigger" onClick={() => island({ scale: 1.1 })}>+</button>
          <button type="button" className={btn} aria-label="Island smaller" onClick={() => island({ scale: 1 / 1.1 })}>−</button>
        </div>}
        {note && <div className="p3d-help" role="status">{note}</div>}
        <button type="button" className={btn} disabled={busy || !result} onClick={() => void doApply()}>{COPY.textApply}</button>
      </>}
    </Section>
  );
}
