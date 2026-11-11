import { rememberOrigin } from "./sceneDiff";
// src/state/sceneQuery.ts — shared scene-data layer (Stage 4, PR4 §4.4).
//
// A hand-rolled single-record-per-key store. NO @tanstack/react-query:
// the lint import allowlist forbids non-three third-party static imports
// in src/, so the stage-4 §4.4 contract is implemented directly (~200
// lines):
//   - One shared record per key ["plastis3d", sourceKey, "scene", sceneId]
//     (and one per ["plastis3d", sourceKey, "scenes"] for the list). Every
//     surface for the same source + scene reads the same record; the
//     scene is fetched once no matter how many surfaces subscribe.
//   - Subscribe ONCE to `plugin.plastis3d.scene.changed` via ctx.onEvent
//     (SDK-tracked, retired automatically). The broadcast is the primary
//     invalidation; no second listener is ever added.
//   - Polling fallback: a 4-second refetch enabled ONLY while at least one
//     eligible surface for that exact source + scene is visible. The poll
//     never runs for a hidden surface.
//   - Switching sourceKey immediately purges the old source's cached data
//     (scene records and the list); no old response is ever published
//     into a new source.
//
// sourceKey = connectionId + profile, from host.profileRoutes()
// (v0.23.0 SDK doc). The rest client comes from ctx.rest, bound once in
// initSceneData() by register() — it is never imported.

import { useEffect, useSyncExternalStore } from "react";
import { host } from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import { getScene, listScenes } from "../api";
import { sortRecent } from "./sceneOrder";
import type { RestFn } from "../api";
import type { SceneEnvelope, SceneSummary } from "../types";
import { announceRevision } from "./announcer";
import { isReparentDragging } from "./dragLock";
import { storeFailureFlags, failureCause } from "./storeFailure";

/** The refetch interval, everywhere in this stage (stage-4 §6.1). Never 2. */
export const POLL_INTERVAL_MS = 4000;

/** The broadcast event invalidating scene data. Subscribed once. */
export const SCENE_CHANGED_EVENT = "plugin.plastis3d.scene.changed";

export type QueryStatus = "loading" | "ready" | "error";

export interface QueryResult<T> {
  status: QueryStatus;
  /** Last good data, or null before the first successful fetch. */
  data: T | null;
  /** Last fetch error, if any (kept alongside stale data). */
  error: Error | null;
  /** True when a newer revision is known (broadcast) but not yet fetched. */
  stale: boolean;
  /**
   * G-14: a GET succeeded once this session and a later GET failed.
   * The last good picture is kept, the stats line shows "Scene store
   * not answering" (pane), and the ErrorState — when it shows — uses
   * `storeRetry` in place of `storeBody`.
   */
  storeNotAnswering: boolean;
  storeSentence: "storeBody" | "storeRetry";
  /**
   * G-14: the store failure is terminal for this record — the full
   * ErrorState replaces the canvas even though last good data exists.
   * True after two consecutive failed GETs (the first failure after a
   * prior success keeps the picture; the second replaces it). The
   * first GET failing is already terminal via status "error" + no
   * data, so this flag only matters once data exists.
   */
  storeExhausted: boolean;
  /** Fetch now, regardless of the poll schedule. */
  refetch: () => void;
}

// --- sourceKey ---------------------------------------------------------------

/** `connectionId + profile` for the current connection's first route. */
export function resolveSourceKey(): string {
  try {
    const routes = host.profileRoutes?.();
    if (Array.isArray(routes) && routes.length > 0) {
      const route = routes[0] as
        | { connectionId?: unknown; profile?: unknown }
        | undefined;
      if (
        route &&
        typeof route.connectionId === "string" &&
        route.connectionId &&
        typeof route.profile === "string" &&
        route.profile
      ) {
        return `${route.connectionId}:${route.profile}`;
      }
    }
  } catch {
    // Fall through to the local fallback below.
  }
  return "local:default";
}

// --- module state ------------------------------------------------------------

