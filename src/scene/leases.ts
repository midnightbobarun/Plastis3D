// src/scene/leases.ts — renderer lease manager (Stage 4, PR4 §4.3;
// ui-design-first-draft rule 10).
//
// At most THREE live WebGL renderers across every mounted pane, route
// tile, and card. Priority is editor, then viewport, then the nearest
// visible card; a surface without a lease shows its summary rather than
// creating a renderer. Release the lease and dispose the renderer when
// the surface unmounts; hidden panes pause the frame loop and dispose
// on unmount, not on Hide.
//
// Higher-priority surfaces may cooperatively yield a card lease.

export type LeasePriority = "editor" | "viewport" | "card";

/** Lower rank wins when leases are compared (editor first). */
export const LEASE_PRIORITY_RANK: Record<LeasePriority, number> = {
  editor: 0,
  viewport: 1,
  card: 2,
};

/** The cap: at most three live WebGL renderers, everywhere. */
export const MAX_LIVE_RENDERERS = 3;

export interface RendererLease {
  /** The surface holding the lease (e.g. "viewport", "editor", "card:<id>"). */
  id: string;
  priority: LeasePriority;
  onYield?: () => void;
}

const live = new Map<string, RendererLease>();
const listeners = new Set<() => void>();
let yielding = false;
let disposed = false;

export function onLeaseFreed(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyFreed(): void {
  queueMicrotask(() => {
    if (!disposed) for (const listener of [...listeners]) listener();
  });
}

/**
 * Grant a lease to `id`, or return null when all three slots are taken.
 * Re-acquiring an id that already holds a lease returns that lease.
 * No preemption in PR4: a denied surface shows its summary.
 */
export function acquireLease(
  id: string,
  priority: LeasePriority,
  onYield?: () => void,
): RendererLease | null {
  disposed = false;
  if (priority === "card" && !onYield) throw new Error("Card leases require onYield");
  if (yielding) return null;
  const existing = live.get(id);
  if (existing) return existing;
  if (live.size >= MAX_LIVE_RENDERERS && priority !== "card") {
    const card = [...live.values()].find((lease) => lease.priority === "card");
    if (card?.onYield) {
      yielding = true;
      try { card.onYield(); } finally { yielding = false; }
    }
  }
  if (live.size >= MAX_LIVE_RENDERERS) return null;
  const lease: RendererLease = { id, priority, onYield };
  live.set(id, lease);
  return lease;
}

/**
 * Release `id`'s lease (no-op when it holds none). A release made while
 * a card is yielding its slot to a higher-priority surface does NOT
 * announce a free slot: that slot is handed straight to the surface
 * that asked for it. Announcing it raced the card's own yield — the
 * card heard "a slot is free" in the same tick it was told to give its
 * slot up, React batched leased=false then leased=true into no change,
 * and the card stayed mounted with its renderer already destroyed (a
 * blank card that never recovered; seen as a flaky card.spec, fixed in
 * PR32).
 */
export function releaseLease(id: string): void {
  if (live.delete(id) && !yielding) notifyFreed();
}

/** How many renderers are live right now. */
export function liveLeaseCount(): number {
  return live.size;
}

/** Whether `id` currently holds a lease. */
export function hasLease(id: string): boolean {
  return live.has(id);
}

/**
 * Plugin-wide backstop for ctx.onDispose: release every lease. Surfaces
 * release their own lease on unmount; this only covers a dispose with
 * surfaces still mounted.
 */
export function releaseAllLeases(): void {
  disposed = true;
  live.clear();
}
