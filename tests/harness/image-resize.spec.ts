import { expect, test } from "@playwright/test";
import { crc32 } from "node:zlib";
import type { Page } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

async function openPicker(page: Page) {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /Box/ }).first().click();
  const maps = route.getByRole("group", { name: "Maps" });
  await maps.getByRole("button", { name: "Choose picture image" }).click();
  return page.getByRole("dialog", { name: "Choose an image" });
}
async function sourcePng(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].forEach((colour, i) => { ctx.fillStyle = colour; ctx.fillRect(i % 2 * 512, Math.floor(i / 2) * 256, 512, 256); });
    const base64 = canvas.toDataURL("image/png").split(",")[1]; canvas.width = canvas.height = 0;
    return base64;
  });
}
const posts = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => r.path.endsWith("/images")));

test("explicit review and cancel write nothing; Apply sends one aspect-preserving PNG", async ({ page }) => {
  const picker = await openPicker(page), source = await sourcePng(page);
  await picker.getByLabel("Resize uploaded image").selectOption("512");
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(source, "base64") });
  const review = picker.getByRole("group", { name: "Resize review" });
  await expect(review).toContainText("1024 × 512 → 512 × 256");
  await expect(review).toContainText("Colour picture (sRGB)");
  expect(await posts(page)).toHaveLength(0);
  await review.getByRole("button", { name: "Cancel resize" }).click();
  await expect(review).toHaveCount(0); expect(await posts(page)).toHaveLength(0);
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(source, "base64") });
  await review.getByRole("button", { name: "Resize and use image" }).click();
  await expect(picker).toHaveCount(0);
  const requests = await posts(page); expect(requests).toHaveLength(1);
  const body = requests[0].opts.body;
  expect(body).toMatchObject({ slot: "baseColorMap", upload: { filename: "wide-512x256.png", contentType: "image/png" } });
  const data = Buffer.from(body.upload.bytes, "base64");
  expect([data.readUInt32BE(16), data.readUInt32BE(20)]).toEqual([512, 256]);
});

test("unsafe decoded dimensions refuse before any bitmap allocation", async ({ page }) => {
  const picker = await openPicker(page), bytes = Buffer.from(await sourcePng(page), "base64");
  bytes.writeUInt32BE(9000, 16); bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  await page.evaluate(() => { (window as any).__bitmapCalls = 0; const original = window.createImageBitmap; window.createImageBitmap = ((...args: any[]) => { (window as any).__bitmapCalls++; return (original as any)(...args); }) as any; });
  await picker.getByLabel("Resize uploaded image").selectOption("512");
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "unsafe.png", mimeType: "image/png", buffer: bytes });
  await expect(picker.getByRole("alert")).toContainText("8192 pixels");
  expect(await page.evaluate(() => (window as any).__bitmapCalls)).toBe(0);
  expect(await posts(page)).toHaveLength(0);
});

test("cancelling a late decoder closes its bitmap and never uploads stale output", async ({ page }) => {
  const picker = await openPicker(page), source = await sourcePng(page);
  await picker.getByLabel("Resize uploaded image").selectOption("512");
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(source, "base64") });
  await page.evaluate(() => {
    const original = window.createImageBitmap; (window as any).__closed = 0;
    window.createImageBitmap = (async (...args: any[]) => {
      const bitmap = await (original as any)(...args), close = bitmap.close.bind(bitmap);
      bitmap.close = () => { (window as any).__closed++; close(); };
      return new Promise((resolve) => { (window as any).__releaseBitmap = () => resolve(bitmap); });
    }) as any;
  });
  await picker.getByRole("button", { name: "Resize and use image" }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseBitmap)).toBe("function");
  await picker.getByRole("button", { name: "Cancel resize" }).click();
  await page.evaluate(() => (window as any).__releaseBitmap());
  await expect.poll(() => page.evaluate(() => (window as any).__closed)).toBe(1);
  expect(await posts(page)).toHaveLength(0);
  await expect(picker.getByRole("group", { name: "Resize review" })).toHaveCount(0);
});

