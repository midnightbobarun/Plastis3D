// src/editor/pendingDialog.ts — one-shot pending dialog (Stage 5, PR5;
// invoker + subscription added by the 0-C re-plan, D-REPLAN-03/04/05).
//
// New and Import need an SDK Dialog that lives in Editor.tsx. The
// palette and the Scenes pane can run when that component is not
// mounted, so the intent is held here as a one-shot module value — not
// a ctx.storage key (a stored flag would reopen the dialog on the next
// launch). Editor.tsx takes it on mount (and on focus events) and
// opens the matching dialog only when its sourceKey and epoch still
// match the active backend; a stale pending action is discarded.
//
// The payload also carries the invoking control (D-REPLAN-04): when
// the dialog closes, focus returns to it. takePendingDialog() still
// drops the value at take; the Editor transfers the invoker into its
// dialog-invoker ref at take time (D-REPLAN-05), so the closer — which
// runs after the take — still has it.
//
// 0-A: a subscription (D-REPLAN-03's E-01 fix). A same-route
// host.navigate("/plastis3d") fires no mount/focus/visibilitychange/
// popstate event, so the Editor subscribes and takes the pending
// dialog at set time, while it is already mounted.

export type PendingDialog =
  | {
      kind: "new" | "samples";
      sourceKey: string;
      epoch: number;
      /** The control that opened the dialog (null from the palette). */
      invoker: HTMLElement | null;
    }
  | {
      kind: "import";
      sceneId: string;
      sourceKey: string;
      epoch: number;
      /** The control that opened the dialog (null from the palette). */
      invoker: HTMLElement | null;
      /** A model file dropped on the editor: the dialog imports it straight away. */
      file?: File;
    };

let pending: PendingDialog | null = null;

const listeners = new Set<() => void>();

/** Subscribe to pending-dialog sets (the Editor's take path). */
export function subscribePendingDialog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record a dialog intent (palette command, Scenes pane, picker menu). */
export function setPendingDialog(dialog: PendingDialog): void {
  pending = dialog;
  for (const fn of [...listeners]) fn();
}

/** Take the pending intent (once — it is cleared by taking). */
export function takePendingDialog(): PendingDialog | null {
  const taken = pending;
  pending = null;
  return taken;
}

/** Peek without clearing (tests and focus handlers). */
export function peekPendingDialog(): PendingDialog | null {
  return pending;
}
