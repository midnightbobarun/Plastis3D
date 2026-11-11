import * as THREE from "three";

/** GLTFLoader targets unnamed nodes by UUID. Clone only clips that need
 * rebinding, keeping cache-owned clips immutable and interpolation intact. */
export function clipsForClone(source: THREE.Object3D, clone: THREE.Object3D, clips: THREE.AnimationClip[]): THREE.AnimationClip[] {
  const ids = new Map<string, string>();
  const visit = (original: THREE.Object3D, instance: THREE.Object3D) => {
    ids.set(original.uuid, instance.uuid);
    original.children.forEach((child, index) => visit(child, instance.children[index]));
  };
  visit(source, clone);
  return clips.map((clip) => {
    const replacements = clip.tracks.map((track) => {
      const dot = track.name.indexOf(".");
      const replacement = dot < 0 ? undefined : ids.get(track.name.slice(0, dot));
      return replacement === undefined ? track.name : replacement + track.name.slice(dot);
    });
    if (replacements.every((name, index) => name === clip.tracks[index].name)) return clip;
    const result = clip.clone();
    result.tracks.forEach((track, index) => { track.name = replacements[index]; });
    return result;
  });
}

/** A view-owned player; neither clips nor the cached template are mutated. */
export class ClipPlayer {
  readonly mixer: THREE.AnimationMixer;
  readonly clips: THREE.AnimationClip[];
  playing = false;
  index = 0;
  private listeners = new Set<() => void>();
  private nextNotification = 0;
  constructor(readonly root: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.clips = clips;
    this.mixer = new THREE.AnimationMixer(root);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  play(index = this.index) {
    if (!this.clips[index]) return;
    this.mixer.stopAllAction();
    this.index = index;
    this.mixer.clipAction(this.clips[index]).reset().play();
    this.playing = true;
    this.notify();
  }
  pause() { this.playing = false; this.notify(); }
  resume() { this.playing = true; this.notify(); }
  get time() { return this.mixer.existingAction(this.clips[this.index])?.time ?? 0; }
  seek(time: number) {
    const wasPlaying = this.playing;
    if (!this.mixer.existingAction(this.clips[this.index])) this.play();
    this.mixer.setTime(Math.max(0, Math.min(time, this.clips[this.index].duration)));
    this.playing = wasPlaying;
    this.notify();
  }
  update(delta: number) {
    if (!this.playing) return;
    this.mixer.update(delta);
    this.nextNotification += delta;
    if (this.nextNotification >= 0.1) { this.nextNotification = 0; this.notify(); }
  }
  dispose() { this.playing = false; this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.root); this.notify(); this.listeners.clear(); }
}

// Only editor surfaces publish players. Registration is removed before the
// surface releases its template lease, including renderer lease loss.
const players = new Map<string, ClipPlayer>();
const listeners = new Set<() => void>();
const key = (source: string, scene: string, node: string) => JSON.stringify([source, scene, node]);
export function findClipPlayer(source: string, scene: string, node: string) { return players.get(key(source, scene, node)); }
export function subscribeClipPlayers(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function registerClipPlayer(source: string, scene: string, node: string, player: ClipPlayer) {
  const id = key(source, scene, node);
  players.set(id, player);
  for (const listener of listeners) listener();
  return () => {
    if (players.get(id) === player) { players.delete(id); for (const listener of listeners) listener(); }
    player.dispose();
  };
}
