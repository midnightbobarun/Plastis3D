// tests/node/api-asset-bytes.test.ts — getAssetBytes base64 decode (Tier 2, PR7).
//
// Covers src/api.ts getAssetBytes against the D1 contract: the gateway
// returns { ok, sha256, size, bytes: "<base64>" } and the wrapper
// decodes it to an ArrayBuffer. The fixture test round-trips the real
// checked-in GLB (tests/fixtures/two-primitive.glb) through the
// envelope, so the decode is proven on bytes GLTFLoader actually
// parses (the loader half is the Tier 3 oracle test).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApiError, getAssetBytes } from "../../src/api";
import type { RestFn } from "../../src/api";

const FIXTURE_SHA256 =
  "ba710c41bffcdee203548ba1f24160bd20c6a873f79e4df23f37924937812acd";

function restReturning(payload: unknown): RestFn {
  return (async () => payload) as RestFn;
}

/** Base64-encode bytes (btoa needs a binary string; chunked for size). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

describe("getAssetBytes", () => {
  it("decodes a valid base64 envelope to the exact bytes", async () => {
    const rest = restReturning({
      ok: true,
      sha256: "abc123",
      size: 5,
      bytes: "aGVsbG8=",
    });
    const buffer = await getAssetBytes(rest, "abc123");
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
  });

  it("round-trips the checked-in two-primitive GLB fixture", async () => {
    const fixturePath = fileURLToPath(
      new URL("../fixtures/two-primitive.glb", import.meta.url),
    );
    const fileBytes = readFileSync(fixturePath);
    const base64 = uint8ToBase64(fileBytes);
    const rest = restReturning({
      ok: true,
      sha256: FIXTURE_SHA256,
      size: fileBytes.length,
      bytes: base64,
    });
    const buffer = await getAssetBytes(rest, FIXTURE_SHA256);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array(fileBytes));
  });

  it("passes a resolved ArrayBuffer through (pre-PR7 shape)", async () => {
    const raw = new Uint8Array([1, 2, 3]).buffer;
    const rest = restReturning(raw);
    await expect(getAssetBytes(rest, "abc123")).resolves.toBe(raw);
  });

  it("maps ok:false to an ApiError carrying the gateway code", async () => {
    const rest = restReturning({
      ok: false,
      code: "ASSET_NOT_FOUND",
      message: "ASSET_NOT_FOUND no asset with sha256 \"abc123\"",
    });
    const error = await getAssetBytes(rest, "abc123").catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ASSET_NOT_FOUND");
  });

  it("passes a 413 oversize code through untouched (D3 pending)", async () => {
    const rest = restReturning({
      ok: false,
      code: "IMPORT_TOO_LARGE",
      message: "IMPORT_TOO_LARGE asset too large for the base64 response",
    });
    const error = await getAssetBytes(rest, "abc123").catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("IMPORT_TOO_LARGE");
  });

  it("rejects a non-object payload with BAD_RESPONSE", async () => {
    for (const payload of ["nope", 42, null, undefined]) {
      const error = await getAssetBytes(restReturning(payload), "abc123").catch(
        (err) => err,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("BAD_RESPONSE");
    }
  });

  it("rejects a missing or non-string bytes field with BAD_RESPONSE", async () => {
    for (const payload of [
      { ok: true, sha256: "abc123", size: 0 },
      { ok: true, sha256: "abc123", size: 3, bytes: 123 },
      { ok: true, sha256: "abc123", size: 3, bytes: null },
    ]) {
      const error = await getAssetBytes(restReturning(payload), "abc123").catch(
        (err) => err,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("BAD_RESPONSE");
    }
  });

  it("rejects invalid base64 with BAD_RESPONSE", async () => {
    const rest = restReturning({
      ok: true,
      sha256: "abc123",
      size: 4,
      bytes: "!!!not-base64!!!",
    });
    const error = await getAssetBytes(rest, "abc123").catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("BAD_RESPONSE");
  });

  it("rejects a sha256 echo that names a different asset", async () => {
    const rest = restReturning({
      ok: true,
      sha256: "different",
      size: 5,
      bytes: "aGVsbG8=",
    });
    const error = await getAssetBytes(rest, "abc123").catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("BAD_RESPONSE");
  });

  it("rejects a size that disagrees with the decoded length", async () => {
    const rest = restReturning({
      ok: true,
      sha256: "abc123",
      size: 99,
      bytes: "aGVsbG8=",
    });
    const error = await getAssetBytes(rest, "abc123").catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("BAD_RESPONSE");
  });
});