interface RecordBase {
  version: number;
  listeners: Set<() => void>;
  eligible: number;
  timer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
  stale: boolean;
  status: QueryStatus;
  error: Error | null;
  /** G-14: a GET succeeded for this record in this session. */
  hadSuccess: boolean;
  /** G-14: consecutive failed GETs (reset to 0 on any success). */
  consecutiveFailures: number;
}

interface SceneRecord extends RecordBase {
  sourceKey: string;
  sceneId: string;
  data: SceneEnvelope | null;
}

interface ListRecord extends RecordBase {
  sourceKey: string;
  data: SceneSummary[] | null;
}

const sceneRecords = new Map<string, SceneRecord>();
const listRecords = new Map<string, ListRecord>();

let boundCtx: PluginContext | null = null;
let boundRest: RestFn | null = null;
let broadcastDisposer: (() => void) | null = null;
/** The sourceKey of the most recent hook call (the "active" source). */
let lastSourceKey: string | null = null;

function sceneKey(sourceKey: string, sceneId: string): string {
  return `${sourceKey}\nscene\n${sceneId}`;
}

function bump(record: RecordBase): void {
  record.version += 1;
  for (const fn of [...record.listeners]) fn();
}

function stopTimer(record: RecordBase): void {
  if (record.timer !== null) {
    clearInterval(record.timer);
    record.timer = null;
  }
}

/** Start the 4 s poll iff at least one eligible surface is visible. */
function updatePolling(
  record: RecordBase,
  fetch: () => void,
): void {
  if (record.eligible > 0 && record.timer === null) {
    record.timer = setInterval(() => {
      // G-18: a reparent drag is down — skip the tick. The settlement
      // refetch picks up whatever the poll would have fetched.
      if (isReparentDragging()) return;
      fetch();
    }, POLL_INTERVAL_MS);
  } else if (record.eligible === 0 && record.timer !== null) {
    stopTimer(record);
  }
}

/**
 * Switching sourceKey immediately purges the old source's cached data:
 * no old response is published into a new source (stage-4 §6.1).
 * The TemplateCache purge for the old source is the Viewport's job
 * (it owns the cache instance); see Viewport.tsx.
 */
function purgeOtherSources(sourceKey: string): void {
  if (lastSourceKey === sourceKey) return;
  for (const [key, record] of [...sceneRecords]) {
    if (record.sourceKey !== sourceKey) {
      stopTimer(record);
      sceneRecords.delete(key);
    }
  }
  for (const [key, record] of [...listRecords]) {
    if (record.sourceKey !== sourceKey) {
      stopTimer(record);
      listRecords.delete(key);
    }
  }
  lastSourceKey = sourceKey;
}

function getOrCreateSceneRecord(
  sourceKey: string,
  sceneId: string,
): SceneRecord {
  purgeOtherSources(sourceKey);
  const key = sceneKey(sourceKey, sceneId);
  let record = sceneRecords.get(key);
  if (!record) {
    record = {
      sourceKey,
      sceneId,
      data: null,
      version: 0,
      listeners: new Set(),
      eligible: 0,
      timer: null,
      inFlight: false,
      stale: false,
      status: "loading",
      error: null,
      hadSuccess: false,
      consecutiveFailures: 0,
    };
    sceneRecords.set(key, record);
  }
  return record;
}

function getOrCreateListRecord(sourceKey: string): ListRecord {
  purgeOtherSources(sourceKey);
  let record = listRecords.get(sourceKey);
  if (!record) {
    record = {
      sourceKey,
      data: null,
      version: 0,
      listeners: new Set(),
      eligible: 0,
      timer: null,
      inFlight: false,
      stale: false,
      status: "loading",
      error: null,
      hadSuccess: false,
      consecutiveFailures: 0,
    };
    listRecords.set(sourceKey, record);
  }
  return record;
}

// --- fetching ----------------------------------------------------------------

