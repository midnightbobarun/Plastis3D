// src/ui/format.ts — small pure formatters for the PR32 chrome (no DOM,
// no SDK: unit-tested in Node).

const HUES = ["var(--ui-red, #e5484d)", "var(--ui-green, #46a758)", "var(--ui-blue, #3e7bfa)", "var(--ui-yellow, #d9a514)", "var(--ui-purple, #8e4ec6)"];

/** A stable identity hue per scene id (redesign §6.3 generated tile). */
export function sceneHue(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/** "Edited just now", "Edited 5 min ago", "Edited 2 h ago", "Edited 3 Nov". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "Edited just now";
  const m = Math.round(s / 60);
  if (m < 60) return `Edited ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Edited ${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return d === 1 ? "Edited yesterday" : `Edited ${d} days ago`;
  return `Edited ${new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". */
export function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