test("browser resize retains asymmetric orientation and data values, and normalizes bump directions", async ({ page }) => {
  await page.goto("/tests/harness/mock-host.html");
  const result = await page.evaluate(async () => {
    const { resizeImage } = await import("/src/io/imageResize.ts");
    const source = document.createElement("canvas"); source.width = 1024; source.height = 512;
    const ctx = source.getContext("2d")!;
    ["#ff0000", "#00ff00", "#0000ff", "#ffff00"].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(i % 2 * 512, Math.floor(i / 2) * 256, 512, 256); });
    const bytes = () => Uint8Array.from(atob(source.toDataURL("image/png").split(",")[1]), (c) => c.charCodeAt(0));
    const pixels = async (input: Uint8Array, side: number, slot: any) => {
      const output = await resizeImage(input, side, slot), bitmap = await createImageBitmap(new Blob([output.bytes]));
      const target = document.createElement("canvas"); target.width = bitmap.width; target.height = bitmap.height;
      target.getContext("2d")!.drawImage(bitmap, 0, 0); bitmap.close();
      const data = Array.from(target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data);
      target.width = target.height = 0; return { data, plan: output.plan };
    };
    const colour = await pixels(bytes(), 512, "baseColorMap");
    const corners = [[10, 10], [501, 10], [10, 245], [501, 245]].map(([x, y]) => colour.data.slice((y * 512 + x) * 4, (y * 512 + x) * 4 + 4));
    // Native JPEG EXIF rotation is baked into the resized PNG, not stretched.
    const jpeg = Uint8Array.from(atob(source.toDataURL("image/jpeg", 1).split(",")[1]), (c) => c.charCodeAt(0));
    const app = new Uint8Array(36), view = new DataView(app.buffer);
    app.set([255, 225, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73]);
    view.setUint16(12, 42, true); view.setUint32(14, 8, true); view.setUint16(18, 1, true);
    view.setUint16(20, 0x112, true); view.setUint16(22, 3, true); view.setUint32(24, 1, true); view.setUint16(28, 6, true);
    const tagged = new Uint8Array(jpeg.length + app.length); tagged.set(jpeg.subarray(0, 2)); tagged.set(app, 2); tagged.set(jpeg.subarray(2), 2 + app.length);
    const portrait = await pixels(tagged, 512, "baseColorMap");
    const portraitCorners = [[10, 10], [245, 10], [10, 501], [245, 501]].map(([x, y]) => portrait.data.slice((y * 256 + x) * 4, (y * 256 + x) * 4 + 4));
    ctx.fillStyle = "rgb(32, 64, 96)"; ctx.fillRect(0, 0, 1024, 512);
    const data = await pixels(bytes(), 4, "metallicRoughnessMap");
    ctx.fillStyle = "rgb(128, 128, 192)"; ctx.fillRect(0, 0, 1024, 512);
    const normal = await pixels(bytes(), 4, "normalMap");
    ctx.clearRect(0, 0, 1024, 512); ctx.fillStyle = "rgba(32, 64, 96, .5)"; ctx.fillRect(0, 0, 1024, 512);
    let refused = ""; try { await resizeImage(bytes(), 4, "metallicRoughnessMap"); } catch (e) { refused = (e as Error).message; }
    source.width = source.height = 0;
    return { corners, portraitCorners, portraitPlan: portrait.plan, data, normal, refused };
  });
  expect(result.corners).toEqual([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 0, 255]]);
  expect(result.portraitPlan).toMatchObject({ width: 256, height: 512 });
  for (const [i, expected] of [[0, [0, 0, 255]], [1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]]] as const) for (let k = 0; k < 3; k++) expect(Math.abs(result.portraitCorners[i][k] - expected[k])).toBeLessThanOrEqual(3);
  expect(result.data.data.slice(0, 4)).toEqual([32, 64, 96, 255]);
  const n = result.normal.data.slice(0, 3).map((v) => v / 127.5 - 1);
  expect(Math.hypot(...n)).toBeCloseTo(1, 2);
  expect(result.refused).toContain("opaque data map");
});

test("Cancel remains available during local processing but is disabled after the Apply request is sent", async ({ page }) => {
  const picker = await openPicker(page), source = await sourcePng(page);
  await picker.getByLabel("Resize uploaded image").selectOption("512");
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(source, "base64") });
  await page.evaluate(() => (window.__plastis3dMock as any).__delayNextRest(1500, "/images"));
  await picker.getByRole("button", { name: "Resize and use image" }).click();
  await expect(picker.getByRole("status")).toHaveText("Saving resized image…");
  await expect(picker.getByRole("button", { name: "Cancel resize" })).toBeDisabled();
  await expect(picker).toHaveCount(0);
  expect(await posts(page)).toHaveLength(1);
});


test("an own scene-change event before the image reply does not strand the successful picker", async ({ page }) => {
  const picker = await openPicker(page), source = await sourcePng(page);
  await picker.getByLabel("Resize uploaded image").selectOption("512");
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(source, "base64") });
  await page.evaluate(() => (window.__plastis3dMock as any).__delayNextImageReply(1500));
  await picker.getByRole("button", { name: "Resize and use image" }).click();
  await expect(picker.getByRole("status")).toHaveText("Saving resized image…");
  await expect(picker).toHaveCount(0);
  expect(await posts(page)).toHaveLength(1);
});

test("unsupported local filenames are refused before reading their contents", async ({ page }) => {
  const picker = await openPicker(page);
  await page.evaluate(() => {
    (window as any).__localFileReads = 0;
    const original = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () { (window as any).__localFileReads++; return original.call(this); };
  });
  await picker.getByLabel("Choose image from this computer").setInputFiles({ name: "auth.json", mimeType: "application/json", buffer: Buffer.from("owned test fixture") });
  await expect(picker.getByRole("alert")).toContainText("PNG");
  expect(await page.evaluate(() => (window as any).__localFileReads)).toBe(0);
  expect(await posts(page)).toHaveLength(0);
});