/**
 * Fetch one scene record. `viaPoll` marks the 4 s timer refetch: the
 * poll NEVER announces (G-06) — only a broadcast-driven or
 * user-driven fetch announces when it lands a changed revision.
 *
 * The revision announcement fires on ARRIVAL, not on broadcast
 * receipt: the broadcast path (onSceneChanged) also announces, and
 * the announcer's (scene, revision) dedup key collapses the two into
 * one — unless a loading announcement intervened, in which case the
 * arrival announcement is the one the region ends on (G-12: the
 * loading sentence is followed by the revision sentence when the
 * scene arrives). A first load announces too (no revision was on
 * screen before), which is what G-12's "on resolve, assert the
 * revision announcement" requires; a scene switch therefore announces
 * the newly opened scene's revision.
 */
async function fetchSceneRecord(
  record: SceneRecord,
  opts?: { viaPoll?: boolean },
): Promise<void> {
  if (!boundRest || record.inFlight) return;
  record.inFlight = true;
  const prevRevision = record.data?.scene.revision ?? null;
  try {
    const data = await getScene(boundRest, record.sceneId);
    record.data = data;
    record.status = "ready";
    record.error = null;
    record.stale = false;
    record.hadSuccess = true;
    record.consecutiveFailures = 0;
    if (!opts?.viaPoll && data.scene.revision !== prevRevision) {
      announceRevision(record.sceneId, data.scene.revision);
    }
  } catch (error) {
    record.error = error instanceof Error ? error : new Error(String(error));
    // Keep showing the last good data on a refetch failure; only the
    // never-loaded case becomes an error state.
    record.status = record.data ? "ready" : "error";
    record.stale = record.data !== null;
    record.consecutiveFailures += 1;
  } finally {
    record.inFlight = false;
    bump(record);
  }
}

async function fetchListRecord(record: ListRecord): Promise<void> {
  if (!boundRest || record.inFlight) return;
  record.inFlight = true;
  try {
    const data = sortRecent(await listScenes(boundRest));
    record.data = data;
    record.status = "ready";
    record.error = null;
    record.stale = false;
    record.hadSuccess = true;
    record.consecutiveFailures = 0;
  } catch (error) {
    record.error = error instanceof Error ? error : new Error(String(error));
    record.status = record.data ? "ready" : "error";
    record.stale = record.data !== null;
    record.consecutiveFailures += 1;
  } finally {
    record.inFlight = false;
    bump(record);
  }
}

/** G-14: the store-failure flags for a record, from its per-record
 * counters (errata Issue 5: the list record's count drives the Scenes
 * pane / list branches; the scene record's count drives the viewport
 * / editor scene branches — each hook reads its own record). The
 * derivation itself is the pure storeFailureFlags helper. */
function storeFlags(record: RecordBase): {
  storeNotAnswering: boolean;
  storeExhausted: boolean;
  storeSentence: "storeBody" | "storeRetry";
} {
  return storeFailureFlags(
    record.hadSuccess,
    record.consecutiveFailures,
    failureCause(record.error),
  );
}

/** Broadcast invalidation: refetch now if a surface is eligible, else stale. */
function invalidateScene(sourceKey: string, sceneId: string): void {
  const record = sceneRecords.get(sceneKey(sourceKey, sceneId));
  if (!record) return;
  if (record.eligible > 0) {
    void fetchSceneRecord(record);
  } else {
    record.stale = true;
    bump(record);
  }
}

function invalidateList(sourceKey: string): void {
  const record = listRecords.get(sourceKey);
  if (!record) return;
  if (record.eligible > 0) {
    void fetchListRecord(record);
  } else {
    record.stale = true;
    bump(record);
  }
}

/**
 * Invalidate only the scene list for a source (F-UI-FIX-09: after a
 * delete). The deleted scene's own record is left alone — refetching
 * it would only 404 — and goes unused once the list drops its id.
 */
export function invalidateSceneList(sourceKey: string): void {
  invalidateList(sourceKey);
}

/**
 * Invalidate the cached scene + list for a source from outside React
 * (the editor.focus handler, palette commands). Refetches now when a
 * surface is eligible, else marks the records stale for the next
 * visible surface.
 */
