import type { ClipPlayer } from "../scene/clipPlayback";
import { useEffect, useState } from "react";
import { COPY } from "../copy";
import { findClipPlayer, subscribeClipPlayers } from "../scene/clipPlayback";

/** Playback is local to this editor surface and never changes the scene. */
export function ClipTransport({ sourceKey, sceneId, nodeId, onAddKey }: { sourceKey: string; sceneId: string; nodeId: string; onAddKey?: (player: ClipPlayer) => void }) {
  const [, redraw] = useState(0);
  useEffect(() => subscribeClipPlayers(() => redraw((v) => v + 1)), []);
  const player = findClipPlayer(sourceKey, sceneId, nodeId);
  useEffect(() => player?.subscribe(() => redraw((v) => v + 1)), [player]);
  if (!player || player.clips.length === 0) return null;
  return (
    <div className="p3d-clip-transport p3d-glass" role="group" aria-label={COPY.animation} onClick={(event) => event.stopPropagation()}>
      <label>
        {COPY.clip}
        <select className="p3d-select" aria-label={COPY.animationClip} value={player.index} onChange={(event) => player.play(Number(event.target.value))}>
          {player.clips.map((clip, index) => <option key={index} value={index}>{clip.name || `${COPY.clip} ${index + 1}`}</option>)}
        </select>
      </label>
      <input aria-label={COPY.animationTime} type="range" min={0} max={player.clips[player.index].duration} step="0.01" value={player.time} onChange={(event) => player.seek(Number(event.target.value))} />
      <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => {
        if (player.playing) player.pause();
        else if (player.mixer.existingAction(player.clips[player.index])) player.resume();
        else player.play();
      }}>{player.playing ? COPY.pause : COPY.play}</button>
      <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => { player.play(); player.pause(); }}>{COPY.restart}</button>
      {onAddKey && <button type="button" className="p3d-btn p3d-btn--outline p3d-btn--sm" onClick={() => onAddKey(player)}>{COPY.animationAddKey}</button>}
    </div>
  );
}
