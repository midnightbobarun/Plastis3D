import { markLocalWrite } from "./state/sceneDiff";
// src/api.ts — typed ctx.rest wrappers (Stage 4, PR4).
//
// The rest function is TAKEN AS A PARAMETER, never imported from
// @hermes/plugin-sdk, so these wrappers stay testable in Node and the
// data-layer agent can bind them to ctx.rest (or a mock) per source.
//
// Two failure shapes are handled defensively, because the gateway and
// the host disagree about how errors arrive:
//   1. a REJECTION from rest() (the mock host's rest() always rejects;
//      the real host rejects on transport failure), and
//   2. a RESOLVED error payload: { ok: false, code, message } (the
//      gateway's _error_response shape) or an error-code field.
// Both become an ApiError the caller can distinguish by `code`.
// Nothing here ever hangs: every path either resolves with typed data
// or throws an ApiError.
//
// GET /assets notes (PR7, D1): ctx.rest JSON-parses every 2xx
// response (PR1 §4.8 M2), so the gateway returns the asset's GLB
// bytes as base64 inside JSON — { ok, sha256, size, bytes } — and
// getAssetBytes decodes the base64 field into an ArrayBuffer for the
// template cache. The decode is the same atob loop as
// src/io/importFlow.ts dataUrlToBytes: one decoder shape, not two.
// An ok:false payload (404 ASSET_NOT_FOUND, or the 413 oversize code
// once D3 is decided) surfaces as an ApiError with the gateway code,
// exactly like every other route; the caller (TemplateCache) treats
// any failure as "no template, show stats + bounds".

import type { SceneEnvelope, SceneSpec, SceneSummary } from "./types";
import { bytesToBase64 } from "./io/importFlow";
import { hasAnalysis, isHealthReport } from "./state/health";
import type { BudgetName, HealthReport } from "./state/health";

/** The rest function shape: ctx.rest (see sdk.d.ts PluginContext). */
export type RestFn = <T>(path: string, opts?: unknown) => Promise<T>;

/** A typed API failure. `code` is the gateway error code when one was
 * supplied (e.g. NOT_IMPLEMENTED, ASSET_NOT_FOUND, SCENE_NOT_FOUND),
 * otherwise one of the local codes below. `reason` carries the
 * EXPORT_FAILED reason token when the gateway supplied one
 * (ui-design-first-draft §"Code and token mapping"). */
export class ApiError extends Error {
  readonly code: string;
  readonly reason?: string;
  readonly status?: number;
  constructor(code: string, message: string, reason?: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.reason = reason;
    this.status = status;
  }
}

export const API_ERROR_CODES = {
  /** rest() rejected and the rejection carried no gateway code. */
  restFailed: "REST_FAILED",
  /** The gateway resolved a payload that is not the expected shape. */
  badResponse: "BAD_RESPONSE",
  /** A resolved payload was ok:false with no code field. */
  requestFailed: "REQUEST_FAILED",
} as const;

// Electron can serialize HTTP failures as an Error message: "409: { ... }".
function gatewayBody(value: unknown): Record<string, unknown> | undefined {
  const message = value instanceof Error ? value.message : (value as { message?: unknown })?.message;
  if (typeof message !== "string") return undefined;
  const json = message.match(/\b\d{3}:\s*(\{.*\})/s)?.[1];
  if (!json) return undefined;
  try { const body = JSON.parse(json); return body && typeof body === "object" ? body : undefined; } catch { return undefined; }
}

/** Pull a gateway error code out of a rejection or payload, if any. */
function errorCodeOf(value: unknown): string | undefined {
  const body = gatewayBody(value);
  if (body?.ok === false && typeof body.code === "string") return body.code;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && record.code) return record.code;
    if (typeof record.error === "string" && /^[A-Z][A-Z0-9_]+$/.test(record.error)) return record.error;
  }
  return undefined;
}

