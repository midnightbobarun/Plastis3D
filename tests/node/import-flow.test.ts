// tests/node/import-flow.test.ts — pure import helpers (Tier 2, PR5).
//
// Covers src/io/importFlow.ts: the encoded-length pre-check, the
// listing filter, the content type, and the files-error mapping.
// The dialog and the mock host build on these; the full dialog flow
// is a Tier 4 test (tests/harness/import-dialog.spec.ts).
import { describe, expect, it } from "vitest";
import { encodeUploadBytes } from "../../src/api";
import {
  bytesToBase64,
  contentTypeFor,
  dataUrlToBytes,
  encodedLengthOk,
  findMtlEntry,
  isImportableName,
  mapFilesError,
  objMtlName,
} from "../../src/io/importFlow";

describe("encodedLengthOk", () => {
  it("accepts small files", () => {
    expect(encodedLengthOk(0)).toBe(true);
    expect(encodedLengthOk(1024)).toBe(true);
    expect(encodedLengthOk(1024 * 1024)).toBe(true);
  });

  it("refuses a 12 MiB file (already at the data-URL limit)", () => {
    // ceil(12 MiB * 4/3) + 64 = 16 MiB + 64 > 16 MiB.
    expect(encodedLengthOk(12 * 1024 * 1024)).toBe(false);
  });

  it("refuses anything over the 16 MiB upload cap", () => {
    expect(encodedLengthOk(17 * 1024 * 1024)).toBe(false);
    expect(encodedLengthOk(Number.NaN)).toBe(false);
    expect(encodedLengthOk(-1)).toBe(false);
  });
});

describe("isImportableName", () => {
  it("shows model files only", () => {
    expect(isImportableName("model.glb")).toBe(true);
    expect(isImportableName("model.gltf")).toBe(true);
    expect(isImportableName("MODEL.GLB")).toBe(true);
    expect(isImportableName("notes.txt")).toBe(false);
    expect(isImportableName("image.png")).toBe(false);
  });

  it("skips dotfiles, denylisted names, and key material", () => {
    expect(isImportableName(".hidden.glb")).toBe(false);
    expect(isImportableName("credentials.json")).toBe(false);
    expect(isImportableName("auth.json")).toBe(false);
    expect(isImportableName(".env")).toBe(false);
    expect(isImportableName("key.pem")).toBe(false);
    expect(isImportableName("id.key")).toBe(false);
  });
});

describe("contentTypeFor", () => {
  it("maps extensions to glTF media types", () => {
    expect(contentTypeFor("a.glb")).toBe("model/gltf-binary");
    expect(contentTypeFor("a.gltf")).toBe("model/gltf+json");
    expect(contentTypeFor("A.GLB")).toBe("model/gltf-binary");
  });
});

describe("mapFilesError", () => {
  it("maps the door errors to dialog states", () => {
    expect(mapFilesError("unavailable")).toBe("noFilesDoor");
    expect(mapFilesError("not-granted")).toBe("folderAgain");
    expect(mapFilesError("folder-missing")).toBe("folderAgain");
    expect(mapFilesError("folder-changed")).toBe("folderAgain");
    expect(mapFilesError("not-found")).toBe("rejected");
    expect(mapFilesError("too-large")).toBe("rejected");
    expect(mapFilesError("something-else")).toBe("rejected");
  });
});

describe("dataUrlToBytes", () => {
  it("decodes a base64 data URL", () => {
    // "hello" in base64.
    const bytes = dataUrlToBytes("data:model/gltf-binary;base64,aGVsbG8=");
    expect([...bytes]).toEqual([104, 101, 108, 108, 111]);
  });
});

describe("PR12 formats", () => {
  it("lists OBJ, STL and PLY beside GLB and glTF", () => {
    for (const name of ["a.obj", "b.STL", "c.Ply", "d.glb", "e.gltf"]) {
      expect(isImportableName(name)).toBe(true);
    }
    expect(isImportableName("a.mtl")).toBe(false);
    expect(isImportableName("a.fbx")).toBe(false);
    expect(isImportableName(".hidden.obj")).toBe(false);
  });

  it("maps every extension to a media type", () => {
    expect(contentTypeFor("a.obj")).toBe("model/obj");
    expect(contentTypeFor("a.STL")).toBe("model/stl");
    expect(contentTypeFor("a.ply")).toBe("application/octet-stream");
  });

  it("finds the first mtllib name, dropping any directory", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(objMtlName(enc("# c\nmtllib chair.mtl\nv 0 0 0\n"))).toBe("chair.mtl");
    expect(objMtlName(enc("mtllib sub\\dir/Chair Legs.mtl\r\n"))).toBe("Chair Legs.mtl");
    expect(objMtlName(enc("mtllib a.mtl\nmtllib b.mtl\n"))).toBe("a.mtl");
    expect(objMtlName(enc("v 0 0 0\n"))).toBeNull();
    expect(objMtlName(enc("mtllib \n"))).toBeNull();
  });

  it("matches the .mtl entry by name, then case-insensitively, .mtl only", () => {
    const entries = [
      { name: "Chair.MTL", path: "Chair.MTL", isDirectory: false },
      { name: "chair.png", path: "chair.png", isDirectory: false },
      { name: "sub", path: "sub", isDirectory: true },
    ];
    expect(findMtlEntry(entries, "Chair.MTL")?.path).toBe("Chair.MTL");
    expect(findMtlEntry(entries, "chair.mtl")?.path).toBe("Chair.MTL");
    expect(findMtlEntry(entries, "chair.png")).toBeNull();
    expect(findMtlEntry(entries, "other.mtl")).toBeNull();
  });

  it("encodes raw upload bytes (and sidecar bytes) as base64 text", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(bytesToBase64(bytes)).toBe("AAEC+v8=");
    const big = new Uint8Array(100_000).fill(7);
    expect(bytesToBase64(big)).toBe(btoa("\u0007".repeat(100_000)));
    const body = encodeUploadBytes({
      baseRevision: 1,
      upload: { filename: "a.obj", bytes, sidecars: [{ filename: "a.mtl", bytes }] },
    }) as { baseRevision: number; upload: { bytes: string; sidecars: Array<{ bytes: string }> } };
    expect(body.baseRevision).toBe(1);
    expect(body.upload.bytes).toBe("AAEC+v8=");
    expect(body.upload.sidecars[0].bytes).toBe("AAEC+v8=");
    const path = { backendPath: "/x.stl", baseRevision: 2 };
    expect(encodeUploadBytes(path)).toBe(path);
  });
});
