// src/editor/ModifiersSection.tsx — the modifier stack of a shape or part (PR25).
//
// Add, remove, reorder and enable entries and edit their settings. The size the stack would make is
// predicted as you edit (and refused over 100,000 triangles). Apply runs the stack on the BASE mesh and bakes
// the result once: the first Apply on a built-in shape first turns it into a part (so the un-modified mesh
// becomes the base asset), then bakes the result with `generator: {type: "modifiers", params: {baseAssetId,
// stack}}`. Re-applying always starts from the base, so editing a setting is non-destructive.
import { useEffect, useMemo, useState } from "react";
import { bakeMesh } from "../api";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import { encodeMesh } from "../scene/bake";
import { loadAssetMesh, meshFromPrimitive, modifierBaseSelection } from "../scene/baseMesh";
import { applyStack, defaultEntry, MAX_STACK, MODIFIER_LABELS, MODIFIER_TYPES, ModifierError, predictTriangles, validateStack } from "../scene/modifiers";
import type { ModifierEntry, ModifierGeneratorParams, ModifierType } from "../scene/modifiers";
import { countPrimitive } from "../scene/primitiveStats";
import { invalidateSceneData } from "../state/sceneQuery";
import type { NodeSpec, PrimitiveSpec, SceneSpec } from "../types";
import { Section } from "../ui/controls";
import { notifyToast, toastApiError } from "./sceneActions";

const stackOf = (node: NodeSpec): ModifierEntry[] => (node.generator?.type === "modifiers" ? structuredClone((node.generator.params as ModifierGeneratorParams).stack ?? []) : []);

function message(err: unknown): string {
  return err instanceof ModifierError ? err.message : COPY.modifiersFailed;
}

