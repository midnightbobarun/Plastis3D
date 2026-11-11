// src/editor/SettleControl.tsx — the Settle button and its Keep/Cancel bar (PR27, D-EXT-05).
//
// Settle simulates the selected nodes falling under gravity in the browser (src/scene/physics.ts) and shows the
// result live. Nothing is saved until Keep, which writes every node's final pose as ONE PATCH (one undo entry).
// "Keep and record the fall" also adds a "Fall" clip to each settled shape (clips live on mesh nodes only).
import { useId, useRef, useState } from "react";
import type { RestFn } from "../api";
import { COPY } from "../copy";
import { PhysicsError, fallClips, settle } from "../scene/physics";
import type { SettleResult } from "../scene/physics";
import { validPrimitiveClips } from "../scene/primitiveClips";
import type { SettleStore } from "../state/settle";
import type { SceneSpec } from "../types";
import { commitPatch, toastApiError } from "./sceneActions";

type Phase = { kind: "idle" } | { kind: "running" } | { kind: "done"; result: SettleResult } | { kind: "error"; message: string };

export function SettleControl({ scene, selectedIds, rest, store, disabled }: { scene: SceneSpec; selectedIds: string[]; rest: RestFn; store: SettleStore; disabled?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cancelled = useRef(false);
  const tipId = useId();

  async function run(): Promise<void> {
    cancelled.current = false;
    setPhase({ kind: "running" });
    try {
      const result = await settle(scene, selectedIds, {
        yieldNow: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
        onFrame: (poses) => { if (!cancelled.current) store.set(poses); },
      });
      if (cancelled.current) return;
      store.set(result.poses);
      setPhase({ kind: "done", result });
    } catch (err) {
      store.set(null);
      const message = err instanceof PhysicsError ? (err.code === "PHYSICS_TOO_MANY" ? COPY.settleTooMany : err.code === "PHYSICS_NOTHING" ? COPY.settleNothing : err.message) : String(err);
      setPhase({ kind: "error", message });
    }
  }

  function cancel(): void {
    cancelled.current = true;
    const phaseNow = phase;
    if (phaseNow.kind === "done") store.set(phaseNow.result.original);
    store.set(null);
    setPhase({ kind: "idle" });
  }

  async function keep(record: boolean, result: SettleResult): Promise<void> {
    const clips = record ? fallClips(result) : new Map();
    const ops = [...result.poses].map(([id, pose]) => {
      const node = scene.nodes.find((n) => n.id === id);
      const op: Record<string, unknown> = { op: "update_node", id, transform: pose };
      const clip = clips.get(id);
      if (clip && node?.kind === "mesh") {
        const existing = node.clips ?? [];
        if (validPrimitiveClips(existing)) op.clips = [...existing, clip];
      }
      return op;
    });
    try {
      await commitPatch(rest, scene, ops as never);
      store.set(null);
      setPhase({ kind: "idle" });
    } catch (err) {
      toastApiError(err, "edit");
    }
  }

  const btn = "p3d-btn p3d-btn--sm";
  if (phase.kind === "idle" || phase.kind === "error") {
    return (
      <div role="group" aria-label={COPY.settleBar} className="p3d-glass p3d-settle p3d-settle--idle">
        <span className="p3d-settle-tip" title={selectedIds.length === 0 ? COPY.settleNeedsSelection : COPY.settleHint}>
          <button type="button" className={btn} title={selectedIds.length === 0 ? COPY.settleNeedsSelection : COPY.settleHint} aria-describedby={tipId} disabled={disabled || selectedIds.length === 0} onClick={() => void run()}>{COPY.settle}</button>
          <span id={tipId} hidden>{selectedIds.length === 0 ? COPY.settleNeedsSelection : COPY.settleHint}</span>
        </span>
        {phase.kind === "error" && <span role="alert">{phase.message}</span>}
      </div>
    );
  }
  return (
    <div role="group" aria-label={COPY.settleBar} className="p3d-glass p3d-settle">
      <span role="status" aria-live="polite">{phase.kind === "running" ? COPY.settleRunning : phase.result.rested ? COPY.settleDone : COPY.settleNoRest}</span>
      {phase.kind === "done" && <>
        <button type="button" className={btn} onClick={() => void keep(false, phase.result)}>{phase.result.rested ? COPY.settleKeep : COPY.settleKeepAnyway}</button>
        <button type="button" className={btn} onClick={() => void keep(true, phase.result)}>{COPY.settleKeepRecord}</button>
      </>}
      <button type="button" className={btn} onClick={cancel}>{COPY.settleCancel}</button>
    </div>
  );
}
