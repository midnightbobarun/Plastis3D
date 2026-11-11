// src/editor/RigSection.tsx — bones and clips for a shape, part or rigged model (PR30).
//
// Bones and key rotations are numeric fields (dragging bone handles in the 3D view is follow-on R-99). Apply sends
// the un-skinned mesh and the settings; the gateway weights the mesh, writes a skinned GLB with the clips and turns
// the node into a locked model in one revision (one undo restores the shape). A rigged model keeps its un-rigged
// mesh, so opening this section again edits the bones and re-applies from that mesh.
import { useEffect, useMemo, useState } from "react";
import { makeRig } from "../api";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import { encodeMesh } from "../scene/bake";
import { meshFromAsset, meshFromPrimitive } from "../scene/baseMesh";
import { boundsOf } from "../scene/physics";
import { defaultDraft, draftFromParams, toParams, validateDraft } from "../scene/rig";
import type { Bone, DraftClip, RigDraft } from "../scene/rig";
import { invalidateSceneData } from "../state/sceneQuery";
import type { NodeSpec, PrimitiveSpec, SceneSpec, Vec3 } from "../types";
import { Section } from "../ui/controls";
import { notifyToast, toastApiError } from "./sceneActions";

export function RigSection({ node, scene, rest, sourceKey }: { node: NodeSpec; scene: SceneSpec; rest: RestFn; sourceKey?: string }) {
  const assets = useMemo(() => new Map(scene.assets.map((a) => [a.id, a])), [scene.assets]);
  const isRig = node.generator?.type === "rig";
  const saved = useMemo<RigDraft>(
    () => (isRig ? draftFromParams(node.generator?.params as never) : defaultDraft(boundsOf(node, assets))),
    [node.id, node.generator, assets, isRig], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [draft, setDraft] = useState<RigDraft>(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved), [saved, scene.revision]);
  const problem = validateDraft(draft);
  const hasClips = node.kind === "mesh" && (node.clips?.length ?? 0) > 0;
  const changed = JSON.stringify(draft) !== JSON.stringify(saved);

  async function apply(): Promise<void> {
    if (busy || problem) return;
    setBusy(true);
    try {
      let mesh;
      if (node.kind === "mesh") mesh = meshFromPrimitive(node.primitive as PrimitiveSpec);
      else {
        const baseId = isRig ? (node.generator?.params as { baseAssetId?: string }).baseAssetId : node.modelAssetId;
        const asset = assets.get(baseId ?? "");
        if (!asset) throw new Error("the un-rigged mesh is missing");
        const part = isRig ? { meshIndex: 0, primitiveIndex: 0 } : { meshIndex: node.meshIndex ?? 0, primitiveIndex: node.primitiveIndex ?? 0 };
        mesh = await meshFromAsset(rest, asset, part.meshIndex, part.primitiveIndex);
      }
      await makeRig(rest, scene.id, { baseRevision: scene.revision, id: node.id, mesh: encodeMesh(mesh), rig: toParams(draft) });
      if (sourceKey !== undefined) invalidateSceneData(sourceKey, scene.id);
      notifyToast({ id: "rigApplied", kind: "info", message: COPY.rigApplied } as never);
    } catch (err) {
      toastApiError(err, "edit");
    } finally {
      setBusy(false);
    }
  }

  const setBone = (i: number, fn: (b: Bone) => void) => setDraft((d) => ({ ...d, bones: d.bones.map((b, k) => { if (k !== i) return b; const c = structuredClone(b); fn(c); return c; }) }));
  const addBone = () => setDraft((d) => {
    const last = d.bones[d.bones.length - 1];
    let n = d.bones.length + 1;
    while (d.bones.some((b) => b.id === `bone${n}`)) n++;
    const head: Vec3 = last ? [...last.tail] as Vec3 : [0, 0, 0];
    return { ...d, bones: [...d.bones, { id: `bone${n}`, name: `Bone ${n}`, parent: last?.id ?? null, head, tail: [head[0], head[1] + 0.5, head[2]] }] };
  });
  const removeBone = (id: string) => setDraft((d) => ({
    bones: d.bones.filter((b) => b.id !== id).map((b) => (b.parent === id ? { ...b, parent: d.bones.find((x) => x.id === id)?.parent ?? null } : b)),
    clips: d.clips.map((c) => ({ ...c, keys: c.keys.filter((k) => k.boneId !== id) })).filter((c) => c.keys.length > 0),
  }));
  const setClip = (c: number, fn: (clip: DraftClip) => void) => setDraft((d) => ({ ...d, clips: d.clips.map((clip, k) => { if (k !== c) return clip; const copy = structuredClone(clip); fn(copy); return copy; }) }));
  const vec = (label: string, value: Vec3, set: (v: Vec3) => void, step = 0.1) => (
    <span style={{ display: "inline-flex", gap: 2 }}>
      {(["X", "Y", "Z"] as const).map((axis, k) => (
        <input key={axis} className="p3d-input" type="number" step={step} aria-label={`${label} ${axis}`} style={{ width: 56 }} value={value[k]} onChange={(e) => { const next = [...value] as Vec3; next[k] = Number(e.target.value); set(next); }} />
      ))}
    </span>
  );

  return (
    <Section id="rig" title={COPY.rigTitle} icon="scale" defaultOpen={false} summary={isRig ? `${draft.bones.length}` : undefined}>
      {hasClips ? <div className="p3d-help">{COPY.rigNeedsClips}</div> : <>
        <div className="p3d-help">{COPY.rigHint}</div>
        <div role="group" aria-label={COPY.rigBones}>
          {draft.bones.map((b, i) => (
            <fieldset key={b.id} style={{ border: "1px solid var(--p3d-border, #444)", borderRadius: 8, padding: 6, margin: "4px 0" }}>
              <legend style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <input className="p3d-input" aria-label={`${COPY.rigName} ${i + 1}`} style={{ width: 90 }} value={b.name} maxLength={64} onChange={(e) => setBone(i, (c) => { c.name = e.target.value; })} />
                <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.rigRemoveBone} ${i + 1}`} disabled={draft.bones.length <= 1} onClick={() => removeBone(b.id)}>×</button>
              </legend>
              <label style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>{COPY.rigParent}
                <select className="p3d-select" aria-label={`${COPY.rigParent} ${i + 1}`} value={b.parent ?? ""} onChange={(e) => setBone(i, (c) => { c.parent = e.target.value || null; })}>
                  <option value="">{COPY.rigNoParent}</option>
                  {draft.bones.filter((o) => o.id !== b.id).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </label>
              <div>Head {vec(`Bone ${i + 1} head`, b.head, (v) => setBone(i, (c) => { c.head = v; }))}</div>
              <div>Tail {vec(`Bone ${i + 1} tail`, b.tail, (v) => setBone(i, (c) => { c.tail = v; }))}</div>
            </fieldset>
          ))}
          <button type="button" className="p3d-btn p3d-btn--sm" disabled={draft.bones.length >= 64} onClick={addBone}>{COPY.rigAddBone}</button>
        </div>
        <div role="group" aria-label={COPY.rigClips}>
          {draft.clips.map((clip, c) => (
            <fieldset key={c} style={{ border: "1px solid var(--p3d-border, #444)", borderRadius: 8, padding: 6, margin: "4px 0" }}>
              <legend><input className="p3d-input" aria-label={`Clip ${c + 1} name`} style={{ width: 110 }} value={clip.name} maxLength={64} onChange={(e) => setClip(c, (x) => { x.name = e.target.value; })} />
                <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`Remove clip ${c + 1}`} onClick={() => setDraft((d) => ({ ...d, clips: d.clips.filter((_, k) => k !== c) }))}>×</button></legend>
              {clip.keys.map((k, i) => (
                <div key={i} style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                  <input className="p3d-input" type="number" step={0.1} min={0} aria-label={`Clip ${c + 1} key ${i + 1} time`} style={{ width: 56 }} value={k.t} onChange={(e) => setClip(c, (x) => { x.keys[i].t = Number(e.target.value); })} />
                  <select className="p3d-select" aria-label={`Clip ${c + 1} key ${i + 1} bone`} value={k.boneId} onChange={(e) => setClip(c, (x) => { x.keys[i].boneId = e.target.value; })}>
                    {draft.bones.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  {vec(`Clip ${c + 1} key ${i + 1} rotation`, k.rotation, (v) => setClip(c, (x) => { x.keys[i].rotation = v; }), 5)}
                  <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.rigRemoveKey} ${i + 1}`} disabled={clip.keys.length <= 1} onClick={() => setClip(c, (x) => { x.keys.splice(i, 1); })}>×</button>
                </div>
              ))}
              <button type="button" className="p3d-btn p3d-btn--sm" aria-label={`${COPY.rigAddKey} to clip ${c + 1}`} onClick={() => setClip(c, (x) => { const last = x.keys[x.keys.length - 1]; x.keys.push({ t: (last?.t ?? 0) + 1, boneId: last?.boneId ?? draft.bones[0].id, rotation: [0, 0, 0] }); })}>{COPY.rigAddKey}</button>
            </fieldset>
          ))}
          <button type="button" className="p3d-btn p3d-btn--sm" disabled={draft.clips.length >= 16} onClick={() => setDraft((d) => ({ ...d, clips: [...d.clips, { name: `Clip ${d.clips.length + 1}`, keys: [{ t: 0, boneId: d.bones[0].id, rotation: [0, 0, 0] }] }] }))}>{COPY.rigAddClip}</button>
        </div>
        <div className="p3d-help" role="status" aria-live="polite">{problem ?? ""}</div>
        <button type="button" className="p3d-btn p3d-btn--sm" disabled={busy || problem !== null || (isRig && !changed)} onClick={() => void apply()}>{COPY.rigApply}</button>
      </>}
    </Section>
  );
}
