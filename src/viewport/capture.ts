// src/viewport/capture.ts — the desktop half of the screenshot protocol
// (PR22, correctness audit C-10; gateway half: plastis3d_scene/capture.py).
//
// A mounted viewport (the editor route or the pane, never an inline card)
// registers itself here while it is visible and drawing. One service per
// plugin watches for screenshot requests: the `capture.requested`
// broadcast triggers an immediate check and a 2 s poll covers a tool that
// ran in another process. For a request on a scene one of our surfaces is
// showing, the service CLAIMS it (the gateway lets exactly one surface win),
// asks that surface for a PNG of its own canvas, and posts it. Nothing but
// the plugin's canvas is ever read: no host UI, no chat.
import { claimCapture, getPendingCaptures, submitCapture } from "../api";
import type { CaptureRequest, RestFn } from "../api";
import { bytesToBase64 } from "../io/importFlow";
import { invalidateSceneData, resolveSourceKey } from "../state/sceneQuery";

export const CAPTURE_REQUESTED_EVENT = "plugin.plastis3d.capture.requested";
export const CAPTURE_POLL_MS = 2000;

export interface CapturedFrame {
  png: Uint8Array;
}

export interface CaptureSurface {
  /** Unique per mounted viewport. */
  id: string;
  sourceKey: string;
  sceneId: () => string;
  /** The revision this surface has drawn. */
  revision: () => number;
  capture: () => Promise<CapturedFrame>;
}

const surfaces = new Map<string, CaptureSurface>();

/** Register a drawing surface; the returned function unregisters it. */
export function registerCaptureSurface(surface: CaptureSurface): () => void {
  surfaces.set(surface.id, surface);
  return () => {
    if (surfaces.get(surface.id) === surface) surfaces.delete(surface.id);
  };
}

/** Surfaces that may answer now: same source (a source switch cancels eligibility). */
function eligible(): CaptureSurface[] {
  const sourceKey = resolveSourceKey();
  return [...surfaces.values()].filter((surface) => surface.sourceKey === sourceKey);
}

export function newSurfaceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return "s" + Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface CaptureService {
  /** Check for requests now (the broadcast calls this). */
  check: () => void;
  stop: () => void;
}

/** Start the one capture service for this plugin instance. */
export function startCaptureService(rest: RestFn): CaptureService {
  const handled = new Set<string>();
  let running = false;
  let stopped = false;

  async function answer(request: CaptureRequest, surface: CaptureSurface): Promise<void> {
    try {
      await claimCapture(rest, request.id, surface.id);
    } catch {
      return; // another surface won, or the request expired
    }
    handled.add(request.id);
    try {
      const revision = surface.revision();
      const frame = await surface.capture();
      await submitCapture(rest, request.id, surface.id, revision, bytesToBase64(frame.png));
    } catch {
      // The claim lapses and the tool reports DESKTOP_UNAVAILABLE; nothing to undo.
    }
  }

  async function run(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const sceneIds = new Set(eligible().map((surface) => surface.sceneId()));
      for (const sceneId of sceneIds) {
        let requests: CaptureRequest[];
        try {
          requests = await getPendingCaptures(rest, sceneId);
        } catch {
          continue;
        }
        for (const request of requests) {
          if (handled.has(request.id)) continue;
          const candidates = eligible().filter((surface) => surface.sceneId() === request.scene);
          const ready = candidates.find((surface) => surface.revision() >= request.revision);
          if (!ready) {
            // Behind the requested revision: refetch and answer on the next check.
            invalidateSceneData(resolveSourceKey(), request.scene);
            continue;
          }
          await answer(request, ready);
        }
      }
      if (handled.size > 200) handled.clear();
    } finally {
      running = false;
    }
  }

  const check = (): void => {
    void run();
  };
  // Only poll while a surface could answer: an idle plugin makes no requests.
  const timer = setInterval(() => {
    if (surfaces.size > 0) check();
  }, CAPTURE_POLL_MS);
  return {
    check,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