/** Pull the EXPORT_FAILED reason token out of a rejection or payload. */
function errorReasonOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.reason === "string" && record.reason) {
      return record.reason;
    }
    // Fallback: a single token after the code in the message.
    if (typeof record.message === "string") {
      const match = record.message.match(/^[A-Z_]+ (\w+)$/);
      if (match) return match[1];
    }
  }
  return undefined;
}

function errorMessageOf(value: unknown, fallback: string): string {
  const body = gatewayBody(value);
  if (typeof body?.message === "string") return body.message;
  if (value instanceof Error && value.message) return value.message;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) {
      return record.message;
    }
  }
  return fallback;
}

/** Call rest() and translate both failure shapes into an ApiError. */
async function callRest<T>(rest: RestFn, path: string, opts?: unknown): Promise<T> {
  try {
    return await rest<T>(path, opts);
  } catch (err) {
    throw new ApiError(
      errorCodeOf(err) ?? API_ERROR_CODES.restFailed,
      errorMessageOf(err, `ctx.rest(${JSON.stringify(path)}) failed`),
      errorReasonOf(err),
      typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : typeof (err as { statusCode?: unknown })?.statusCode === "number" ? (err as { statusCode: number }).statusCode : undefined,
    );
  }
}

/** Throw unless the payload is an ok:true envelope of the expected shape. */
function requireOk<T>(
  payload: unknown,
  path: string,
  check: (value: Record<string, unknown>) => boolean,
): T {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned a non-object payload`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false) {
    throw new ApiError(
      errorCodeOf(record) ?? API_ERROR_CODES.requestFailed,
      errorMessageOf(record, `GET ${path} failed`),
      errorReasonOf(record),
    );
  }
  if (record.ok !== true || !check(record)) {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned an unexpected payload`,
    );
  }
  return payload as T;
}

/** GET /scenes -> { ok, scenes: [{ id, name, revision, updatedAt }] }. */
export async function listScenes(rest: RestFn): Promise<SceneSummary[]> {
  const payload = await callRest<unknown>(rest, "/scenes");
  const envelope = requireOk<{ scenes: SceneSummary[] }>(payload, "/scenes", (record) =>
    Array.isArray(record.scenes),
  );
  return envelope.scenes;
}

/**
 * GET /scenes/{id} -> the feedback envelope (spec without history):
 * { ok, scene: { id, revision, ... }, nodes, materials, assets,
 * stats, feedback }.
 */
export async function getScene(rest: RestFn, id: string): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(id)}`;
  const payload = await callRest<unknown>(rest, path);
  return requireOk<SceneEnvelope>(payload, path, isSceneEnvelopeRecord);
}

/** The shape check for a feedback envelope payload. */
function isSceneEnvelopeRecord(record: Record<string, unknown>): boolean {
  return (
    Array.isArray(record.nodes) &&
    Array.isArray(record.materials) &&
    Array.isArray(record.assets) &&
    record.scene !== null &&
    typeof record.scene === "object"
  );
}

/** One mutation op in a PATCH body (mutate.apply_patch). */
export interface PatchOp {
  op: string;
  [key: string]: unknown;
}

/**
 * PATCH /scenes/{id} -> the feedback envelope after the batch.
 * Body: { baseRevision, ops } (max 32 ops, one history entry, one
 * revision bump). 409 REVISION_CONFLICT arrives as an ApiError with
 * that code; the caller decides the toast and the rollback.
 */
export async function patchScene(
  rest: RestFn,
  id: string,
  baseRevision: number,
  ops: PatchOp[],
): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(id)}`;
  const payload = await callRest<unknown>(rest, path, {
    method: "PATCH",
    body: { baseRevision, ops },
  });
  const envelope = requireOk<SceneEnvelope>(payload, path, isSceneEnvelopeRecord);
  markLocalWrite(id, envelope.scene.revision);
  return envelope;
}

