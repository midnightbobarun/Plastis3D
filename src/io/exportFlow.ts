// src/io/exportFlow.ts — the GLB export click flow (Stage 5, PR5).
//
// ui-design-first-draft §"Export captures the save before the POST":
// capture the save action with captureGatewayFileDownload() synchronously
// FIRST (on the user gesture), then POST /scenes/{id}/export, then
// invoke the captured action with the backend path and filename. The
// host owns the Saved / Download failed toasts — this flow adds none
// when the capture ran.
//
// Two-click fallback (PR1 spike: the dialog DOES open across the await
// in the Webapp tab, and is presumed to open on Desktop; the fallback
// stays until a human confirms the native dialog on a real machine):
// when captureGatewayFileDownload is absent, the first click only POSTs
// and returns the result as `pending`; the caller relabels its button
// "Save GLB…" and the second click calls captureGatewayFileDownload()
// synchronously again and invokes the returned action with the pending
// path/filename in that same turn. If the function is still absent on
// the second click, the caller toasts the backend path (the export
// already happened server-side).
//
// This module takes the capture function as a parameter so it stays
// free of the @hermes/plugin-sdk import (testable, and the caller owns
// the gesture turn). Errors toast via toastForCode (context "edit").

import { exportScene } from "../api";
import type { RestFn } from "../api";
import { ApiError } from "../api";
import { toastForCode } from "../copy";

/** The save action captureGatewayFileDownload() returns. */
export type SaveAction = (
  path: string,
  suggestedName: string,
) => Promise<void>;

export interface ExportPending {
  path: string;
  filename: string;
}

export type ExportClickResult =
  | { ok: true; saved: true }
  | { ok: true; saved: false; pending: ExportPending }
  | { ok: false };

export interface ExportFlowOpts {
  /**
   * captureGatewayFileDownload, passed through from the caller (plugin
   * register / editor button) so the call happens synchronously in the
   * click turn. Undefined when the host build has no such function.
   */
  capture?: () => SaveAction | undefined;
  /**
   * The name offered in the save dialog (a friendly "<scene name>.glb").
   * Without it the server's "<id>-r<revision>.glb" is offered.
   */
  suggestedName?: string;
  /** host.notify (injected so this module stays SDK-free). */
  notify: (kind: "info" | "warning", message: string) => void;
}

/** "My Crate!" -> "My-Crate.glb"; undefined when nothing usable is left. Matches the gateway's export_filename(). */
export function friendlyGlbName(sceneName: string | undefined): string | undefined {
  const base = (sceneName ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base ? `${base}.glb` : undefined;
}

/** Pull path/filename out of the export result, or null when malformed. */
export function exportResultOf(payload: unknown): ExportPending | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path) return null;
  if (typeof record.filename !== "string" || !record.filename) return null;
  return { path: record.path, filename: record.filename };
}

/**
 * One export click: capture first, POST, then save. On an ApiError the
 * mapped toast is notified and { ok: false } is returned (the caller
 * changes nothing). On success with a captured action the action is
 * invoked; when invoking it throws, the pending result is returned so
 * the caller can offer the second click instead of losing the file.
 */
export async function runExportClick(
  rest: RestFn,
  sceneId: string,
  opts: ExportFlowOpts,
): Promise<ExportClickResult> {
  // Synchronous capture FIRST, before any await: the dialog is tied to
  // the user gesture.
  let save: SaveAction | undefined;
  try {
    save = opts.capture?.();
  } catch {
    save = undefined;
  }
  let payload: unknown;
  try {
    payload = await exportScene(rest, sceneId);
  } catch (err) {
    const toast = toastForCode(err instanceof ApiError ? err.code : "EXPORT_FAILED", {
      context: "edit",
      serverMessage: err instanceof Error ? err.message : undefined,
      reason:
        err instanceof ApiError && typeof err.reason === "string"
          ? err.reason
          : undefined,
    });
    opts.notify(toast.kind, toast.message);
    return { ok: false };
  }
  const pending = exportResultOf(payload);
  if (!pending) {
    const toast = toastForCode("EXPORT_FAILED", { context: "edit" });
    opts.notify(toast.kind, toast.message);
    return { ok: false };
  }
  if (!save) return { ok: true, saved: false, pending };
  try {
    await save(pending.path, opts.suggestedName || pending.filename);
  } catch {
    // The export already happened server-side; offer the second click
    // rather than dropping the file on the floor.
    return { ok: true, saved: false, pending };
  }
  return { ok: true, saved: true };
}

/**
 * The second click of the two-click fallback: capture synchronously in
 * this turn and invoke with the pending path/filename. Returns true
 * when the save action ran; false when the function is still absent
 * (the caller then toasts the backend path instead).
 */
export async function runSaveClick(
  pending: ExportPending,
  opts: ExportFlowOpts,
): Promise<boolean> {
  let save: SaveAction | undefined;
  try {
    save = opts.capture?.();
  } catch {
    save = undefined;
  }
  if (!save) return false;
  try {
    await save(pending.path, opts.suggestedName || pending.filename);
  } catch {
    return false;
  }
  return true;
}
