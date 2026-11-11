// Explicit texture resize. Header inspection is pure and precedes any bitmap allocation.
import { COPY } from "../copy";
import { encodedLengthOk } from "./importFlow";
import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, SLOT_COLOR_SPACE } from "../scene/textures";
import type { MapSlot } from "../scene/textures";

/** Transient resize-source budget; destination/cache budgets remain unchanged. */
export const MAX_RESIZE_SIDE = 8192;
export const MAX_RESIZE_PIXELS = 32_000_000;
const MAX_HEADER_BYTES = 1024 * 1024;
export interface ImageHeader { format: "png" | "jpeg"; width: number; height: number }
export interface ResizePlan { source: ImageHeader; width: number; height: number }
export class ImageResizeError extends Error {
  constructor(readonly code: "IMPORT_FORMAT" | "IMPORT_TOO_COMPLEX" | "IMPORT_TOO_LARGE", message: string) { super(message); this.name = "ImageResizeError"; }
}
const formatError = () => new ImageResizeError("IMPORT_FORMAT", COPY.resizeFormat);

function orientation(bytes: Uint8Array): number {
  if (bytes.length < 8) throw formatError();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = view.getUint16(0) === 0x4949;
  if (!little && view.getUint16(0) !== 0x4d4d) throw formatError();
  if (view.getUint16(2, little) !== 42) throw formatError();
  const offset = view.getUint32(4, little);
  if (offset > bytes.length - 2) throw formatError();
  const count = view.getUint16(offset, little);
  if (count > 256 || offset + 2 + count * 12 > bytes.length) throw formatError();
  for (let i = 0; i < count; i++) {
    const at = offset + 2 + i * 12;
    if (view.getUint16(at, little) === 0x112) {
      if (view.getUint16(at + 2, little) !== 3 || view.getUint32(at + 4, little) !== 1) throw formatError();
      const value = view.getUint16(at + 8, little);
      if (value < 1 || value > 8) throw formatError();
      return value;
    }
  }
  return 1;
}

/** Header dimensions in the browser's from-image orientation; no pixel decoder. */
export function inspectResizeSource(bytes: Uint8Array): ImageHeader {
  if (!encodedLengthOk(bytes.byteLength)) throw new ImageResizeError("IMPORT_TOO_LARGE", COPY.desktopCap);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0, turn = 1, format: ImageHeader["format"];
  if (bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) {
    format = "png";
    if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw formatError();
    // Validate IHDR CRC before trusting the dimensions.
    let crc = 0xffffffff;
    for (let i = 12; i < 29; i++) { crc ^= bytes[i]; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(29)) throw formatError();
    width = view.getUint32(16); height = view.getUint32(20);
    const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] || bytes[27] || bytes[28] > 1) throw formatError();
    let at = 33, chunks = 0, ended = false;
    while (at + 12 <= bytes.length) {
      if (++chunks > 10000) throw formatError();
      const size = view.getUint32(at), kind = view.getUint32(at + 4);
      if (size > bytes.length - at - 12) throw formatError();
      if (kind === 0x6163544c) throw formatError(); // Animated PNG is not a still-image resize.
      if (kind === 0x65584966) { if (size > MAX_HEADER_BYTES) throw formatError(); turn = orientation(bytes.subarray(at + 8, at + 8 + size)); }
      at += size + 12;
      if (kind === 0x49454e44) { if (size !== 0) throw formatError(); ended = true; break; }
    }
    if (!ended || at !== bytes.length) throw formatError();
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    format = "jpeg";
    let at = 2;
    while (at + 4 <= bytes.length && at < MAX_HEADER_BYTES) {
      if (bytes[at++] !== 255) throw formatError();
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (at + 2 > bytes.length) throw formatError();
      const size = view.getUint16(at);
      if (size < 2 || size > bytes.length - at || at + size > MAX_HEADER_BYTES) throw formatError();
      if (marker === 0xe1 && size >= 8 && [69, 120, 105, 102, 0, 0].every((v, i) => bytes[at + 2 + i] === v)) turn = orientation(bytes.subarray(at + 8, at + size));
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        if (![0xc0, 0xc1, 0xc2].includes(marker) || size < 8 || bytes[at + 2] !== 8 || width) throw formatError();
        height = view.getUint16(at + 3); width = view.getUint16(at + 5);
      }
      at += size;
    }
    if (at >= MAX_HEADER_BYTES) throw formatError();
  } else throw formatError();
  if (width < 1 || height < 1) throw formatError();
  if (width > MAX_RESIZE_SIDE || height > MAX_RESIZE_SIDE || width * height > MAX_RESIZE_PIXELS) throw new ImageResizeError("IMPORT_TOO_COMPLEX", COPY.resizeSourceCap);
  if (turn >= 5) [width, height] = [height, width];
  return { format, width, height };
}