export function invalidateSceneData(sourceKey: string, sceneId?: string): void {
  if (sceneId !== undefined) {
    invalidateScene(sourceKey, sceneId);
  } else {
    for (const record of [...sceneRecords.values()]) {
      if (record.sourceKey === sourceKey) {
        invalidateScene(sourceKey, record.sceneId);
      }
    }
  }
  invalidateList(sourceKey);
}

/**
 * Handle `plugin.plastis3d.scene.changed`. The gateway frame carries the
 * payload as { scene, revision } (ui-design-first-draft §"Shared state");
 * the event may also arrive bare. A scene id invalidates that scene's
 * record and the list (its revision changed); an event with no usable
 * scene id invalidates every scene record for the active source.
 *
 * G-06: the broadcast path announces "Scene updated to revision N"
 * when the incoming revision differs from the one on screen. The
 * arrival announcement in fetchSceneRecord fires for the same
 * revision too; the announcer's (scene, revision) dedup key makes
 * the two one announcement (unless a loading announcement intervened
 * — then the arrival announcement re-states it, which is correct:
 * the region currently shows the loading sentence).
 */
function onSceneChanged(event: unknown): void {
  // G-18: a reparent drag is down — drop the payload. The pointer-up
  // POST goes out first with the pointer-down baseRevision; the
  // settlement refetch is an explicit, non-poll fetch, so its arrival
  // announces the new revision. Deliberately NOT in invalidateScene /
  // invalidateSceneData: explicit refetches always run.
  if (isReparentDragging()) return;
  const sourceKey = lastSourceKey ?? resolveSourceKey();
  const payload =
    event && typeof event === "object" && "payload" in event
      ? (event as { payload?: unknown }).payload
      : event;
  const sceneId =
    payload && typeof payload === "object"
      ? (payload as { scene?: unknown }).scene
      : undefined;
  const revision =
    payload && typeof payload === "object"
      ? (payload as { revision?: unknown }).revision
      : undefined;
  if (typeof sceneId === "string" && sceneId) {
    if (typeof revision === "number") {
      rememberOrigin(sceneId, revision, (payload as { origin?: unknown }).origin);
      const record = sceneRecords.get(sceneKey(sourceKey, sceneId));
      if (
        record &&
        revision !== (record.data?.scene.revision ?? null)
      ) {
        announceRevision(sceneId, revision);
      }
    }
    invalidateScene(sourceKey, sceneId);
  } else {
    for (const record of [...sceneRecords.values()]) {
      if (record.sourceKey === sourceKey) invalidateScene(sourceKey, record.sceneId);
    }
  }
  invalidateList(sourceKey);
}

// --- lifecycle ---------------------------------------------------------------

/**
 * Bind the data layer to a PluginContext. Called once by register();
 * idempotent for the same ctx, re-binds (and re-subscribes the single
 * broadcast listener) when the ctx changes. The ctx.onEvent
 * subscription is SDK-tracked and retired automatically — no manual
 * bookkeeping, and never a second listener for the same ctx.
 */
export function initSceneData(ctx: PluginContext): void {
  if (boundCtx !== ctx) {
    if (broadcastDisposer) {
      broadcastDisposer();
      broadcastDisposer = null;
    }
    boundCtx = ctx;
    boundRest = ctx.rest as unknown as RestFn;
    broadcastDisposer = ctx.onEvent(SCENE_CHANGED_EVENT, onSceneChanged);
    // A record may have been created (and left unfetched) before the
    // rest client was bound; sweep it now.
    for (const record of sceneRecords.values()) {
      if (!record.data && record.status === "loading") void fetchSceneRecord(record);
    }
    for (const record of listRecords.values()) {
      if (!record.data && record.status === "loading") void fetchListRecord(record);
    }
  }
}

/**
 * Plugin-wide backstop for ctx.onDispose: stop every poll timer and
 * drop all cached data. Component unmounts already release their own
 * eligibility; this only covers a dispose with surfaces still mounted.
 */
