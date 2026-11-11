// src/state/viewPrefs.ts — view-only preferences shared by every surface
// (UI/UX redesign §5.1, §5.5, §5.6, PR32). Nothing here is written to a
// scene or a GLB; the agent never sees it. Persisted through the host's
// plugin storage (ctx.storage, scoped to this plugin) when the host
// provides it; otherwise kept for the session only.

import { useSyncExternalStore } from "react";

export type StageBackground = "gradient" | "studio" | "plain";
export type QualityPref = "auto" | "high" | "low";

export interface ViewPrefs {
  snap: boolean;
  snapMove: number;
  snapRotate: number;
  snapScale: number;
  grid: boolean;
  gridSize: number;
  toneMapping: "neutral" | "aces" | "none";
  showHelpers: boolean;
  background: StageBackground;
  quality: QualityPref;
  /** The first-visit navigation hint has been dismissed (or used). */
  navHintSeen: boolean;
  /** Fill light when the scene has no lights (view-only). */
  fillLight: boolean;
  /** Recently used custom colours (newest first, up to 6). */
  recentColors: string[];
}

export interface PrefsStorage {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

const DEFAULTS: ViewPrefs = {
  snap: false, snapMove: .5, snapRotate: 15, snapScale: .1,
  grid: true,
  gridSize: 1,
  toneMapping: "neutral",
  showHelpers: true,
  background: "gradient",
  quality: "auto",
  navHintSeen: false,
  fillLight: true,
  recentColors: [],
};

const KEY = "view.prefs.v1";

let storage: PrefsStorage | null = null;
let prefs: ViewPrefs = { ...DEFAULTS };
const listeners = new Set<() => void>();

function sanitize(raw: unknown): ViewPrefs {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.snap === "boolean") out.snap = r.snap;
  for (const key of ["snapMove", "snapRotate", "snapScale"] as const) if (typeof r[key] === "number" && Number.isFinite(r[key]) && r[key] > 0) out[key] = Math.min(100, r[key]);
  if (typeof r.grid === "boolean") out.grid = r.grid;
  if (typeof r.showHelpers === "boolean") out.showHelpers = r.showHelpers;
  if (typeof r.snap === "boolean") out.snap = r.snap;
  for (const key of ["snapMove", "snapRotate", "snapScale"] as const) if (typeof r[key] === "number" && Number.isFinite(r[key]) && r[key] > 0) out[key] = Math.min(100, r[key]);
  if (typeof r.gridSize === "number" && Number.isFinite(r.gridSize)) out.gridSize = Math.min(100, Math.max(.1, r.gridSize));
  if (r.toneMapping === "neutral" || r.toneMapping === "aces" || r.toneMapping === "none") out.toneMapping = r.toneMapping;
  if (r.background === "gradient" || r.background === "studio" || r.background === "plain") out.background = r.background;
  if (r.quality === "auto" || r.quality === "high" || r.quality === "low") out.quality = r.quality;
  if (typeof r.navHintSeen === "boolean") out.navHintSeen = r.navHintSeen;
  if (typeof r.fillLight === "boolean") out.fillLight = r.fillLight;
  if (Array.isArray(r.recentColors)) {
    out.recentColors = r.recentColors
      .filter((c): c is string => typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c))
      .slice(0, 6);
  }
  return out;
}

/** Bind the host storage once at register(); loads saved prefs. */
export function initViewPrefs(store: PrefsStorage | null | undefined): void {
  storage = store ?? null;
  try {
    prefs = sanitize(storage?.get<unknown>(KEY, null));
  } catch {
    prefs = { ...DEFAULTS };
  }
  for (const fn of [...listeners]) fn();
}

export function getViewPrefs(): ViewPrefs {
  return prefs;
}

export function setViewPrefs(patch: Partial<ViewPrefs>): void {
  prefs = sanitize({ ...prefs, ...patch });
  try {
    storage?.set(KEY, prefs);
  } catch {
    // Storage refused: keep the in-memory value.
  }
  for (const fn of [...listeners]) fn();
}

export function rememberColor(hex: string): void {
  const lower = hex.toLowerCase();
  setViewPrefs({ recentColors: [lower, ...prefs.recentColors.filter((c) => c !== lower)].slice(0, 6) });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useViewPrefs(): ViewPrefs {
  return useSyncExternalStore(subscribe, getViewPrefs, getViewPrefs);
}

/** Test seam: reset to defaults with no storage. */
export function resetViewPrefsForTests(): void {
  storage = null;
  prefs = { ...DEFAULTS };
}