export function ModifiersSection({ node, scene, rest, sourceKey }: { node: NodeSpec; scene: SceneSpec; rest: RestFn; sourceKey?: string }) {
  const saved = useMemo(() => stackOf(node), [node.generator, node.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [stack, setStack] = useState<ModifierEntry[]>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setStack(saved), [saved, scene.revision]);
  const foreign = node.generator !== undefined && node.generator.type !== "modifiers";
  const assets = new Map(scene.assets.map((a) => [a.id, a]));
  const baseAssetId = node.generator?.type === "modifiers" ? (node.generator.params as ModifierGeneratorParams).baseAssetId : node.modelAssetId;
  const baseTris = node.kind === "mesh" ? (countPrimitive(node.primitive as PrimitiveSpec)?.tris ?? 0) : (assets.get(baseAssetId ?? "")?.stats?.tris ?? 0);
  const problem = validateStack(stack);
  const predicted = predictTriangles(baseTris, stack);
  const changed = JSON.stringify(stack) !== JSON.stringify(saved);
  const hasClips = (node.clips?.length ?? 0) > 0;

  async function apply(): Promise<void> {
    if (busy || problem) return;
    setBusy(true);
    try {
      let revision = scene.revision;
      let base = baseAssetId;
      let baseMesh;
      let baseSelection: [number, number] = [0, 0];
      if (node.kind === "mesh") {
        baseMesh = meshFromPrimitive(node.primitive as PrimitiveSpec);
        const result = applyStack(baseMesh, stack); // refuse before writing anything
        void result;
        const first = await bakeMesh(rest, scene.id, { baseRevision: revision, nodeId: node.id, mesh: encodeMesh(baseMesh) });
        revision = first.scene.revision;
        base = first.nodes.find((n) => n.id === node.id)?.modelAssetId;
      } else {
        const asset = assets.get(base ?? "");
        if (!asset) throw new Error("the base model is missing");
        const [meshIndex, primitiveIndex] = modifierBaseSelection(node, scene);
        const loaded = await loadAssetMesh(rest, asset, meshIndex, primitiveIndex);
        baseMesh = loaded.mesh;
        baseSelection = [loaded.meshIndex, loaded.primitiveIndex];
      }
      const out = applyStack(baseMesh, stack);
      await bakeMesh(rest, scene.id, { baseRevision: revision, nodeId: node.id, mesh: encodeMesh(out), generator: { type: "modifiers", version: 1, params: { baseAssetId: base, stack, baseMeshIndex: baseSelection[0], basePrimitiveIndex: baseSelection[1] } } });
      if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
    } catch (err) {
      if (err instanceof ModifierError) notifyToast({ id: "modifiersFailed", kind: "warn", message: message(err) } as never);
      else toastApiError(err, "edit");
    } finally {
      setBusy(false);
    }
  }

  const update = (i: number, fn: (e: ModifierEntry) => void) => setStack((s) => s.map((e, k) => { if (k !== i) return e; const copy = structuredClone(e); fn(copy); return copy; }));
  const move = (i: number, d: number) => setStack((s) => { const next = [...s]; const [e] = next.splice(i, 1); next.splice(i + d, 0, e); return next; });
  const number = (e: ModifierEntry, i: number, key: string, label: string, step: number) => (
    <label key={key} style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>{label}
      <input className="p3d-input" type="number" step={step} aria-label={`${MODIFIER_LABELS[e.type]} ${i + 1} ${label}`} style={{ width: 90 }} value={e.params[key] as number} onChange={(ev) => update(i, (c) => { c.params[key] = Number(ev.target.value); })} />
    </label>
  );
  const params = (e: ModifierEntry, i: number) => {
    if (e.type === "mirror") return <>
      <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>{COPY.modAxis}
        <select className="p3d-select" aria-label={`Mirror ${i + 1} ${COPY.modAxis}`} value={e.params.axis as string} onChange={(ev) => update(i, (c) => { c.params.axis = ev.target.value; })}><option>x</option><option>y</option><option>z</option></select></label>
      {number(e, i, "threshold", COPY.modThreshold, 0.001)}</>;
    if (e.type === "array") return <>{number(e, i, "count", COPY.modCount, 1)}
      {(["X", "Y", "Z"] as const).map((axis, k) => (
        <label key={axis} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>{COPY.modOffset} {axis}
          <input className="p3d-input" type="number" step={0.1} aria-label={`Array ${i + 1} ${COPY.modOffset} ${axis}`} style={{ width: 90 }} value={(e.params.offset as number[])[k]} onChange={(ev) => update(i, (c) => { (c.params.offset as number[])[k] = Number(ev.target.value); })} /></label>))}</>;
    if (e.type === "subdivide") return number(e, i, "levels", COPY.modLevels, 1);
    if (e.type === "smooth") return <>{number(e, i, "iterations", COPY.modIterations, 1)}{number(e, i, "factor", COPY.modFactor, 0.1)}</>;
    if (e.type === "decimate") return number(e, i, "ratio", COPY.modRatio, 0.05);
    return number(e, i, "angle", COPY.modAngle, 5);
  };
  const disabledReason = foreign ? COPY.modifiersForeign : hasClips ? COPY.editHasClips : null;
  return (
    <Section id="modifiers" title={COPY.modifiersTitle} icon="sparkle" defaultOpen={false} summary={stack.length ? `${stack.length}` : undefined}>
      {disabledReason ? <div className="p3d-help">{disabledReason}</div> : <>
        {stack.map((e, i) => (
          <fieldset key={i} style={{ border: "1px solid var(--p3d-border, #444)", borderRadius: 8, padding: 6, margin: "4px 0" }}>
            <legend style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input type="checkbox" aria-label={`${MODIFIER_LABELS[e.type]} ${i + 1} ${COPY.modEnabled}`} checked={e.enabled} onChange={(ev) => update(i, (c) => { c.enabled = ev.target.checked; })} />
              {MODIFIER_LABELS[e.type]}
              <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.modUp} ${MODIFIER_LABELS[e.type]} ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
              <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.modDown} ${MODIFIER_LABELS[e.type]} ${i + 1}`} disabled={i === stack.length - 1} onClick={() => move(i, 1)}>↓</button>
              <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.modRemove} ${MODIFIER_LABELS[e.type]} ${i + 1}`} onClick={() => setStack((s) => s.filter((_, k) => k !== i))}>×</button>
            </legend>
            {params(e, i)}
          </fieldset>
        ))}
        <select className="p3d-select" aria-label={COPY.modAdd} value="" disabled={stack.length >= MAX_STACK} onChange={(ev) => { const t = ev.target.value as ModifierType; if (t) setStack((s) => [...s, defaultEntry(t)]); }}>
          <option value="">{COPY.modAdd}</option>
          {MODIFIER_TYPES.map((t) => <option key={t} value={t}>{MODIFIER_LABELS[t]}</option>)}
        </select>
        <div className="p3d-help" role="status" aria-live="polite">{problem ?? (predicted > 100000 ? COPY.modTooLarge : `${baseTris.toLocaleString()} → about ${predicted.toLocaleString()} triangles`)}</div>
        <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy || problem !== null || predicted > 100000 || (!changed && stack.length === 0)} onClick={() => void apply()}>{COPY.textApply}</button>
      </>}
    </Section>
  );
}