/** POST /scenes -> the new scene's feedback envelope (201). */
export async function createScene(
  rest: RestFn,
  name: string,
): Promise<SceneEnvelope> {
  const payload = await callRest<unknown>(rest, "/scenes", {
    method: "POST",
    body: { name },
  });
  return requireOk<SceneEnvelope>(payload, "/scenes", isSceneEnvelopeRecord);
}

export async function duplicateScene(rest: RestFn, sourceId: string, name: string): Promise<SceneEnvelope> {
  const payload = await callRest<unknown>(rest, "/scenes", { method: "POST", body: { name, copyFrom: sourceId } });
  return requireOk<SceneEnvelope>(payload, "/scenes", isSceneEnvelopeRecord);
}

/** DELETE /scenes/{id} -> nothing on success (assets remain on disk). */
export async function deleteScene(rest: RestFn, id: string, revision: number): Promise<void> {
  const path = `/scenes/${encodeURIComponent(id)}?baseRevision=${revision}`;
  const payload = await callRest<unknown>(rest, path, { method: "DELETE" });
  if (!payload || typeof payload !== "object") {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `DELETE ${path} returned a non-object payload`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false) {
    throw new ApiError(
      errorCodeOf(record) ?? API_ERROR_CODES.requestFailed,
      errorMessageOf(record, `DELETE ${path} failed`),
      errorReasonOf(record),
    );
  }
  if (record.ok !== true) {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `DELETE ${path} returned an unexpected payload`,
    );
  }
}

/** Undo: one PATCH with a single undo op (same baseRevision rule). */
export async function undoScene(
  rest: RestFn,
  id: string,
  baseRevision: number,
): Promise<SceneEnvelope> {
  return patchScene(rest, id, baseRevision, [{ op: "undo" }]);
}

/** Redo: one PATCH with a single redo op. */
export async function redoScene(
  rest: RestFn,
  id: string,
  baseRevision: number,
): Promise<SceneEnvelope> {
  return patchScene(rest, id, baseRevision, [{ op: "redo" }]);
}

/**
 * POST /scenes/{id}/export -> the export result.
 *
 * Until PR6 lands the body, the gateway returns 501 NOT_IMPLEMENTED
 * (an ApiError with that code — never a partial file). The caller
 * captures the save action with captureGatewayFileDownload() BEFORE
 * this call, on the user gesture.
 */
export async function exportScene(rest: RestFn, id: string): Promise<unknown> {
  const path = `/scenes/${encodeURIComponent(id)}/export`;
  const payload = await callRest<unknown>(rest, path, { method: "POST" });
  if (!payload || typeof payload !== "object") {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `POST ${path} returned a non-object payload`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false) {
    throw new ApiError(
      errorCodeOf(record) ?? API_ERROR_CODES.requestFailed,
      errorMessageOf(record, `POST ${path} failed`),
      errorReasonOf(record),
    );
  }
  return payload;
}

/**
 * Replace the raw bytes of an upload (and of each `.mtl` sidecar) with
 * base64 text. `ctx.rest` carries JSON only, and the gateway reads
 * `upload.bytes` as a base64 string (PR7 D1); a Uint8Array would be
 * serialised as an object of numbers. A body with no upload is returned
 * unchanged.
 */
export function encodeUploadBytes(body: Record<string, unknown>): Record<string, unknown> {
  const upload = body.upload as Record<string, unknown> | undefined;
  if (!upload || typeof upload !== "object") return body;
  const encode = (value: unknown): unknown =>
    value instanceof Uint8Array ? bytesToBase64(value) : value;
  const sidecars = Array.isArray(upload.sidecars)
    ? (upload.sidecars as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        bytes: encode(item.bytes),
      }))
    : upload.sidecars;
  const next: Record<string, unknown> = { ...upload, bytes: encode(upload.bytes) };
  if (sidecars !== undefined) next.sidecars = sidecars;
  return { ...body, upload: next };
}

