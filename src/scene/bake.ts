// src/scene/bake.ts — encode an edit mesh for POST /scenes/{id}/bakes and the draft slot (PR24).
//
// The arrays travel as base64 little-endian typed arrays (D-EXT-03). Every typed array
// the browser builds on a supported platform is little-endian, so the bytes are sent as-is.
import { bytesToBase64 } from "../io/importFlow";
import type { EditMesh } from "./meshEdit";

export interface BakeMesh {
  positions: string;
  normals: string;
  uvs?: string;
  /** Vertex colours, RGBA float32 per vertex (COLOR_0). */
  colors?: string;
  indices: string;
}

const b64 = (array: Float32Array | Uint32Array): string =>
  bytesToBase64(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));

export function encodeMesh(mesh: EditMesh): BakeMesh {
  const out: BakeMesh = { positions: b64(mesh.positions), normals: b64(mesh.normals), indices: b64(mesh.indices) };
  if (mesh.uvs) out.uvs = b64(mesh.uvs);
  if (mesh.colors) out.colors = b64(mesh.colors);
  return out;
}

function bytesOf(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a draft's arrays. Returns null when anything about them is malformed. */
export function decodeMesh(mesh: Partial<BakeMesh> | null | undefined): EditMesh | null {
  try {
    if (!mesh || typeof mesh.positions !== "string" || typeof mesh.normals !== "string" || typeof mesh.indices !== "string") return null;
    const p = bytesOf(mesh.positions), n = bytesOf(mesh.normals), i = bytesOf(mesh.indices);
    if (p.length < 36 || i.length < 12 || p.length % 12 || n.length !== p.length || i.length % 12) return null; // at least one triangle
    const positions = new Float32Array(p.buffer, 0, p.length / 4);
    const normals = new Float32Array(n.buffer, 0, n.length / 4);
    const indices = new Uint32Array(i.buffer, 0, i.length / 4);
    let uvs: Float32Array | null = null;
    if (typeof mesh.uvs === "string") {
      const u = bytesOf(mesh.uvs);
      if (u.length !== (p.length / 12) * 8) return null;
      uvs = new Float32Array(u.buffer, 0, u.length / 4);
    }
    let colors: Float32Array | null = null;
    if (typeof mesh.colors === "string") {
      const c = bytesOf(mesh.colors);
      if (c.length !== (p.length / 12) * 16) return null;
      colors = new Float32Array(c.buffer, 0, c.length / 4);
    }
    const vertexCount = positions.length / 3;
    for (const index of indices) if (index >= vertexCount) return null;
    return { positions, normals, uvs, indices, colors };
  } catch {
    return null;
  }
}
