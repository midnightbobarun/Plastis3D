import { expect, test } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

type Mock = {
  __requestCapture: (scene: string, revision: number) => string;
  __captureResults: () => Array<{ id: string; surface: string; revision: number; png: string }>;
  __rest: (path: string, opts?: unknown) => Promise<any>;
};

// PR22 (C-10): a visible editor surface claims a screenshot request for the
// scene it shows, draws its own canvas and posts a PNG; a request for another
// scene, or one already claimed by someone else, is left alone.
test("the editor answers a screenshot request for its scene with a PNG", async ({ page }) => {
  await gotoEditor(page);
  const rev = await page.evaluate(() => window.__plastis3dViewportEditor?.sceneRev as number);
  const id = await page.evaluate(([r]) => (window.__plastis3dMock as unknown as Mock).__requestCapture("demo-scene", r as number), [rev]);
  await expect.poll(() => page.evaluate(() => (window.__plastis3dMock as unknown as Mock).__captureResults().length), { timeout: 15000 }).toBe(1);
  const result = await page.evaluate(() => (window.__plastis3dMock as unknown as Mock).__captureResults()[0]);
  expect(result.id).toBe(id);
  expect(result.revision).toBe(rev);
  const bytes = Buffer.from(result.png, "base64");
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(16);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(16);
  expect(bytes.subarray(-8).toString("hex")).toBe("49454e44ae426082");
  // It decodes, is opaque and shows the scene (more than one colour), not a blank frame.
  const stats = await page.evaluate(async (b64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${b64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colours = new Set<number>();
    let transparent = 0;
    for (let i = 0; i < data.length; i += 4) { if (data[i + 3] < 255) transparent++; colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]); }
    return { colours: colours.size, transparent };
  }, result.png);
  expect(stats.transparent).toBe(0);
  expect(stats.colours).toBeGreaterThan(8);
});

test("a request for a scene no surface shows is not answered", async ({ page }) => {
  await gotoEditor(page);
  await page.evaluate(() => (window.__plastis3dMock as unknown as Mock).__requestCapture("some-other-scene", 1));
  await page.waitForTimeout(5000);
  expect(await page.evaluate(() => (window.__plastis3dMock as unknown as Mock).__captureResults().length)).toBe(0);
});

test("a request another surface already claimed is not answered", async ({ page }) => {
  await gotoEditor(page);
  const rev = await page.evaluate(() => window.__plastis3dViewportEditor?.sceneRev as number);
  const id = await page.evaluate(async ([r]) => {
    const mock = window.__plastis3dMock as unknown as Mock;
    const made = mock.__requestCapture("demo-scene", r as number);
    await mock.__rest(`/captures/${made}/claim`, { method: "POST", body: { surface: "someone-else" } });
    return made;
  }, [rev]);
  await page.waitForTimeout(5000);
  const results = await page.evaluate(() => (window.__plastis3dMock as unknown as Mock).__captureResults());
  expect(results.filter((r) => r.id === id)).toHaveLength(0);
});