/**
 * POST /scenes/{id}/imports -> the feedback envelope after import
 * (PR7). `body` is either { upload: { filename, contentType, bytes } }
 * or { backendPath } — always with baseRevision. Until the PR7
 * gateway body lands, the gateway returns 501 NOT_IMPLEMENTED (an
 * ApiError with that code — never a partial file or asset row); the
 * Tier 4 mock host already returns the canned PR7 success.
 */
export async function importScene(
  rest: RestFn,
  id: string,
  body: Record<string, unknown>,
): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(id)}/imports`;
  const payload = await callRest<unknown>(rest, path, {
    method: "POST",
    body: encodeUploadBytes(body),
  });
  return requireOk<SceneEnvelope>(payload, path, isSceneEnvelopeRecord);
}

/**
 * GET /scenes/{id}/check -> the compatibility report (PR16). Read-only; the
 * Health section shows it. `assetId` narrows it to one imported model.
 */
export async function checkScene(
  rest: RestFn,
  id: string,
  assetId?: string,
): Promise<HealthReport> {
  const path =
    `/scenes/${encodeURIComponent(id)}/check` +
    (assetId ? `?assetId=${encodeURIComponent(assetId)}` : "");
  const payload = await callRest<unknown>(rest, path);
  if (!isHealthReport(payload)) {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned an unexpected payload`,
    );
  }
  return payload;
}

export interface CleanupInfo {
  operations: string[];
  dryRun: boolean;
  applied: boolean;
  summary: string[];
  changes: {
    materialsMerged: Array<{ from: string; into: string }>;
    materialsRemoved: string[];
    groupsRemoved: Array<{ id: string; name?: string | null }>;
    nodesRepointed: string[];
    /** PR19: imported models welded, and what the weld left alone, with the reason. */
    assetsWelded?: Array<{
      assetId: string;
      name: string;
      verticesRemoved: number;
      trianglesRemoved: number;
      bytesBefore: number;
      bytesAfter: number;
      nodes?: string[];
      drawableBefore?: boolean;
      drawableAfter?: boolean;
      becameDrawable?: boolean;
    }>;
    weldSkipped?: Array<{ what: string; reason: string }>;
  };
}

/**
 * POST /scenes/{id}/cleanup -> the feedback envelope plus a `cleanup` block
 * (PR18). `dryRun` previews and writes nothing; otherwise one revision and
 * one history entry (prune and dedupe). A scene with nothing to tidy is
 * returned unchanged with `applied: false`.
 */
export async function cleanupScene(
  rest: RestFn,
  id: string,
  body: { baseRevision: number; operations?: string[]; dryRun?: boolean },
): Promise<SceneEnvelope & { cleanup: CleanupInfo }> {
  const path = `/scenes/${encodeURIComponent(id)}/cleanup`;
  const payload = await callRest<unknown>(rest, path, { method: "POST", body });
  const envelope = requireOk<SceneEnvelope & { cleanup: CleanupInfo }>(
    payload,
    path,
    (record) => {
      const info = record.cleanup as Record<string, unknown> | undefined;
      return (
        isSceneEnvelopeRecord(record) &&
        !!info &&
        typeof info.applied === "boolean" &&
        Array.isArray(info.summary) &&
        !!info.changes
      );
    },
  );
  if (envelope.cleanup.applied) markLocalWrite(id, envelope.scene.revision);
  return envelope;
}

/**
 * GET /scenes/{id}/analyze -> the compatibility report with the analyzer's
 * measured counts and heuristic score (PR17). Read-only. `budget` is the
 * named budget the score is for; `assetId` narrows it to one imported model.
 */
