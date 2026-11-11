// src/io/importFlow.ts — pure import helpers (Stage 5, PR5).
//
// The import dialog (src/io/ImportDialog.tsx, agent A) uses these;
// the mock host (tests/harness/mock-host.ts, agent B) fakes the door
// behind the same shapes. No SDK import, no DOM: Vitest tests this
// file directly.
//
// Door shapes mirror the pinned v0.23.0 host source
// (~/.hermes/hermes-agent/apps/desktop/src/contrib/plugin-files.ts):
// folders() returns an array (not an envelope); requestFolder, list,
// stat, and readDataUrl return { ok, error } envelopes. No member
// throws. readDataUrl caps at a 16 MiB data URL; readText is NOT used
// (4 MiB cap, and it returns `binary` for a GLB).

/** One granted folder (opaque id; `path` is display-only). */
export interface ImportFolder {
  id: string;
  name: string;
  path: string;
}

export interface ImportFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export type FilesResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; message: string };

/** The ctx.files subset the import dialog uses (structural type). */
export interface FilesDoor {
  folders: () => Promise<ImportFolder[]>;
  requestFolder: () => Promise<
    FilesResult<{ folder: ImportFolder | null }>
  >;
  list: (
    folder: string,
    path?: string,
  ) => Promise<FilesResult<{ entries: ImportFileEntry[]; truncated: boolean }>>;
  stat: (
    folder: string,
    path: string,
  ) => Promise<
    FilesResult<{
      exists: boolean;
      isDirectory?: boolean;
      mtimeMs?: number;
      size?: number;
    }>
  >;
  readDataUrl: (
    folder: string,
    path: string,
  ) => Promise<FilesResult<{ url: string }>>;
}

/** The ctx.files data-URL cap (PR1 §4.8: 16 MiB, host-enforced). */
export const DATA_URL_CAP_BYTES = 16 * 1024 * 1024;

/** The largest ctx.rest upload that round-trips (PR1 §4.8: 16 MiB). */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/**
 * True when a file of `size` bytes may be read: the raw size must fit
 * the upload cap AND the base64-encoded data URL (ceil(size*4/3) + 64
 * for the `data:` prefix) must fit the 16 MiB data-URL cap. A 12 MiB
 * file is already at the limit before the prefix.
 */
export function encodedLengthOk(size: number): boolean {
  if (!Number.isFinite(size) || size < 0) return false;
  if (size > MAX_UPLOAD_BYTES) return false;
  return Math.ceil((size * 4) / 3) + 64 <= DATA_URL_CAP_BYTES;
}

const DENYLISTED_NAMES: ReadonlySet<string> = new Set([
  "credentials.json",
  "auth.json",
  ".env",
]);

/** The model extensions the import dialog lists (PR12 added the last three). */
export const IMPORT_EXTENSIONS: readonly string[] = [".glb", ".gltf", ".obj", ".stl", ".ply", ".splat"];

/** The largest `.mtl` the dialog sends beside an OBJ (the gateway refuses more). */
export const MAX_MTL_BYTES = 1024 * 1024;

/**
 * Whether a listing entry is shown in the import dialog: `.glb`, `.gltf`,
 * `.obj`, `.stl` and `.ply` files (extension matched case-insensitively);
 * dotfiles, denylisted names, and `.pem`/`.key` files are skipped.
 * Directories are never shown (the listing is one level).
 */
export function isImportableName(name: string): boolean {
  if (name.startsWith(".")) return false;
  const lower = name.toLowerCase();
  if (DENYLISTED_NAMES.has(lower)) return false;
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return false;
  return IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The media type sent with an upload (the gateway reads the extension, not this). */
export function contentTypeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".glb")) return "model/gltf-binary";
  if (lower.endsWith(".gltf")) return "model/gltf+json";
  if (lower.endsWith(".obj")) return "model/obj";
  if (lower.endsWith(".stl")) return "model/stl";
  if (lower.endsWith(".ply")) return "application/octet-stream";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

/** The image extensions the texture picker lists (PR15). */
export const IMAGE_EXTENSIONS: readonly string[] = [".png", ".jpg", ".jpeg"];

/**
 * Whether a listing entry is shown when picking a texture image: PNG and JPEG
 * (case-insensitive); dotfiles, denylisted names and key material are skipped.
 */
export function isImageName(name: string): boolean {
  if (name.startsWith(".")) return false;
  const lower = name.toLowerCase();
  if (DENYLISTED_NAMES.has(lower)) return false;
  if (lower.endsWith(".pem") || lower.endsWith(".key")) return false;
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True for an `.obj` file name (the only format that reads a `.mtl`). */
export function isObjName(name: string): boolean {
  return name.toLowerCase().endsWith(".obj");
}

/**
 * The first `mtllib` name an OBJ file declares, or null. Reads at most the
 * first MiB as text; the name is the rest of the line after `mtllib`, with
 * any directory part dropped (the gateway matches uploads by bare file name).
 */
export function objMtlName(bytes: Uint8Array): string | null {
  const head = bytes.subarray(0, MAX_MTL_BYTES);
  let text = "";
  for (let i = 0; i < head.length; i += 8192) {
    text += String.fromCharCode(...head.subarray(i, i + 8192));
  }
  const match = /^[ \t]*mtllib[ \t]+([^\r\n]+)/im.exec(text);
  if (!match) return null;
  const name = match[1].trim().split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? name : null;
}

/**
 * The listing entry holding the `.mtl` an OBJ names: an exact name match
 * first, then a case-insensitive one. Only `.mtl` files qualify.
 */
export function findMtlEntry(
  entries: readonly ImportFileEntry[],
  mtlName: string,
): ImportFileEntry | null {
  if (!mtlName.toLowerCase().endsWith(".mtl")) return null;
  const files = entries.filter((e) => !e.isDirectory);
  return (
    files.find((e) => e.name === mtlName) ??
    files.find((e) => e.name.toLowerCase() === mtlName.toLowerCase()) ??
    null
  );
}

/** Base64 of raw bytes, in chunks so a large file does not blow the argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Map a ctx.files error token to the dialog state: `unavailable`
 * hides the folder block (`noFilesDoor`); `not-granted`,
 * `folder-missing`, and `folder-changed` offer the picker again
 * (`folderAgain`); anything else is a generic `rejected` file.
 */
export function mapFilesError(
  error: string,
): "noFilesDoor" | "folderAgain" | "rejected" {
  if (error === "unavailable") return "noFilesDoor";
  if (
    error === "not-granted" ||
    error === "folder-missing" ||
    error === "folder-changed"
  ) {
    return "folderAgain";
  }
  return "rejected";
}

/** Decode a data URL's base64 payload to bytes (ui-design snippet). */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
