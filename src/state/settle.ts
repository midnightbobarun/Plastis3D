// src/state/settle.ts — the Settle preview (PR27): poses the Viewport shows on the built objects while a
// simulation runs or waits for Keep/Cancel. Nothing is written to the scene until Keep.
import type { LocalPose } from "../scene/physics";

export interface SettleStore {
  getPoses(): ReadonlyMap<string, LocalPose> | null;
  set(poses: ReadonlyMap<string, LocalPose> | null): void;
  subscribe(fn: () => void): () => void;
}

export function createSettleStore(): SettleStore {
  let poses: ReadonlyMap<string, LocalPose> | null = null;
  const listeners = new Set<() => void>();
  return {
    getPoses: () => poses,
    set(next) { poses = next; for (const fn of [...listeners]) fn(); },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