export async function analyzeScene(
  rest: RestFn,
  id: string,
  options: { budget?: BudgetName; assetId?: string } = {},
): Promise<HealthReport> {
  const query = new URLSearchParams();
  if (options.budget) query.set("budget", options.budget);
  if (options.assetId) query.set("assetId", options.assetId);
  const text = query.toString();
  const path = `/scenes/${encodeURIComponent(id)}/analyze${text ? `?${text}` : ""}`;
  const payload = await callRest<unknown>(rest, path);
  if (!isHealthReport(payload) || !hasAnalysis(payload)) {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned an unexpected payload`,
    );
  }
  return payload;
}

/**
 * POST /scenes/{id}/images -> the feedback envelope after a texture pick
 * (PR15). `body` is { materialId, slot, baseRevision } plus either
 * { upload: { filename, contentType, bytes } } or { backendPath }. One
 * mutation on the gateway: the image asset (when new) and the slot, one
 * revision, one undo entry.
 */
export async function importImage(
  rest: RestFn,
  id: string,
  body: Record<string, unknown>,
): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(id)}/images`;
  const payload = await callRest<unknown>(rest, path, {
    method: "POST",
    body: encodeUploadBytes(body),
  });
  return requireOk<SceneEnvelope>(payload, path, isSceneEnvelopeRecord);
}

/**
 * Decode a base64 string to bytes — the same atob loop as
 * dataUrlToBytes in src/io/importFlow.ts (which strips the `data:`
 * prefix first and then decodes the same way). Throws on invalid
 * base64; the caller maps that to BAD_RESPONSE.
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * GET /assets/{sha256} -> the asset's GLB bytes (PR7, D1).
 *
 * Success is the base64 JSON envelope { ok: true, sha256, size,
 * bytes: "<base64>" }; the base64 field decodes to the ArrayBuffer
 * the template cache parses. The echoed sha256 (when present) and
 * size (when present) are checked against the request and the decoded
 * length — a mismatch is BAD_RESPONSE, not silently wrong bytes.
 * An ok:false payload resolves to an ApiError carrying the gateway
 * code (404 ASSET_NOT_FOUND; the D3 oversize code, once decided);
 * a non-object payload, a missing/non-string bytes field, or invalid
 * base64 is BAD_RESPONSE. A resolved ArrayBuffer is still passed
 * through (the pre-PR7 assumption): a caller that already holds
 * bytes keeps working.
 */
export async function getAssetBytes(
  rest: RestFn,
  sha256: string,
): Promise<ArrayBuffer> {
  const path = `/assets/${encodeURIComponent(sha256)}`;
  const payload = await callRest<unknown>(rest, path);
  if (payload instanceof ArrayBuffer) return payload;
  if (!payload || typeof payload !== "object") {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned a non-object payload`,
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.ok === false) {
    throw new ApiError(
      errorCodeOf(record) ?? API_ERROR_CODES.requestFailed,
      errorMessageOf(record, `GET ${path} failed`),
    );
  }
  if (record.ok !== true || typeof record.bytes !== "string") {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned an unexpected payload`,
    );
  }
  if (typeof record.sha256 === "string" && record.sha256 !== sha256) {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned bytes for a different asset`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(record.bytes);
  } catch {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned bytes that are not valid base64`,
    );
  }
  if (typeof record.size === "number" && record.size !== bytes.byteLength) {
    throw new ApiError(
      API_ERROR_CODES.badResponse,
      `GET ${path} returned ${bytes.byteLength} bytes but size says ${record.size}`,
    );
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Convenience: build a SceneSpec from the getScene envelope. The
 * envelope carries no createdAt/updatedAt, so those are left empty —
 * the caller fills them from listScenes (or leaves them blank).
 * The envelope's scene.schema is used when present (PR6); an older
 * envelope without it falls back to 1.
 */
export function envelopeToScene(envelope: SceneEnvelope, name: string): SceneSpec {
  return {
    schema: envelope.scene.schema ?? 1,
    id: envelope.scene.id,
    name,
    revision: envelope.scene.revision,
    units: envelope.scene.units,
    upAxis: envelope.scene.upAxis,
    createdAt: "",
    updatedAt: "",
    nodes: envelope.nodes,
    materials: envelope.materials,
    assets: envelope.assets,
  };
}

/** One screenshot request a scene view may claim (PR22, C-10). */
export interface CaptureRequest {
  id: string;
  scene: string;
  revision: number;
}

/** GET /captures/pending -> the requests a surface may still claim. */
export async function getPendingCaptures(rest: RestFn, sceneId: string): Promise<CaptureRequest[]> {
  const path = `/captures/pending?scene=${encodeURIComponent(sceneId)}`;
  const payload = await callRest<unknown>(rest, path);
  return requireOk<{ requests: CaptureRequest[] }>(payload, path, (record) => Array.isArray(record.requests)).requests;
}

/** POST /captures/{id}/claim. A 409 CAPTURE_CONFLICT means another surface won. */
export async function claimCapture(rest: RestFn, id: string, surface: string): Promise<void> {
  const path = `/captures/${encodeURIComponent(id)}/claim`;
  requireOk<unknown>(await callRest<unknown>(rest, path, { method: "POST", body: { surface } }), path, () => true);
}

/** POST /captures/{id}: the claimant's PNG (base64) and the revision it drew. */
export async function submitCapture(rest: RestFn, id: string, surface: string, revision: number, png: string): Promise<void> {
  const path = `/captures/${encodeURIComponent(id)}`;
  requireOk<unknown>(await callRest<unknown>(rest, path, { method: "POST", body: { surface, revision, png } }), path, () => true);
}

/** The mesh arrays a bake or a draft carries (base64 little-endian, D-EXT-03). */
export interface BakeMeshBody { positions: string; normals?: string; uvs?: string; indices: string }

/**
 * POST /scenes/{id}/bakes (PR24): one revision, one history entry. A `mesh` primitive
 * becomes a `part`. Errors arrive as ApiError codes: BAKE_INVALID, BAKE_TOO_LARGE,
 * REVISION_CONFLICT, NODE_LOCKED, LIMIT_ASSETS.
 */
export async function bakeMesh(
  rest: RestFn,
  sceneId: string,
  body: { baseRevision: number; nodeId: string; mesh: BakeMeshBody; generator?: unknown; name?: string },
): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/bakes`;
  const payload = await callRest<unknown>(rest, path, { method: "POST", body });
  return requireOk<SceneEnvelope>(payload, path, isSceneEnvelopeRecord);
}

/** An unsaved-edit draft (D-EXT-07): one slot per node, outside the scene and its history. */
export interface MeshDraft {
  nodeId: string;
  baseRevision: number;
  currentRevision: number;
  from: Record<string, unknown> | null;
  mesh: BakeMeshBody;
  savedAt: number;
}

export async function putDraft(
  rest: RestFn,
  sceneId: string,
  nodeId: string,
  body: { baseRevision: number; from: Record<string, unknown> | null; mesh: BakeMeshBody },
): Promise<{ dropped: number }> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/drafts/${encodeURIComponent(nodeId)}`;
  const payload = await callRest<unknown>(rest, path, { method: "PUT", body });
  return requireOk<{ dropped: number }>(payload, path, () => true);
}