export function planImageResize(bytes: Uint8Array, side: number, slot?: MapSlot): ResizePlan {
  const source = inspectResizeSource(bytes);
  if (source.format === "png" && bytes[24] === 16 && slot && SLOT_COLOR_SPACE[slot] === "linear") throw new ImageResizeError("IMPORT_FORMAT", COPY.resizePrecisionData);
  if (!Number.isInteger(side) || side < 1 || side > MAX_IMAGE_SIDE) throw new ImageResizeError("IMPORT_TOO_COMPLEX", COPY.resizeDestinationCap);
  const scale = Math.min(1, side / source.width, side / source.height);
  const width = Math.max(1, Math.round(source.width * scale)), height = Math.max(1, Math.round(source.height * scale));
  if (width * height > MAX_IMAGE_PIXELS) throw new ImageResizeError("IMPORT_TOO_COMPLEX", COPY.resizeDestinationCap);
  return { source, width, height };
}

const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException("Aborted", "AbortError"); };

/** Called only after explicit review. Data maps refuse non-opaque pixels; bumps normalize after filtering. */
export async function resizeImage(bytes: Uint8Array, side: number, slot: MapSlot, signal?: AbortSignal, active?: () => boolean): Promise<{ bytes: Uint8Array; plan: ResizePlan }> {
  const check = () => { checkAbort(signal); if (active && !active()) throw new DOMException("Aborted", "AbortError"); };
  const plan = planImageResize(bytes, side, slot); // Validate before invoking a native pixel decoder.
  check();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([Uint8Array.from(bytes).buffer], { type: plan.source.format === "png" ? "image/png" : "image/jpeg" }), {
      imageOrientation: "from-image", premultiplyAlpha: "none", colorSpaceConversion: SLOT_COLOR_SPACE[slot] === "linear" ? "none" : "default",
    });
  } catch { check(); throw formatError(); }
  let canvas: HTMLCanvasElement | undefined;
  try {
    check();
    canvas = document.createElement("canvas");
    if (bitmap.width !== plan.source.width || bitmap.height !== plan.source.height) throw formatError();
    canvas.width = plan.width; canvas.height = plan.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: SLOT_COLOR_SPACE[slot] === "linear" });
    if (!ctx) throw formatError();
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
    bitmap.close();
    if (SLOT_COLOR_SPACE[slot] === "linear") {
      const image = ctx.getImageData(0, 0, plan.width, plan.height), data = image.data;
      let sliceStart = performance.now();
      for (let start = 0; start < data.length; start += 65536 * 4) {
        check();
        for (let i = start; i < Math.min(data.length, start + 65536 * 4); i += 4) {
          if ((i & 4095) === 0 && performance.now() - sliceStart >= 8) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0)); check(); sliceStart = performance.now();
          }
          if (data[i + 3] !== 255) throw new ImageResizeError("IMPORT_FORMAT", COPY.resizeOpaqueData);
          if (slot === "normalMap") {
            const x = data[i] / 127.5 - 1, y = data[i + 1] / 127.5 - 1, z = data[i + 2] / 127.5 - 1, length = Math.hypot(x, y, z);
            data[i] = Math.round(((length > 1e-8 ? x / length : 0) + 1) * 127.5);
            data[i + 1] = Math.round(((length > 1e-8 ? y / length : 0) + 1) * 127.5);
            data[i + 2] = Math.round(((length > 1e-8 ? z / length : 1) + 1) * 127.5);
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      ctx.putImageData(image, 0, 0);
    }
    check();
    const target = canvas;
    const blob = await new Promise<Blob>((resolve, reject) => target.toBlob((value) => value ? resolve(value) : reject(formatError()), "image/png"));
    check();
    if (!encodedLengthOk(blob.size)) throw new ImageResizeError("IMPORT_TOO_LARGE", COPY.resizeOutputCap);
    const output = new Uint8Array(await blob.arrayBuffer());
    check();
    return { bytes: output, plan };
  } catch (error) {
    if (error instanceof ImageResizeError || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw formatError();
  } finally { bitmap.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
}