export function disposeSceneData(): void {
  for (const record of sceneRecords.values()) stopTimer(record);
  for (const record of listRecords.values()) stopTimer(record);
  sceneRecords.clear();
  listRecords.clear();
  if (broadcastDisposer) {
    broadcastDisposer();
    broadcastDisposer = null;
  }
  boundCtx = null;
  boundRest = null;
  lastSourceKey = null;
}

// --- hooks -------------------------------------------------------------------

function subscribeRecord(record: RecordBase): (fn: () => void) => () => void {
  return (fn: () => void) => {
    record.listeners.add(fn);
    return () => {
      record.listeners.delete(fn);
    };
  };
}

/**
 * Subscribe to one scene's shared record. `eligible` must be true only
 * while a surface for this exact source + scene is visible; the 4 s
 * poll runs exactly while eligible > 0. A null sceneId returns the
 * never-loaded result and fetches nothing (the pane renders its empty
 * state instead).
 */
export function useScene(
  sourceKey: string,
  sceneId: string | null,
  opts?: { eligible?: boolean },
): QueryResult<SceneEnvelope> {
  const eligible = opts?.eligible === true;
  const record =
    sceneId !== null
      ? getOrCreateSceneRecord(sourceKey, sceneId)
      : null;
  const version = useSyncExternalStore(
    record ? subscribeRecord(record) : () => () => undefined,
    () => (record ? record.version : 0),
  );
  void version;

  useEffect(() => {
    if (!record) return;
    if (!record.data && record.status !== "ready") {
      void fetchSceneRecord(record);
    } else if (record.stale && record.eligible > 0) {
      void fetchSceneRecord(record);
    }
  }, [record, sourceKey, sceneId]);

  useEffect(() => {
    if (!record || !eligible) return;
    record.eligible += 1;
    // The 4 s timer refetch is marked viaPoll: it never announces
    // (G-06) — the poll must not chatter the live region.
    updatePolling(record, () => void fetchSceneRecord(record, { viaPoll: true }));
    if (record.stale) void fetchSceneRecord(record);
    return () => {
      record.eligible -= 1;
      updatePolling(record, () => void fetchSceneRecord(record, { viaPoll: true }));
    };
  }, [record, eligible]);

  if (!record) {
    return {
      status: "loading",
      data: null,
      error: null,
      stale: false,
      storeNotAnswering: false,
      storeSentence: "storeBody",
      storeExhausted: false,
      refetch: () => undefined,
    };
  }
  return {
    status: record.status,
    data: record.data,
    error: record.error,
    stale: record.stale,
    ...storeFlags(record),
    refetch: () => void fetchSceneRecord(record),
  };
}

/**
 * Subscribe to the shared scene-list record for a source. Same
 * contract as useScene: one record per source, 4 s poll only while an
 * eligible surface (the Scenes pane) is visible.
 */
export function useSceneList(
  sourceKey: string,
  opts?: { eligible?: boolean },
): QueryResult<SceneSummary[]> {
  const eligible = opts?.eligible === true;
  const record = getOrCreateListRecord(sourceKey);
  const version = useSyncExternalStore(
    subscribeRecord(record),
    () => record.version,
  );
  void version;

  useEffect(() => {
    if (!record.data && record.status !== "ready") {
      void fetchListRecord(record);
    } else if (record.stale && record.eligible > 0) {
      void fetchListRecord(record);
    }
  }, [record, sourceKey]);

  useEffect(() => {
    if (!eligible) return;
    record.eligible += 1;
    updatePolling(record, () => void fetchListRecord(record));
    if (record.stale) void fetchListRecord(record);
    return () => {
      record.eligible -= 1;
      updatePolling(record, () => void fetchListRecord(record));
    };
  }, [record, eligible]);

  return {
    status: record.status,
    data: record.data,
    error: record.error,
    stale: record.stale,
    ...storeFlags(record),
    refetch: () => void fetchListRecord(record),
  };
}