/** The node's draft, or null when there is none (404 DRAFT_NOT_FOUND). */
export async function getDraft(rest: RestFn, sceneId: string, nodeId: string): Promise<MeshDraft | null> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/drafts/${encodeURIComponent(nodeId)}`;
  try {
    const payload = await callRest<unknown>(rest, path);
    return requireOk<{ draft: MeshDraft }>(payload, path, (record) => !!record.draft && typeof record.draft === "object").draft;
  } catch (err) {
    if (err instanceof ApiError && err.code === "DRAFT_NOT_FOUND") return null;
    throw err;
  }
}

export async function deleteDraft(rest: RestFn, sceneId: string, nodeId: string): Promise<void> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/drafts/${encodeURIComponent(nodeId)}`;
  await callRest<unknown>(rest, path, { method: "DELETE" });
}

/** One row of a scene's library view (PR14). */
export interface LibraryAsset { id: string; name: string; format: string; bytes: number; used: boolean; usedBy: number }
export interface LibraryView { revision: number; assets: LibraryAsset[]; unused: number; unusedBytes: number }

/** GET /scenes/{id}/library: every model and image the scene holds, and which are unused. */
export async function getLibrary(rest: RestFn, sceneId: string): Promise<LibraryView> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/library`;
  return requireOk<LibraryView>(await callRest<unknown>(rest, path), path, (r) => Array.isArray(r.assets));
}

/** POST /scenes/{id}/library/remove-unused: the preview (dryRun) or the one undoable revision that drops the unused rows. */
export async function removeUnusedAssets(rest: RestFn, sceneId: string, baseRevision: number, dryRun = false): Promise<{ removed: string[]; applied: boolean }> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/library/remove-unused`;
  return requireOk<{ removed: string[]; applied: boolean }>(await callRest<unknown>(rest, path, { method: "POST", body: { baseRevision, dryRun } }), path, (r) => Array.isArray(r.removed));
}

