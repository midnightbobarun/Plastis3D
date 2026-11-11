import { validPrimitiveClips } from "../scene/primitiveClips";
import { useState } from "react";
import { COPY } from "../copy";
import type { RestFn } from "../api";
import type { Clip, ClipChannelTarget, NodeSpec, SceneSpec, Vec3 } from "../types";
import { ScrubField, Section } from "../ui/controls";
import { updateNodeFields, toastApiError } from "./sceneActions";

/** A compact key list; every edit commits one revision. */
export function ClipKeys({ node, scene, rest }: { node: NodeSpec; scene: SceneSpec; rest: RestFn }) {
  const [selected, setSelected] = useState(0);
  const clips = node.clips ?? [];
  const invalid = !validPrimitiveClips(clips);
  const selectedIndex = Math.min(selected, Math.max(0, clips.length - 1));
  const clip = invalid ? undefined : clips[selectedIndex];
  const save = (next: Clip[]) => updateNodeFields(rest, scene, node.id, { clips: next }).then(() => {});
  const edit = (fn: (copy: Clip) => void) => {
    const next = structuredClone(clips);
    fn(next[selectedIndex]);
    return save(next);
  };
  const capture = (target: ClipChannelTarget): Vec3 => [...node.transform[target === "translation" ? "t" : target === "rotation" ? "r" : "s"]] as Vec3;
  return <Section id="keys" title={COPY.animationKeys} icon="rotate">
    {invalid ? <p>{COPY.animationInvalid}</p> : clip ? <>
      <select className="p3d-select" aria-label={COPY.animationClip} value={selectedIndex} onChange={(e) => setSelected(Number(e.target.value))}>
        {clips.map((item, i) => <option key={i} value={i}>{item.name || `${COPY.clip} ${i + 1}`}</option>)}
      </select>
      <ScrubField onError={(error) => toastApiError(error, "edit")} ariaLabel={COPY.animationDuration} value={clip.duration ?? Math.max(...clip.channels.flatMap((channel) => channel.times), 0.01)} min={0.01} step={0.1} onCommit={(value) => edit((next) => { next.duration = value; })} />
      {clip.channels.map((channel, channelIndex) => <div key={channel.target}>
        <strong>{channel.target === "translation" ? COPY.animationPosition : channel.target === "rotation" ? COPY.animationRotation : COPY.animationScale}</strong>
        {channel.times.map((time, keyIndex) => <div key={keyIndex}>
          <ScrubField onError={(error) => toastApiError(error, "edit")} ariaLabel={`${COPY.animationTime} ${keyIndex + 1}`} value={time} min={0} step={0.1} onCommit={(value) => edit((next) => { next.channels[channelIndex].times[keyIndex] = value; })} />
          {channel.values[keyIndex].map((value, axis) => <ScrubField key={axis} ariaLabel={`${channel.target === "translation" ? COPY.animationPosition : channel.target === "rotation" ? COPY.animationRotation : COPY.animationScale} ${keyIndex + 1} ${"XYZ"[axis]}`} value={value} step={0.1} onCommit={(v) => edit((next) => { next.channels[channelIndex].values[keyIndex][axis] = v; })} />)}
          {channel.times.length > 1 && <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => void edit((next) => { next.channels[channelIndex].times.splice(keyIndex, 1); next.channels[channelIndex].values.splice(keyIndex, 1); }).catch(toastApiError)}>{COPY.animationRemoveKey}</button>}
        </div>)}
        <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => void edit((next) => { const c = next.channels[channelIndex]; const t = (c.times.at(-1) ?? 0) + 1; c.times.push(t); c.values.push(capture(c.target)); next.duration = Math.max(next.duration ?? 0, t); }).catch(toastApiError)}>{COPY.animationAddKey}</button>
      </div>)}
      {(["translation", "rotation", "scale"] as const).filter((target) => !clip.channels.some((channel) => channel.target === target)).map((target) => <button key={target} type="button" onClick={() => void edit((next) => { next.channels.push({ target, times: [0], values: [capture(target)] }); }).catch(toastApiError)}>{COPY.animationAddChannel} {target === "translation" ? COPY.animationPosition : target === "rotation" ? COPY.animationRotation : COPY.animationScale}</button>)}
      <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => { const next = clips.filter((_, i) => i !== selectedIndex); setSelected(0); void save(next).catch(toastApiError); }}>{COPY.animationDeleteClip}</button>
    </> : null}
    {!invalid && <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => { const next = [...clips, { name: `${COPY.clip} ${clips.length + 1}`, duration: 1, channels: [{ target: "translation" as const, times: [0], values: [capture("translation")] }] }]; setSelected(next.length - 1); void save(next).catch(toastApiError); }}>{COPY.animationCreateClip}</button>}
  </Section>;
}
