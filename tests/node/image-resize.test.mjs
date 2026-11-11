import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { ImageResizeError, inspectResizeSource, MAX_RESIZE_PIXELS, planImageResize, resizeImage } from "../../src/io/imageResize";

const chunk = (kind, data) => {
  const body = Buffer.concat([Buffer.from(kind), data]), out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
};
// Header-only dimensions for safety tests: native decode must never be reached.
function png(width, height, extras = [], depth = 8) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = 6;
  return Uint8Array.from(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...extras, chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]));
}
function exif(turn) {
  const data = Buffer.alloc(26); data.write("II"); data.writeUInt16LE(42, 2); data.writeUInt32LE(8, 4); data.writeUInt16LE(1, 8);
  data.writeUInt16LE(0x112, 10); data.writeUInt16LE(3, 12); data.writeUInt32LE(1, 14); data.writeUInt16LE(turn, 18);
  return data;
}
function jpeg(width, height, turn = 1) {
  const app = Buffer.concat([Buffer.from("Exif\0\0"), exif(turn)]), size = Buffer.alloc(2); size.writeUInt16BE(app.length + 2);
  const frame = Buffer.from([255, 192, 0, 11, 8, 0, 0, 0, 0, 1, 1, 17, 0]); frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  return Uint8Array.from(Buffer.concat([Buffer.from([255, 216, 255, 225]), size, app, frame, Buffer.from([255, 218, 0, 2])]));
}
afterEach(() => vi.unstubAllGlobals());

it("plans a bounded aspect-preserving downscale and never upscales", () => {
  expect(planImageResize(png(6000, 3000), 4096)).toEqual({ source: { format: "png", width: 6000, height: 3000 }, width: 4096, height: 2048 });
  expect(planImageResize(png(400, 200), 4096)).toMatchObject({ width: 400, height: 200 });
  expect(planImageResize(png(8192, 1), 512)).toMatchObject({ width: 512, height: 1 });
  expect(() => planImageResize(png(1, 1), 8192)).toThrow(ImageResizeError);
  expect(() => planImageResize(png(1, 1), 0)).toThrow(ImageResizeError);
});
it("reads JPEG and PNG EXIF orientation before showing original/result dimensions", () => {
  expect(inspectResizeSource(jpeg(6000, 3000, 6))).toEqual({ format: "jpeg", width: 3000, height: 6000 });
  expect(planImageResize(png(6000, 3000, [chunk("eXIf", exif(8))]), 4096)).toMatchObject({ width: 2048, height: 4096 });
});
it("refuses unsafe dimensions and malformed headers before invoking a pixel decoder", async () => {
  const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
  for (const data of [png(8193, 1), png(8000, 4001), png(0, 2), jpeg(9000, 20), png(1, 1).subarray(0, 33), png(1, 1, [chunk("acTL", Buffer.alloc(8))]), new Uint8Array([1, 2, 3])]) {
    await expect(resizeImage(data, 1024, "baseColorMap")).rejects.toBeInstanceOf(ImageResizeError);
  }
  const broken = png(1, 1); broken[16] ^= 1;
  await expect(resizeImage(broken, 1024, "baseColorMap")).rejects.toMatchObject({ code: "IMPORT_FORMAT" });
  expect(decode).not.toHaveBeenCalled();
  expect(MAX_RESIZE_PIXELS).toBe(32_000_000);
});
it("cancels before decode and closes a bitmap that finishes after cancellation", async () => {
  const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
  const controller = new AbortController(); controller.abort();
  await expect(resizeImage(png(1, 1), 512, "normalMap", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(decode).not.toHaveBeenCalled();
  const close = vi.fn(); let live = true;
  decode.mockImplementation(async () => { live = false; return { width: 1, height: 1, close }; });
  await expect(resizeImage(png(1, 1), 512, "normalMap", undefined, () => live)).rejects.toMatchObject({ name: "AbortError" });
  expect(close).toHaveBeenCalledOnce();
});

it("names native decode/canvas refusals and releases a decoded bitmap on canvas failure", async () => {
  vi.stubGlobal("createImageBitmap", vi.fn().mockRejectedValue(new Error("native decoder failed")));
  await expect(resizeImage(png(1, 1), 512, "baseColorMap")).rejects.toMatchObject({ code: "IMPORT_FORMAT" });
  const close = vi.fn();
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1, height: 1, close }));
  vi.stubGlobal("document", { createElement: () => { throw new Error("no canvas"); } });
  await expect(resizeImage(png(1, 1), 512, "baseColorMap")).rejects.toMatchObject({ code: "IMPORT_FORMAT" });
  expect(close).toHaveBeenCalledOnce();
});


it("refuses 16-bit data-map precision loss before decode", async () => {
  const decode = vi.fn(); vi.stubGlobal("createImageBitmap", decode);
  await expect(resizeImage(png(1, 1, [], 16), 512, "normalMap")).rejects.toMatchObject({ code: "IMPORT_FORMAT", message: expect.stringContaining("16-bit data-map precision") });
  await expect(resizeImage(png(1, 1, [], 16), 512, "metallicRoughnessMap")).rejects.toMatchObject({ code: "IMPORT_FORMAT" });
  expect(decode).not.toHaveBeenCalled();
});
