import { Checkbox } from "@hermes/plugin-sdk";
// src/io/ImportDialog.tsx — the import dialog (Stage 5, PR5).
//
// Title "Import a model". Two doors in one dialog (ui-design-first-draft
// §"Import has two doors in one dialog"): the folder door (hidden when
// ctx.files?.folders is missing — show noFilesDoor, never call
// requestFolder) and the backend-path door (always present). The folder
// listing is one level, .glb/.gltf only (isImportableName); a chosen
// file is stat -> readDataUrl -> base64-decode -> POST imports with
// { upload: { filename, contentType, bytes }, baseRevision }. The
// sourceKey and gatewayActivationEpoch() are captured before stat and
// re-checked before the POST; a change discards the bytes. The dialog
// stays open on failure (inline mapped sentence) and closes on success,
// selecting the new model node and framing it when drawable.
//
// Plain HTML dialog (div[role=dialog]) — the SDK Dialog is a compound
// Radix component and stays plain HTML in 0.1.0 (audit exception).

import { useEffect, useRef, useState } from "react";
import { gatewayActivationEpoch } from "@hermes/plugin-sdk";
import { Button, GlyphSpinner, Input } from "@hermes/plugin-sdk";
import type { RestFn } from "../api";
import { ApiError, importImage, importScene } from "../api";
import { SLOT_COLOR_SPACE } from "../scene/textures";
import type { MapSlot } from "../scene/textures";
import { ImageResizeError, planImageResize, resizeImage } from "./imageResize";
import type { ResizePlan } from "./imageResize";
import { COPY, toastForCode } from "../copy";
import {
  MAX_MTL_BYTES,
  contentTypeFor,
  dataUrlToBytes,
  encodedLengthOk,
  findMtlEntry,
  isImageName,
  isImportableName,
  isObjName,
  mapFilesError,
  objMtlName,
} from "./importFlow";
import type { FilesDoor, ImportFileEntry, ImportFolder } from "./importFlow";
import type { GizmoModeStore } from "../gizmos/gizmoMode";
import type { SelectionStore } from "../state/selection";
import type { SceneEnvelope, SceneSpec } from "../types";

export interface ImportDialogProps {
  rest: RestFn;
  scene: SceneSpec;
  sourceKey: string;
  /** Null in the Webapp (no ctx.files): the folder block hides. */
  files: FilesDoor | null;
  selection: SelectionStore;
  gizmoMode: GizmoModeStore;
  onClose: () => void;
  /**
   * Pick a texture image for one slot of a material (PR15) instead of
   * importing a model: the same two doors, PNG and JPEG only, and the pick
   * lands on the material in one revision.
   */
  mapTarget?: { materialId: string; slot: MapSlot };
  /** A model file dropped on the editor: imported once, as soon as the dialog opens. */
  droppedFile?: File;
}

interface ImageJob { signature: string; scope: string; epoch: number; sequence: number }
interface ResizeReview { bytes: Uint8Array; filename: string; side: number; plan: ResizePlan; job: ImageJob }

type DoorState = "loading" | "noDoor" | "empty" | "ready" | "again";