/** PUT /scenes/{id}/thumbnail (PR14): a small PNG of the scene at a revision. */
export async function putThumbnail(rest: RestFn, sceneId: string, revision: number, png: string): Promise<void> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/thumbnail`;
  requireOk<unknown>(await callRest<unknown>(rest, path, { method: "PUT", body: { revision, png } }), path, () => true);
}

/** GET /scenes/{id}/thumbnail: the stored PNG as base64, or null when there is none yet. */
export async function getThumbnail(rest: RestFn, sceneId: string): Promise<{ revision: number; png: string } | null> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/thumbnail`;
  try {
    return requireOk<{ revision: number; png: string }>(await callRest<unknown>(rest, path), path, (r) => typeof r.png === "string");
  } catch (err) {
    if (err instanceof ApiError && err.code === "THUMBNAIL_NOT_FOUND") return null;
    throw err;
  }
}

/** The curve settings (PR28): a tube along a centripetal Catmull-Rom spline, or a lathe (x = radius, y = height). */
export interface CurveParams {
  kind: "tube" | "lathe";
  points: number[][];
  closed: boolean;
  interpolation: "centripetal";
  radius?: number;
  radialSegments?: number;
  tubularSegments?: number;
  segments?: number;
  angle?: number;
}

/**
 * POST /scenes/{id}/curves: create a curve part (omit `id`) or regenerate one (`id`). One revision, one history
 * entry. The gateway validates and writes the mesh; SPEC_INVALID arrives as an ApiError.
 */
export async function makeCurve(
  rest: RestFn,
  sceneId: string,
  body: { baseRevision: number; curve: CurveParams; id?: string; name?: string; transform?: unknown },
): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/curves`;
  return requireOk<SceneEnvelope>(await callRest<unknown>(rest, path, { method: "POST", body }), path, isSceneEnvelopeRecord);
}

/**
 * POST /scenes/{id}/rigs (PR30): rig a shape or part, or regenerate a rig. The gateway weights the mesh, writes a
 * skinned GLB (with the clips) and turns the node into a locked `model`; one revision, one history entry.
 * Errors arrive as ApiError codes: RIG_INVALID, RIG_TOO_LARGE, BAKE_INVALID, REVISION_CONFLICT.
 */
export async function makeRig(
  rest: RestFn,
  sceneId: string,
  body: { baseRevision: number; id: string; mesh: BakeMeshBody; rig: unknown },
): Promise<SceneEnvelope> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/rigs`;
  return requireOk<SceneEnvelope>(await callRest<unknown>(rest, path, { method: "POST", body }), path, isSceneEnvelopeRecord);
}

export async function saveRender(rest: RestFn, sceneId: string, revision: number, png: string): Promise<{path:string;filename:string}> {
  const path = `/scenes/${encodeURIComponent(sceneId)}/renders`;
  const payload = await callRest(rest, path, { method: "POST", body: { revision, png } });
  return requireOk(payload, path, record => typeof record.path === "string" && typeof record.filename === "string");
}
