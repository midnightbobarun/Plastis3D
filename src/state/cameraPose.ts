// src/state/cameraPose.ts — the orbit pose, persisted outside the
// Viewport component (E-09 re-plan, D-REPLAN-06 option (b)).
//
// Both surfaces unmount the Viewport while a cold scene loads (the
// loading branch renders "Loading scene…" with no Viewport), so a
// camera created at mount would reset to the default pose on every
// cold switch — while warm switches preserved it. The pose therefore
// lives here, in module state, keyed by chrome ("editor" | "pane")
// ONLY — per surface, not per scene or source: it survives scene and
// source changes.
//
// Module state, no React subscription: the pose is read once at
// camera creation (Viewport mount effect) and written once in that
// effect's cleanup (before controls.dispose()) and by the reset-view
// effect. Getters and setters copy, so no caller can alias the stored
// pose and mutate it behind the store's back. The default is the
// reset-view pose (4, 3, 6) / (0, 0, 0).

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export const DEFAULT_CAMERA_POSE: CameraPose = {
  position: [4, 3, 6],
  target: [0, 0, 0],
};

const poses: Record<"editor" | "pane", CameraPose> = {
  editor: {
    position: [...DEFAULT_CAMERA_POSE.position],
    target: [...DEFAULT_CAMERA_POSE.target],
  },
  pane: {
    position: [...DEFAULT_CAMERA_POSE.position],
    target: [...DEFAULT_CAMERA_POSE.target],
  },
};

/** The stored pose for a surface (a copy; the default before any write). */
export function getCameraPose(chrome: "editor" | "pane"): CameraPose {
  const pose = poses[chrome];
  return {
    position: [...pose.position],
    target: [...pose.target],
  };
}

/** Store a surface's pose (copied in). */
export function setCameraPose(
  chrome: "editor" | "pane",
  pose: CameraPose,
): void {
  poses[chrome] = {
    position: [...pose.position],
    target: [...pose.target],
  };
}

// --- PR32 (UI/UX redesign §1.1 row 12, §5.7) ----------------------------
//
// `touched`: the user has moved this surface's view (orbit, pan, zoom,
// Frame, Reset, a view-gizmo click). Until then, opening a scene frames
// its contents instead of keeping the default pose — the first view of
// a scene must show the scene, not crop it. Once touched, the pinned
// pose wins (E-09 stays intact).
//
// `liveTarget`: the orbit target, updated on every controls change, so
// the Add popover can drop new objects where the user is looking.

const touched: Record<"editor" | "pane", boolean> = { editor: false, pane: false };
const liveTargets: Record<"editor" | "pane", [number, number, number]> = {
  editor: [...DEFAULT_CAMERA_POSE.target],
  pane: [...DEFAULT_CAMERA_POSE.target],
};

export function markPoseTouched(chrome: "editor" | "pane"): void {
  touched[chrome] = true;
}

export function isPoseTouched(chrome: "editor" | "pane"): boolean {
  return touched[chrome];
}

export function setLiveTarget(
  chrome: "editor" | "pane",
  target: [number, number, number],
): void {
  liveTargets[chrome] = [...target];
}

export function getLiveTarget(chrome: "editor" | "pane"): [number, number, number] {
  return [...liveTargets[chrome]];
}

/** Test seam. */
export function resetPoseTouchForTests(): void {
  touched.editor = false;
  touched.pane = false;
}

const livePositions: Record<"editor" | "pane", [number, number, number]> = {
  editor: [...DEFAULT_CAMERA_POSE.position],
  pane: [...DEFAULT_CAMERA_POSE.position],
};

/** The orbit camera position, updated with the target (Add: camera from view). */
export function setLivePosition(
  chrome: "editor" | "pane",
  position: [number, number, number],
): void {
  livePositions[chrome] = [...position];
}

export function getLivePosition(chrome: "editor" | "pane"): [number, number, number] {
  return [...livePositions[chrome]];
}