export function ImportDialog({
  rest,
  scene,
  sourceKey,
  files,
  selection,
  gizmoMode,
  onClose,
  mapTarget,
  droppedFile,
}: ImportDialogProps) {
  const isMap = mapTarget !== undefined;
  const [door, setDoor] = useState<DoorState>("loading");
  const [folder, setFolder] = useState<ImportFolder | null>(null);
  const [entries, setEntries] = useState<ImportFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [doorMessage, setDoorMessage] = useState<string | null>(null);
  const [pathValue, setPathValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockedModel, setLockedModel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [resizeSide, setResizeSide] = useState(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const [resizePosting, setResizePosting] = useState(false);
  const postingSequence = useRef<number | null>(null);
  const [resizeReview, setResizeReview] = useState<ResizeReview | null>(null);
  const scope = JSON.stringify([sourceKey, scene.id, mapTarget?.materialId, mapTarget?.slot, gatewayActivationEpoch()]);
  const signature = JSON.stringify([scope, scene.revision]);
  const currentScope = useRef(scope); currentScope.current = scope;
  const postingScope = useRef<string | null>(null);
  const currentSignature = useRef(signature); currentSignature.current = signature;
  const alive = useRef(true), imageSequence = useRef(0), resizeAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; imageSequence.current++; resizeAbort.current?.abort(); };
  }, []);
  useEffect(() => {
    // A committed mutation may broadcast its new revision before its HTTP reply.
    // Preserve the consented in-flight request on the same surface; local work
    // still cancels on every revision change, and source changes always cancel.
    if (postingSequence.current === imageSequence.current && postingScope.current === scope) return;
    imageSequence.current++; resizeAbort.current?.abort(); postingSequence.current = null; postingScope.current = null;
    setResizePosting(false); setResizeReview(null); setBusy(false);
  }, [signature, scope]);

  function captureJob(): ImageJob {
    resizeAbort.current?.abort(); postingSequence.current = null; postingScope.current = null; setResizePosting(false); setResizeReview(null);
    return { signature, scope, epoch: gatewayActivationEpoch(), sequence: ++imageSequence.current };
  }
  function ownsJob(job: ImageJob): boolean { return alive.current && imageSequence.current === job.sequence; }
  function replyCurrent(job: ImageJob): boolean {
    return ownsJob(job) && currentScope.current === job.scope && gatewayActivationEpoch() === job.epoch;
  }
  function isCurrent(job: ImageJob): boolean { return replyCurrent(job) && currentSignature.current === job.signature; }
  function resultCurrent(job: ImageJob): boolean { return isCurrent(job) || (postingSequence.current === job.sequence && replyCurrent(job)); }
  function finishJob(job: ImageJob): void {
    if (!ownsJob(job)) return;
    postingSequence.current = null; postingScope.current = null; setResizePosting(false); setBusy(false);
  }
  function cancelResize(): void {
    if (postingSequence.current === imageSequence.current) return;
    imageSequence.current++; resizeAbort.current?.abort(); setResizeReview(null); setError(null); setBusy(false);
  }

  // --- folder door -----------------------------------------------------------
  useEffect(() => {
    if (!files) {
      setDoor("noDoor");
      return;
    }
    let cancelled = false;
    void files
      .folders()
      .then((grants) => {
        if (cancelled) return;
        if (grants.length === 0) {
          setDoor("empty");
          return;
        }
        setFolder(grants[0]);
        void loadList(grants[0]);
      })
      .catch(() => {
        if (!cancelled) setDoor("noDoor");
      });
    return () => {
      cancelled = true;
    };
    // files is stable per editor mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  async function loadList(nextFolder: ImportFolder): Promise<void> {
    if (!files) return;
    setDoorMessage(null);
    const result = await files.list(nextFolder.id);
    if (!result.ok) {
      const mapped = mapFilesError(result.error);
      if (mapped === "noFilesDoor") setDoor("noDoor");
      else if (mapped === "folderAgain") {
        setDoor("again");
        setDoorMessage(COPY.folderAgain);
      } else {
        setDoor("ready");
        setDoorMessage(
          result.message
            ? `${COPY.rejected} ${result.message}`
            : COPY.rejected,
        );
      }
      return;
    }
    setEntries(result.entries);
    setTruncated(result.truncated);
    setDoor("ready");
  }

  async function chooseFolder(): Promise<void> {
    if (!files) return;
    setDoorMessage(null);
    const result = await files.requestFolder();
    if (!result.ok) {
      if (result.error === "cancelled" || result.error === "canceled") {
        return; // Cancel: leave the path field, do not toast.
      }
      const mapped = mapFilesError(result.error);
      if (mapped === "noFilesDoor") setDoor("noDoor");
      else if (mapped === "folderAgain") {
        setDoor("again");
        setDoorMessage(COPY.folderAgain);
      } else {
        setError(
          result.message
            ? `${COPY.rejected} ${result.message}`
            : COPY.rejected,
        );
      }
      return;
    }
    if (!result.folder) return; // Cancelled with no folder: leave as is.
    setFolder(result.folder);
    await loadList(result.folder);
  }

  // --- import ------------------------------------------------------------------
  /** Post to the model door or, for a texture pick, the image door. */
  async function send(extra: Record<string, unknown>, job: ImageJob): Promise<SceneEnvelope> {
    if (!isCurrent(job)) throw new DOMException("Aborted", "AbortError");
    postingSequence.current = job.sequence; postingScope.current = job.scope; setResizePosting(true);
    if (mapTarget) {
      return importImage(rest, scene.id, {
        materialId: mapTarget.materialId,
        slot: mapTarget.slot,
        baseRevision: scene.revision,
        ...extra,
      });
    }
    return importScene(rest, scene.id, {
      baseRevision: scene.revision,
      explode: !lockedModel,
      ...extra,
    });
  }

  function handleImported(envelope: SceneEnvelope): void {
    if (isMap) {
      onClose();
      return;
    }
    const before = new Set(scene.nodes.map((n) => n.id));
    const created = envelope.nodes.filter((n) => !before.has(n.id));
    const model = created.find((n) => n.kind === "model") ?? created[0];
    if (model) {
      selection.select(model.id);
      const asset = envelope.assets.find((a) => a.id === model.modelAssetId);
      if (asset?.stats.drawable) gizmoMode.requestFrame();
    }
    onClose();
  }

  function importErrorMessage(err: unknown): string {
    if (err instanceof ImageResizeError) return err.message;
    if (err instanceof ApiError) {
      // A refused upload on this door is the desktop size limit, not the
      // 256 MiB store cap: the pre-check already refused anything over
      // the encoded cap, so IMPORT_TOO_LARGE here means the upload
      // itself did not fit through the desktop door.
      if (isMap) {
        // The gateway's sentences for an image already say what to do.
        if (err.code === "IMPORT_FORMAT") return COPY.mapFormat;
        if (
          err.code === "TEXTURE_NO_UV" ||
          err.code === "IMPORT_TOO_COMPLEX" ||
          err.code === "IMPORT_TOO_LARGE"
        ) {
          return err.message.replace(/^[A-Z_]+: /, "");
        }
      }
      if (err.code === "IMPORT_TOO_LARGE") return COPY.desktopCap;
      if (err.code === "SPEC_INVALID" && err.message.includes("explode: false")) return err.message;
      return toastForCode(err.code, {
        context: "edit",
        serverMessage: err.message,
        reason: err.reason,
      }).message;
    }
    return COPY.rejected;
  }

  async function importFromFolder(entry: ImportFileEntry): Promise<void> {
    if (!files || !folder || busy) return;
    setBusy(true);
    setError(null);
    const captured = captureJob();
    try {
      const stat = await files.stat(folder.id, entry.path);
      if (!isCurrent(captured)) return;
      if (!stat.ok) {
        const mapped = mapFilesError(stat.error);
        if (mapped === "noFilesDoor") setDoor("noDoor");
        else if (mapped === "folderAgain") {
          setDoor("again");
          setDoorMessage(COPY.folderAgain);
        } else {
          setError(
            stat.message
              ? `${COPY.rejected} ${stat.message}`
              : COPY.rejected,
          );
        }
        return;
      }
      if (!stat.exists) {
        setError(COPY.importNotFound);
        return;
      }
      const size = stat.size ?? 0;
      if (!encodedLengthOk(size)) {
        setError(COPY.desktopCap);
        return;
      }
      if (
        !isCurrent(captured)
      ) {
        return; // Source changed mid-read: discard, do not post.
      }
      const read = await files.readDataUrl(folder.id, entry.path);
      if (!isCurrent(captured)) return;
      if (!read.ok) {
        if (read.error === "too-large") {
          setError(COPY.desktopCap);
        } else if (read.error === "sensitive-file") {
          setError(COPY.pathDenied);
        } else {
          const mapped = mapFilesError(read.error);
          if (mapped === "folderAgain") {
            setDoor("again");
            setDoorMessage(COPY.folderAgain);
          } else {
            setError(
              read.message
                ? `${COPY.rejected} ${read.message}`
                : COPY.rejected,
            );
          }
        }
        return;
      }
      const bytes = dataUrlToBytes(read.url);
      if (
        !isCurrent(captured)
      ) {
        return; // Source changed: discard the bytes, do not post.
      }
      // An OBJ's material file travels beside it as a sidecar (PR12): the
      // `.mtl` it names, from the same granted folder. A missing, oversized
      // or unreadable one is skipped, and the import keeps the default
      // colour. The gateway never reads a texture the `.mtl` points at.
      const sidecars = !isMap && isObjName(entry.name)
        ? await readMtlSidecar(files, folder.id, bytes)
        : [];
      if (
        !isCurrent(captured)
      ) {
        return;
      }
      const upload: Record<string, unknown> = {
        filename: entry.name,
        contentType: contentTypeFor(entry.name),
        bytes,
      };
      if (sidecars.length > 0) upload.sidecars = sidecars;
      if (isMap) await reviewOrImportImage(bytes, entry.name, captured);
      else {
        const envelope = await send({ upload }, captured);
        if (resultCurrent(captured)) handleImported(envelope);
      }
    } catch (err) {
      if (resultCurrent(captured)) setError(importErrorMessage(err));
    } finally {
      finishJob(captured);
    }
  }

  async function readMtlSidecar(
    door: FilesDoor,
    folderId: string,
    objBytes: Uint8Array,
  ): Promise<Array<{ filename: string; bytes: Uint8Array }>> {
    const wanted = objMtlName(objBytes);
    const match = wanted ? findMtlEntry(entries, wanted) : null;
    if (!wanted || !match) return [];
    try {
      const stat = await door.stat(folderId, match.path);
      if (!stat.ok || !stat.exists || (stat.size ?? 0) > MAX_MTL_BYTES) return [];
      const read = await door.readDataUrl(folderId, match.path);
      if (!read.ok) return [];
      // The gateway matches by the name the OBJ wrote, not the listing's case.
      return [{ filename: wanted, bytes: dataUrlToBytes(read.url) }];
    } catch {
      return [];
    }
  }

  async function importFromPath(): Promise<void> {
    const backendPath = pathValue.trim();
    if (!backendPath || busy || resizeReview) return;
    setBusy(true);
    setError(null);
    const captured = captureJob();
    try {
      if (
        !isCurrent(captured)
      ) {
        return;
      }
      const envelope = await send({ backendPath }, captured);
      if (resultCurrent(captured)) handleImported(envelope);
    } catch (err) {
      if (resultCurrent(captured)) setError(importErrorMessage(err));
    } finally {
      finishJob(captured);
    }
  }

  async function reviewOrImportImage(bytes: Uint8Array, filename: string, job: ImageJob): Promise<void> {
    if (!mapTarget || !isCurrent(job)) return;
    if (!isImageName(filename)) throw new ImageResizeError("IMPORT_FORMAT", COPY.resizeFormat);
    if (resizeSide > 0) {
      const plan = planImageResize(bytes, resizeSide, mapTarget.slot);
      if (isCurrent(job)) setResizeReview({ bytes, filename, side: resizeSide, plan, job });
    } else {
      const envelope = await send({ upload: { filename, contentType: contentTypeFor(filename), bytes } }, job);
      if (resultCurrent(job)) handleImported(envelope);
    }
  }
  async function importLocalImage(file: File): Promise<void> {
    if (busy) return;
    const captured = captureJob(); setBusy(true); setError(null);
    try {
      if (!isImageName(file.name)) throw new ImageResizeError("IMPORT_FORMAT", COPY.mapFormat);
      if (!encodedLengthOk(file.size)) throw new ImageResizeError("IMPORT_TOO_LARGE", COPY.desktopCap);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (isCurrent(captured)) await reviewOrImportImage(bytes, file.name, captured);
    } catch (err) { if (resultCurrent(captured)) setError(importErrorMessage(err)); }
    finally { finishJob(captured); }
  }
  /** The native file chooser: any .glb/.gltf/.obj/.stl/.ply on this computer, no folder grant needed. */
  async function importLocalModel(file: File): Promise<void> {
    if (busy) return;
    const captured = captureJob(); setBusy(true); setError(null);
    try {
      if (!isImportableName(file.name)) { setError(COPY.rejected); return; }
      if (!encodedLengthOk(file.size)) { setError(COPY.desktopCap); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isCurrent(captured)) return;
      const envelope = await send({ upload: { filename: file.name, contentType: contentTypeFor(file.name), bytes } }, captured);
      if (resultCurrent(captured)) handleImported(envelope);
    } catch (err) { if (resultCurrent(captured)) setError(importErrorMessage(err)); }
    finally { finishJob(captured); }
  }
  const droppedStarted = useRef(false);
  useEffect(() => {
    if (!droppedFile || isMap || droppedStarted.current) return;
    droppedStarted.current = true;
    void importLocalModel(droppedFile);
    // Runs once for the file the dialog opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function applyResize(): Promise<void> {
    if (busy || !resizeReview || !mapTarget) return;
    if (!isCurrent(resizeReview.job)) { cancelResize(); return; }
    const review = resizeReview, controller = new AbortController();
    resizeAbort.current = controller; setBusy(true); setError(null);
    try {
      const output = await resizeImage(review.bytes, review.side, mapTarget.slot, controller.signal, () => isCurrent(review.job));
      if (!isCurrent(review.job)) return;
      const filename = review.filename.replace(/\.(png|jpe?g)$/i, "") + `-${output.plan.width}x${output.plan.height}.png`;
      const envelope = await send({ upload: { filename, contentType: "image/png", bytes: output.bytes } }, review.job);
      if (resultCurrent(review.job)) handleImported(envelope);
    } catch (err) {
      if (resultCurrent(review.job) && !(err instanceof DOMException && err.name === "AbortError")) setError(importErrorMessage(err));
    } finally {
      if (resizeAbort.current === controller) resizeAbort.current = null;
      if (ownsJob(review.job)) { finishJob(review.job); if (!isCurrent(review.job)) setResizeReview(null); }
    }
  }

  const importable = entries.filter((e) =>
    isMap ? isImageName(e.name) : isImportableName(e.name),
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isMap ? COPY.mapTitle : "Import a model"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="p3d-dialog"
      style={{ width: 440, maxHeight: "86%", overflow: "auto", fontSize: 13 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span className="p3d-dialog-title" style={{ margin: 0 }}>{isMap ? COPY.mapTitle : "Import a model"}</span>
        <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close">
          ✕
        </Button>
      </div>
      <p className="p3d-muted" style={{ margin: "0 0 12px", lineHeight: 1.5 }}>
        {isMap ? COPY.mapIntro : COPY.importIntro}
      </p>

      {isMap && <div style={{ marginBottom: 16 }}>
        <button type="button" className="p3d-btn p3d-btn--primary" autoFocus disabled={busy} onClick={() => imageInput.current?.click()}>
          Choose an image file…
        </button>
        <input ref={imageInput} type="file" hidden accept=".png,.jpg,.jpeg" aria-label={COPY.resizeLocalPick} disabled={busy} onChange={(event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
          if (file) void importLocalImage(file);
        }} />
        <p className="p3d-help" style={{ margin: "8px 0 12px" }}>Hermes or your computer may ask you to allow file access before the picker opens. Approve the request to choose an image.</p>
        <label>{COPY.resizeLabel}
          <select className="p3d-select" aria-label={COPY.resizeLabel} disabled={busy} value={resizeSide} onChange={(event) => { cancelResize(); setResizeSide(Number(event.target.value)); }}>
            <option value={0}>{COPY.resizeOriginal}</option>
            {[512, 1024, 2048, 4096].map((side) => <option key={side} value={side}>{side} × {side}</option>)}
          </select>
        </label>
        {resizeSide > 0 && <p className="p3d-help">{COPY.resizeHelp}</p>}
      </div>}
      {resizeReview && <div role="group" aria-label={COPY.resizeReview} style={{ marginBottom: 12 }}>
        <p>{resizeReview.plan.source.width} × {resizeReview.plan.source.height} → {resizeReview.plan.width} × {resizeReview.plan.height}</p>
        <p>{mapTarget && SLOT_COLOR_SPACE[mapTarget.slot] === "linear" ? COPY.resizeData : COPY.resizeColour}</p>
        <p className="p3d-help">{COPY.resizeDestinationCap}</p>
        <Button disabled={busy} onClick={() => void applyResize()}>{COPY.resizeApply}</Button>
        <Button variant="ghost" disabled={resizePosting} onClick={cancelResize}>{COPY.resizeCancel}</Button>
        {resizePosting && <p role="status">{COPY.resizeSaving}</p>}
      </div>}

      {!isMap && (
        <div style={{ marginBottom: 12 }}>
          <label className="p3d-btn p3d-btn--primary" style={{ display: "inline-flex", cursor: busy ? "default" : "pointer" }}>
            Choose a file…
            <input type="file" hidden accept=".glb,.gltf,.obj,.stl,.ply" aria-label="Choose a model file" disabled={busy} onChange={(event) => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
              if (file) void importLocalModel(file);
            }} />
          </label>
          <span className="p3d-help" style={{ marginLeft: 8 }}>GLB, glTF, OBJ, STL or PLY</span>
        </div>
      )}

      {!isMap && <label style={{ display: "flex", alignItems: "flex-start", gap: 8, margin: "0 0 14px", lineHeight: 1.4 }}><Checkbox checked={lockedModel} onCheckedChange={(checked) => setLockedModel(checked === true)} /> <span>{COPY.keepLocked}</span></label>}

      {isMap && <p style={{ fontWeight: 600, margin: "0 0 8px" }}>Other ways to choose an image</p>}
      {isMap && <p className="p3d-help" style={{ margin: "0 0 8px" }}>Use an approved folder below, or enter a path on the Hermes computer. Folder access can be managed under Capabilities → Plugins → Folder access.</p>}
      {door === "noDoor" && (
        <p style={{ margin: "0 0 12px" }}>{COPY.noFilesDoor}</p>
      )}
      {door === "loading" && (
        <p style={{ margin: "0 0 12px" }}>
          <GlyphSpinner ariaLabel="Loading folders" /> Checking folders…
        </p>
      )}
      {(door === "empty" || door === "again") && (
        <div style={{ marginBottom: 12 }}>
          {doorMessage && <p style={{ margin: "0 0 8px" }}>{doorMessage}</p>}
          <Button variant="outline" onClick={() => void chooseFolder()}>
            Choose a folder
          </Button>
        </div>
      )}
      {door === "ready" && folder && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {folder.name}
          </div>
          {doorMessage && <p style={{ margin: "0 0 8px" }}>{doorMessage}</p>}
          <div
            style={{
              maxHeight: 180,
              overflow: "auto",
              border: "1px solid var(--ui-stroke-secondary, #888)",
            }}
          >
            {importable.length === 0 && (
              <div style={{ padding: "8px 10px", opacity: 0.7 }}>
                {isMap ? COPY.mapNoFiles : COPY.importNoFiles}
              </div>
            )}
            {importable.map((entry) => (
              <button
                key={entry.path}
                type="button"
                disabled={busy}
                onClick={() => void importFromFolder(entry)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 10px",
                  border: "none",
                  borderBottom:
                    "1px solid var(--ui-stroke-secondary, #888)",
                  background: "transparent",
                  cursor: busy ? "default" : "pointer",
                }}
              >
                {entry.name}
              </button>
            ))}
          </div>
          {truncated && (
            <p style={{ margin: "8px 0 0" }}>
              This folder has more files than Plastis3D listed. Use a path.
            </p>
          )}
        </div>
      )}

      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 12, opacity: 0.7 }}>
          Path on the Hermes computer
        </span>
        <span style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <Input
            value={pathValue}
            autoFocus={!isMap}
            aria-label="Path on the Hermes computer"
            placeholder={isMap ? "/path/to/picture.png" : "/path/to/model.glb"}
            onChange={(e) => setPathValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void importFromPath();
            }}
          />
          <Button
            variant="outline"
            disabled={busy || resizeReview !== null || pathValue.trim() === ""}
            onClick={() => void importFromPath()}
          >
            {isMap ? COPY.mapUse : "Import path"}
          </Button>
        </span>
      </label>

      {busy && (
        <p style={{ margin: "0 0 8px" }}>
          <GlyphSpinner ariaLabel="Importing" /> Importing…
        </p>
      )}
      {error !== null && (
        <p style={{ margin: "0 0 8px" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
